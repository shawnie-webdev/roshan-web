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
const scriptsDir = path.join(publicDir, 'scripts');
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
        404: 'The requested file was not found.',
        409: 'This object cannot be loaded in the requested view.',
        415: 'This object type is not supported by this endpoint.',
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

function safeScriptId(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
}

function getScript(scriptId) {
    if (!safeScriptId(scriptId)) return null;

    const scriptDir = path.resolve(scriptsDir, scriptId);
    if (!scriptDir.startsWith(scriptsDir + path.sep)) return null;

    const metadataPath = path.join(scriptDir, 'metadata.json');
    if (!fs.existsSync(metadataPath)) return null;

    try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const main = typeof metadata.main === 'string' ? metadata.main : null;
        if (!main || path.isAbsolute(main) || main.split(/[\\/]/).includes('..')) return null;

        const mainPath = path.resolve(scriptDir, main);
        if (!mainPath.startsWith(scriptDir + path.sep) || !fs.existsSync(mainPath)) return null;

        return {
            id: scriptId,
            name: metadata.name || scriptId,
            desc: metadata.desc || '',
            'exec-type': metadata['exec-type'] || 'console',
            'run-script': typeof metadata['run-script'] === 'string' ? metadata['run-script'].trim() : '',
            main,
            scriptDir,
            mainPath
        };
    } catch (error) {
        console.error(`[script]${scriptId}: invalid metadata.json`, error.message);
        return null;
    }
}

function listScripts() {
    if (!fs.existsSync(scriptsDir)) return [];

    return fs.readdirSync(scriptsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => getScript(entry.name))
        .filter(Boolean)
        .map(({ id, name, desc, 'exec-type': execType, main }) => ({
            id, name, desc, 'exec-type': execType, main
        }));
}

function loadScript(req, res, next) {
    const script = getScript(req.params.script);
    if (!script) return sendErrorPage(res, 404, req.originalUrl);
    req.script = script;
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

function startScriptRun(script, ws) {
    if (!script['run-script']) {
        sendSocket(ws, { type: 'error', message: 'This script has no run-script configured in metadata.json.' });
        return;
    }

    const existing = activeRuns.get(script.id);
    if (existing && !existing.exited) {
        sendSocket(ws, { type: 'error', message: 'This script is already running in another console session.' });
        return;
    }

    if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
        sendSocket(ws, { type: 'error', message: 'The server is already running the maximum number of scripts. Try again shortly.' });
        return;
    }

    const now = Date.now();
    const last = lastRunAt.get(script.id) || 0;
    if (now - last < START_COOLDOWN_MS) {
        sendSocket(ws, { type: 'error', message: 'Please wait a moment before starting this script again.' });
        return;
    }
    lastRunAt.set(script.id, now);

    let child;
    try {
        // run-script is trusted script-owner configuration, never client input.
        // The shell is started in the script directory so relative paths work.
        // Do not pass the website's secrets/environment variables into the child.
        child = spawn('/bin/sh', ['-lc', script['run-script']], {
            cwd: script.scriptDir,
            env: {
                PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
                HOME: script.scriptDir,
                TMPDIR: '/tmp',
                LANG: 'C.UTF-8'
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: process.platform !== 'win32'
        });
    } catch (error) {
        sendSocket(ws, { type: 'error', message: 'Could not start script: ' + error.message });
        return;
    }

    const run = {
        scriptId: script.id,
        ws,
        child,
        outputBytes: 0,
        stdinBytes: 0,
        exited: false,
        stopping: false,
        runtimeTimer: null,
        forceKillTimer: null
    };
    activeRuns.set(script.id, run);

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
        if (activeRuns.get(script.id) === run) activeRuns.delete(script.id);
        sendSocket(ws, { type: 'exit', code, signal });
    });

    sendSocket(ws, {
        type: 'started',
        script: script.name,
        command: script['run-script'],
        cwd: path.relative(__dirname, script.scriptDir)
    });
}

const wss = new WebSocketServer({
    server,
    path: '/ws/console',
    maxPayload: MAX_STDIN_BYTES + 1024
});

wss.on('connection', (ws, request) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const script = getScript(requestUrl.searchParams.get('script') || '');

    if (!script || script['exec-type'] !== 'console') {
        ws.close(1008, 'A valid console script is required');
        return;
    }

    sendSocket(ws, {
        type: 'ready',
        script: script.name,
        hasRunScript: Boolean(script['run-script'])
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
            startScriptRun(script, ws);
            return;
        }

        const run = activeRuns.get(script.id);
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
        const run = activeRuns.get(script.id);
        if (run && run.ws === ws) stopRun(run, 'Terminal disconnected');
    });
    ws.on('error', error => console.error('[console websocket]', error.message));
});

// Static assets are served from /public.
app.use(express.static(publicDir));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'homepage', 'index.html'));
});

app.get(['/api/scripts', '/api/script/info'], (req, res) => {
    if (!req.query.script) return res.json(listScripts());

    const script = getScript(String(req.query.script));
    if (!script) return res.status(404).json({ error: 'Script not found' });

    const { id, name, desc, 'exec-type': execType, 'run-script': runScript, main } = script;
    return res.json({ id, name, desc, 'exec-type': execType, 'run-script': runScript, main });
});

// Retained for source preview/inspection. Running is handled by the WebSocket terminal.
app.get('/api/script/console', (req, res) => {
    const script = getScript(String(req.query.script || ''));
    if (!script) return res.status(404).json({ error: 'Script not found' });
    try {
        return res.json({
            id: script.id,
            name: script.name,
            desc: script.desc,
            main: script.main,
            source: fs.readFileSync(script.mainPath, 'utf8')
        });
    } catch (error) {
        console.error('[console] Unable to read script source:', error);
        return res.status(500).json({ error: 'Unable to load script source' });
    }
});

function sendScriptPage(req, res) {
    const script = req.script;

    if (script['exec-type'] === 'html') {
        return res.sendFile(script.mainPath, error => {
            if (error) {
                console.error('[script] Unable to send HTML script:', error.message);
                if (!res.headersSent) sendErrorPage(res, error.statusCode === 404 ? 404 : 500, req.originalUrl);
            }
        });
    }

    if (script['exec-type'] === 'console') {
        return res.sendFile(consolePage, error => {
            if (error) {
                console.error('[script] Unable to send console page:', error.message);
                if (!res.headersSent) sendErrorPage(res, 500, req.originalUrl);
            }
        });
    }

    return sendErrorPage(res, 415, req.originalUrl);
}

// The homepage's script links land here. Choose the correct page from metadata.
app.get('/script/:script', loadScript, sendScriptPage);

// Source viewer is separate from the runnable terminal and HTML script page.
app.get('/view/:script', loadScript, (req, res) => {
    return res.sendFile(path.join(publicDir, 'console', 'view.html'), error => {
        if (error) {
            console.error('[view] Unable to send source viewer:', error.message);
            if (!res.headersSent) sendErrorPage(res, 500, req.originalUrl);
        }
    });
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
