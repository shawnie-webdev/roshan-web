const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const projectsDir = path.join(publicDir, 'projects');
const consolePage = path.join(publicDir, 'console', 'index.html');

// These limits protect the Render web service from accidental runaway runs.
const MAX_RUNTIME_MS = 2 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const START_COOLDOWN_MS = 3000;
const MAX_STDIN_BYTES = 8 * 1024;
const MAX_STDIN_TOTAL_BYTES = 64 * 1024;
const MAX_CONCURRENT_RUNS = 2;
const activeRuns = new Map();
const lastRunAt = new Map();

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

function sendErrorPage(res, status, endpoint = res.req?.originalUrl || 'unknown') {
    const messages = {
        400: 'The request is invalid.',
        404: 'The requested file or project was not found.',
        409: 'This project cannot be loaded in the requested view.',
        415: 'This project type is not supported by this endpoint.',
        500: 'An internal server error occurred.'
    };
    const title = messages[status] || 'An error occurred.';
    return res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error ${status}</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:48rem;margin:auto">
<h1>HTTP ${status}</h1><p>${escapeHtml(title)}</p><p>Endpoint: <code>${escapeHtml(endpoint)}</code></p>
<a href="/">Return home</a></body></html>`);
}

function safeProjectId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
}

function getProject(projectId) {
    if (!safeProjectId(projectId)) return null;

    const projectDir = path.resolve(projectsDir, projectId);
    if (!projectDir.startsWith(projectsDir + path.sep)) return null;

    const metadataPath = path.join(projectDir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) return null;

    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const main = typeof metadata.main === 'string' ? metadata.main : null;
        if (!main || path.isAbsolute(main) || main.split(/[\\/]/).includes('..')) return null;

        const mainPath = path.resolve(projectDir, main);
        if (!mainPath.startsWith(projectDir + path.sep) || !fs.existsSync(mainPath)) return null;

        return {
            id: projectId,
            name: metadata.name || projectId,
            desc: metadata.desc || '',
            'exec-type': metadata['exec-type'] || 'console',
            'run-script': typeof metadata['run-script'] === 'string' ? metadata['run-script'].trim() : '',
            main,
            projectDir,
            mainPath
        };
    } catch (error) {
        console.error(`[project]${projectId}: invalid metadata.json`, error.message);
        return null;
    }
}

function listProjects() {
    if (!fs.existsSync(projectsDir)) return [];

    return fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => getProject(entry.name))
        .filter(Boolean)
        .map(({ id, name, desc, 'exec-type': execType, main }) => ({
            id, name, desc, 'exec-type': execType, main
        }));
}

function loadProject(req, res, next) {
    const project = getProject(req.params.project);
    if (!project) return sendErrorPage(res, 404, req.originalUrl);
    req.project = project;
    next();
}

function sendSocket(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function signalProcess(child, signal) {
    if (!child || !child.pid) return;
    try {
        // detached=true gives the run its own process group on Render/Linux.
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
    } catch (error) {
        if (error.code !== 'ESRCH') {
            try { child.kill(signal); } catch (_) {}
        }
    }
}

function stopRun(run, reason = 'Stopped') {
    if (!run || run.stopping || run.exited) return;
    run.stopping = true;
    sendSocket(run.ws, { type: 'status', status: reason });
    signalProcess(run.child, 'SIGTERM');
    run.forceKillTimer = setTimeout(() => {
        if (!run.exited) signalProcess(run.child, 'SIGKILL');
    }, 1500);
    run.forceKillTimer.unref?.();
}

function startProjectRun(project, ws) {
    if (!project['run-script']) {
        sendSocket(ws, { type: 'error', message: 'This project has no run-script configured in metadata.json.' });
        return;
    }

    const existing = activeRuns.get(project.id);
    if (existing && !existing.exited) {
        sendSocket(ws, { type: 'error', message: 'This project is already running in another console session.' });
        return;
    }

    if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
        sendSocket(ws, { type: 'error', message: 'The server is already running the maximum number of projects. Try again shortly.' });
        return;
    }

    const now = Date.now();
    const last = lastRunAt.get(project.id) || 0;
    if (now - last < START_COOLDOWN_MS) {
        sendSocket(ws, { type: 'error', message: 'Please wait a moment before starting this project again.' });
        return;
    }
    lastRunAt.set(project.id, now);

    let child;
    try {
        // run-script is trusted project-owner configuration, never client input.
        // The shell is started in the project directory so relative paths work.
        // Do not pass the website's secrets/environment variables into the child.
        child = spawn('/bin/sh', ['-lc', project['run-script']], {
            cwd: project.projectDir,
            env: {
                PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                HOME: project.projectDir,
                TMPDIR: '/tmp',
                LANG: 'C.UTF-8'
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        });
    } catch (error) {
        sendSocket(ws, { type: 'error', message: 'Could not start project: ' + error.message });
        return;
    }

    const run = {
        projectId: project.id,
        ws,
        child,
        outputBytes: 0,
        stdinBytes: 0,
        exited: false,
        stopping: false,
        runtimeTimer: null,
        forceKillTimer: null
    };
    activeRuns.set(project.id, run);

    const emitOutput = (type, chunk) => {
        if (run.exited || run.stopping) return;
        const data = chunk.toString('utf8');
        run.outputBytes += Buffer.byteLength(data, 'utf8');
        if (run.outputBytes > MAX_OUTPUT_BYTES) {
            sendSocket(ws, { type: 'error', message: 'Output limit reached (1 MB). The process was stopped.' });
            stopRun(run, 'Output limit reached');
            return;
        }
        sendSocket(ws, { type, data });
    };

    child.stdout.on('data', chunk => emitOutput('stdout', chunk));
    child.stderr.on('data', chunk => emitOutput('stderr', chunk));
    child.on('error', error => {
        sendSocket(ws, { type: 'error', message: 'Process error: ' + error.message });
    });

    run.runtimeTimer = setTimeout(() => stopRun(run, 'Runtime limit reached (2 minutes)'), MAX_RUNTIME_MS);
    run.runtimeTimer.unref?.();

    child.on('close', (code, signal) => {
        run.exited = true;
        clearTimeout(run.runtimeTimer);
        clearTimeout(run.forceKillTimer);
        if (activeRuns.get(project.id) === run) activeRuns.delete(project.id);
        sendSocket(ws, { type: 'exit', code, signal });
    });

    sendSocket(ws, {
        type: 'started',
        project: project.name,
        command: project['run-script'],
        cwd: path.relative(__dirname, project.projectDir)
    });
}

const wss = new WebSocketServer({
    server,
    path: '/ws/console',
    maxPayload: MAX_STDIN_BYTES + 1024
});

wss.on('connection', (ws, request) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const project = getProject(requestUrl.searchParams.get('project') || '');

    if (!project || project['exec-type'] !== 'console') {
        ws.close(1008, 'A valid console project is required');
        return;
    }

    sendSocket(ws, {
        type: 'ready',
        project: project.name,
        hasRunScript: Boolean(project['run-script'])
    });

    ws.on('message', (raw) => {
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch (_) {
            sendSocket(ws, { type: 'error', message: 'Invalid terminal message.' });
            return;
        }

        if (!message || typeof message.type !== 'string') return;

        if (message.type === 'start') {
            startProjectRun(project, ws);
            return;
        }

        const run = activeRuns.get(project.id);
        if (!run || run.ws !== ws || run.exited) {
            sendSocket(ws, { type: 'error', message: 'There is no active process in this terminal.' });
            return;
        }

        if (message.type === 'stdin') {
            if (typeof message.data !== 'string' || Buffer.byteLength(message.data, 'utf8') > MAX_STDIN_BYTES) {
                sendSocket(ws, { type: 'error', message: 'Input is too large or invalid.' });
                return;
            }
            const inputBytes = Buffer.byteLength(message.data, 'utf8');
            if (run.stdinBytes + inputBytes > MAX_STDIN_TOTAL_BYTES) {
                sendSocket(ws, { type: 'error', message: 'Input limit reached (64 KB for this run).' });
                return;
            }
            run.stdinBytes += inputBytes;
            if (!run.child.stdin.destroyed && run.child.stdin.writable) {
                run.child.stdin.write(message.data);
            }
            return;
        }

        if (message.type === 'stop') {
            stopRun(run, 'Stopped by user');
        }
    });

    ws.on('close', () => {
        const run = activeRuns.get(project.id);
        if (run && run.ws === ws) stopRun(run, 'Terminal disconnected');
    });
    ws.on('error', error => console.error('[console websocket]', error.message));
});

// Static assets are served from /public.
app.use(express.static(publicDir));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'homepage', 'index.html'));
});

app.get(['/api/projects', '/api/project/info'], (req, res) => {
    if (!req.query.project) return res.json(listProjects());

    const project = getProject(String(req.query.project));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { id, name, desc, 'exec-type': execType, 'run-script': runScript, main } = project;
    return res.json({ id, name, desc, 'exec-type': execType, 'run-script': runScript, main });
});

// Retained for source preview/inspection. Running is handled by the WebSocket terminal.
app.get('/api/project/console', (req, res) => {
    const project = getProject(String(req.query.project || ''));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project['exec-type'] !== 'console') {
        return res.status(415).json({ error: 'This project is not a console project' });
    }

    try {
        return res.json({
            id: project.id,
            name: project.name,
            desc: project.desc,
            main: project.main,
            source: fs.readFileSync(project.mainPath, 'utf8')
        });
    } catch (error) {
        console.error('[console] Unable to read project source:', error);
        return res.status(500).json({ error: 'Unable to load project source' });
    }
});

app.get(['/project/:project', '/console/:project'], loadProject, (req, res) => {
    const project = req.project;

    if (project['exec-type'] === 'html') {
        return res.sendFile(project.mainPath, error => {
            if (error && !res.headersSent) sendErrorPage(res, 500, req.originalUrl);
        });
    }

    if (project['exec-type'] === 'console') {
        return res.sendFile(consolePage, error => {
            if (error && !res.headersSent) sendErrorPage(res, 500, req.originalUrl);
        });
    }

    return sendErrorPage(res, 415, req.originalUrl);
});

app.use((req, res) => sendErrorPage(res, 404, req.originalUrl));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

function shutdown() {
    for (const run of activeRuns.values()) stopRun(run, 'Server shutting down');
    for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 25000).unref?.();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
