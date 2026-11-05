const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const projectsDir = path.join(publicDir, 'projects');
const consolePage = path.join(publicDir, 'console', 'index.html');

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
            'run-script': metadata['run-script'] || null,
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

// Static assets are served from /public.
app.use(express.static(publicDir));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'homepage', 'index.html'));
});

// List all projects, or return one project's metadata when ?project=<id> is supplied.
app.get(['/api/projects', '/api/project/info'], (req, res) => {
    if (!req.query.project) return res.json(listProjects());

    const project = getProject(String(req.query.project));
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { id, name, desc, 'exec-type': execType, 'run-script': runScript, main } = project;
    return res.json({ id, name, desc, 'exec-type': execType, 'run-script': runScript, main });
});

// The console data endpoint only returns source for console-type projects.
// It deliberately does not execute run-script commands on the web server.
app.get('/api/project/console', (req, res) => {
    const projectId = String(req.query.project || '');
    const project = getProject(projectId);

    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project['exec-type'] !== 'console') {
        return res.status(415).json({
            error: 'This project is not a console project',
            'exec-type': project['exec-type'],
            url: `/project/${encodeURIComponent(project.id)}`
        });
    }

    try {
        const source = fs.readFileSync(project.mainPath, 'utf8');
        return res.json({
            id: project.id,
            name: project.name,
            desc: project.desc,
            main: project.main,
            source
        });
    } catch (error) {
        console.error('[console] Unable to read project source:', error);
        return res.status(500).json({ error: 'Unable to load project source' });
    }
});

// Project viewer: HTML projects are served as HTML; console projects use the console viewer.
app.get(['/project/:project', '/console/:project'], loadProject, (req, res) => {
    const project = req.project;

    if (project['exec-type'] === 'html') {
        return res.sendFile(project.mainPath, (error) => {
            if (error && !res.headersSent) sendErrorPage(res, 500, req.originalUrl);
        });
    }

    if (project['exec-type'] === 'console') {
        return res.sendFile(consolePage, (error) => {
            if (error && !res.headersSent) sendErrorPage(res, 500, req.originalUrl);
        });
    }

    return sendErrorPage(res, 415, req.originalUrl);
});

app.use((req, res) => sendErrorPage(res, 404, req.originalUrl));

app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
