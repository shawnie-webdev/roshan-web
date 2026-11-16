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

app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));

// Small cookie parser; no additional session dependency is needed.
app.use((req, _res, next) => {
    req.cookies = {};
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        try { req.cookies[key] = decodeURIComponent(value); } catch (_) {}
    }
    next();
});

// --------------------------------------------------
// Homelab authentication and live telemetry
// --------------------------------------------------
const crypto = require('crypto');
const HOMELAB_ACCESS_PASSWORD = process.env.HOMELAB_ACCESS_PASSWORD || '';
const HOMELAB_AGENT_TOKEN = process.env.HOMELAB_AGENT_TOKEN || '';
const HOMELAB_COOKIE = 'homelab_session';
const HOMELAB_SESSION_MS = 8 * 60 * 60 * 1000;

const homelabState = {
    pi: {
        online: false, ssh_access: false, usb_gadget_setup: false,
        server2_connection: false, pi_kvm: false, pi_wousb: false,
        last_seen: null
    },
    pc: {
        online: false, anydesk_connected: false, wifi_access: false,
        battery_percent: null, last_seen: null
    },
    updated_at: null
};

let homelabAgentSocket = null;
const homelabLoginAttempts = new Map();

function safeEqualText(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function homelabSignature(expiry) {
    return crypto.createHmac('sha256', HOMELAB_ACCESS_PASSWORD)
        .update(String(expiry)).digest('hex');
}

function hasHomelabSession(req) {
    if (!HOMELAB_ACCESS_PASSWORD) return false;
    const value = req.cookies?.[HOMELAB_COOKIE];
    if (!value || typeof value !== 'string') return false;
    const [expiry, signature] = value.split('.');
    if (!/^\d+$/.test(expiry || '') || !signature) return false;
    if (Number(expiry) < Date.now()) return false;
    return safeEqualText(signature, homelabSignature(expiry));
}

function requireHomelab(req, res, next) {
    if (!hasHomelabSession(req)) {
        return res.status(401).json({ error: 'Homelab authentication required.' });
    }
    next();
}

app.post('/api/homelab/login', (req, res) => {
    if (!HOMELAB_ACCESS_PASSWORD) {
        return res.status(503).json({ error: 'HOMELAB_ACCESS_PASSWORD is not configured.' });
    }

    const address = req.ip || req.socket.remoteAddress || 'unknown';
    const attempt = homelabLoginAttempts.get(address) || { count: 0, until: 0 };
    if (attempt.until > Date.now() && attempt.count >= 8) {
        return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }

    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!safeEqualText(supplied, HOMELAB_ACCESS_PASSWORD)) {
        attempt.count += 1;
        if (attempt.count >= 8) attempt.until = Date.now() + 10 * 60 * 1000;
        homelabLoginAttempts.set(address, attempt);
        return res.status(401).json({ error: 'Incorrect password.' });
    }

    homelabLoginAttempts.delete(address);
    const expiry = String(Date.now() + HOMELAB_SESSION_MS);
    const value = expiry + '.' + homelabSignature(expiry);
    res.cookie(HOMELAB_COOKIE, value, {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'strict',
        path: '/',
        maxAge: HOMELAB_SESSION_MS
    });
    return res.json({ ok: true });
});

app.post('/api/homelab/logout', requireHomelab, (_req, res) => {
    res.clearCookie(HOMELAB_COOKIE, { httpOnly: true, secure: _req.secure, sameSite: 'strict', path: '/' });
    res.json({ ok: true });
});

app.get('/api/homelab/status', requireHomelab, (_req, res) => {
    const now = Date.now();
    const piFresh = homelabState.pi.last_seen && now - Date.parse(homelabState.pi.last_seen) < 20000;
    const pcFresh = homelabState.pc.last_seen && now - Date.parse(homelabState.pc.last_seen) < 20000;
    res.set('Cache-Control', 'no-store');
    res.json({
        ...homelabState,
        pi: { ...homelabState.pi, online: Boolean(piFresh && homelabState.pi.online) },
        pc: { ...homelabState.pc, online: Boolean(pcFresh && homelabState.pc.online) },
        server1_on: Boolean(piFresh && homelabState.pi.online),
        server2_on: Boolean(pcFresh && homelabState.pc.online),
        pi_kvm: homelabState.pi.pi_kvm,
        pi_wousb: homelabState.pi.pi_wousb
    });
});

const homelabWss = new WebSocketServer({ server, path: '/ws/homelab', maxPayload: 16384 });
homelabWss.on('connection', (ws) => {
    let authenticated = false;
    const authTimer = setTimeout(() => {
        if (!authenticated) ws.close(1008, 'Authentication required');
    }, 5000);

    ws.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); }
        catch (_) { ws.close(1007, 'Invalid JSON'); return; }

        if (!authenticated) {
            if (message.type !== 'authenticate' || !HOMELAB_AGENT_TOKEN ||
                !safeEqualText(message.token || '', HOMELAB_AGENT_TOKEN)) {
                ws.close(1008, 'Invalid agent credentials');
                return;
            }
            authenticated = true;
            clearTimeout(authTimer);
            if (homelabAgentSocket && homelabAgentSocket !== ws) {
                homelabAgentSocket.close(4001, 'Replaced by a newer Pi agent');
            }
            homelabAgentSocket = ws;
            ws.send(JSON.stringify({ type: 'authenticated' }));
            console.log('[homelab] Raspberry Pi agent authenticated');
            return;
        }

        if (message.type !== 'telemetry' || message.device !== 'pi') return;
        const now = new Date().toISOString();
        const pi = message.pi && typeof message.pi === 'object' ? message.pi : {};
        const pc = message.pc && typeof message.pc === 'object' ? message.pc : {};

        for (const key of ['ssh_access', 'usb_gadget_setup', 'server2_connection', 'pi_kvm', 'pi_wousb']) {
            if (typeof pi[key] === 'boolean') homelabState.pi[key] = pi[key];
        }
        homelabState.pi.online = true;
        homelabState.pi.last_seen = now;

        if (typeof pc.online === 'boolean') homelabState.pc.online = pc.online;
        if (typeof pc.anydesk_connected === 'boolean') homelabState.pc.anydesk_connected = pc.anydesk_connected;
        if (typeof pc.wifi_access === 'boolean') homelabState.pc.wifi_access = pc.wifi_access;
        if (pc.battery_percent === null || (Number.isFinite(pc.battery_percent) &&
            pc.battery_percent >= 0 && pc.battery_percent <= 100)) {
            homelabState.pc.battery_percent = pc.battery_percent;
        }
        if (pc.last_seen) homelabState.pc.last_seen = now;
        else if (pc.online) homelabState.pc.last_seen = now;
        homelabState.updated_at = now;
    });

    ws.on('close', () => {
        clearTimeout(authTimer);
        if (homelabAgentSocket === ws) {
            homelabAgentSocket = null;
            homelabState.pi.online = false;
            console.log('[homelab] Raspberry Pi agent disconnected');
        }
    });
    ws.on('error', error => console.error('[homelab websocket]', error.message));
});

app.get('/homelab', (_req, res) => {
    res.sendFile(path.join(publicDir, 'homelab', 'homelab-dashboard.html'));
});

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
