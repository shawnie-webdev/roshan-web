const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');

// --- Helper Functions ---

function getFoldersSync(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name);
}

function sendErrorPage(res, status, endpoint = res.req?.originalUrl || "unknown", err = null) {
    const info = {
        404: "The file/object was not found, either it was moved, renamed or deleted, or did not exist in the first place",
        401: "The action you are trying to do is unauthorized, the server does not know who you are, logging in might fix this",
        403: "The action you are trying to do is forbidden, you may not have enough permissions to do this",
        429: "You are sending too many requests to the server",
        500: "An error occurred inside the server while processing your request",
        502: "A proxy/gateway server got an invalid response from an upstream server",
        503: "The server might be temporarily overloaded or the service you are trying to use is unavailable"
    };

    const meaning = {
        404: "File/object not found",
        401: "Unauthorized",
        403: "Forbidden",
        429: "Too many requests",
        500: "Internal Server Error",
        502: "Bad Gateway",
        503: "Service temporarily unavailable"
    };

    res.status(status).type('html').send(`
        <!DOCTYPE html>
        <html>
            <head><title>Error ${status}</title></head>
            <body style="font-family: sans-serif; padding: 20px;">
                <h1>HTTP Status Code ${status} - ${meaning[status] || 'Error'}</h1>
                <h3>${info[status] || 'An error occurred.'}</h3>
                <p>More about this error:</p>
                <ul>
                    <li>Endpoint: ${endpoint}</li>
                </ul>
            </body>
        </html>
    `);
}

function sendFileOrError(res, endpoint, raw) {
    const filePath = path.join(publicDir, raw);
    console.log(`[server.js]: Sending file '${filePath}' for endpoint '${endpoint}'`);

    if (!fs.existsSync(filePath)) {
        return sendErrorPage(res, 404, endpoint, new Error(`File not found: ${filePath}`));
    }

    return res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) {
            return sendErrorPage(res, 500, endpoint, err);
        }

        if (!err) {
            console.log(`[server.js]: Served file for ${endpoint}`);
        }
    });
}

// --- VARIABLES FOR API --- //
let projects = []

// --- API SETUP CODE --- //
console.log("setting up API")
for (const project of getFoldersSync("public/projects")) {
    projects.push(project)
}

// --- Express Middleware & Routes ---
app.use(express.static(publicDir));

app.get('/', (req, res) => { sendFileOrError(res, '/', 'homepage/index.html') });


// API
app.get('/api/project/info', (req, res) => {
    const project = req.query.project

    if (project) {
        sendFileOrError(res, `/projects/${projects[project]}/metadata.json`, project);
    }
    res.json(projects)
});

app.use((req, res) => {
    sendErrorPage(res, 404, req.originalUrl);
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});