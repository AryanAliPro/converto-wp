require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { extractLovableZip } = require('./lib/extract');
const { buildViteProject } = require('./lib/build');
const { renderPages } = require('./lib/render');
const { convertHtmlToPhp } = require('./lib/llm');
const { packageTheme } = require('./lib/package');

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MAX_UPLOAD_BYTES || '', 10) || (200 * 1024 * 1024);
const DOWNLOAD_TOKEN_TTL_MS = Number.parseInt(process.env.DOWNLOAD_TOKEN_TTL_MS || '', 10) || (30 * 60 * 1000);
const allowedZipMimeTypes = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'multipart/x-zip',
]);
const generatedDownloads = new Map();
const publicDir = path.join(__dirname, 'public');

function removePathIfExists(targetPath) {
    if (!targetPath) {
        return;
    }

    try {
        fs.rmSync(targetPath, { force: true });
    } catch (error) {
        console.warn(`Cleanup warning for ${targetPath}:`, error.message);
    }
}

function scheduleGeneratedFileCleanup(token, delayMs = 0) {
    const cleanup = () => {
        const entry = generatedDownloads.get(token);
        generatedDownloads.delete(token);
        if (entry && entry.zipPath) {
            removePathIfExists(entry.zipPath);
        }
    };

    if (delayMs <= 0) {
        cleanup();
        return;
    }

    const timer = setTimeout(cleanup, delayMs);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
}

function createDownloadToken(zipPath, themeName) {
    const token = crypto.randomBytes(24).toString('hex');
    generatedDownloads.set(token, {
        zipPath,
        themeName,
        expiresAt: Date.now() + DOWNLOAD_TOKEN_TTL_MS,
    });
    return token;
}

function getDownloadEntry(token) {
    const entry = generatedDownloads.get(token);
    if (!entry) {
        return null;
    }

    if (entry.expiresAt <= Date.now()) {
        scheduleGeneratedFileCleanup(token);
        return null;
    }

    return entry;
}

const downloadCleanupTimer = setInterval(() => {
    for (const [token, entry] of generatedDownloads.entries()) {
        if (!entry || entry.expiresAt <= Date.now()) {
            scheduleGeneratedFileCleanup(token);
        }
    }
}, 5 * 60 * 1000);

if (typeof downloadCleanupTimer.unref === 'function') {
    downloadCleanupTimer.unref();
}

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
});

// Vercel ignores express.static(), so serve the shell page explicitly.
app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

for (const assetName of ['style.css', 'script.js']) {
    app.get(`/${assetName}`, (req, res) => {
        res.sendFile(path.join(publicDir, assetName));
    });
}

// Serve static files without browser caching (so UI updates are immediate)
app.use(express.static(publicDir, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  }
}));

// Setup multer for zip uploads
const upload = multer({
    dest: os.tmpdir(),
    limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
    },
    fileFilter: (req, file, cb) => {
        const originalName = String(file.originalname || '');
        const mimeType = String(file.mimetype || '').toLowerCase();
        const hasZipExtension = /\.zip$/i.test(originalName);
        const looksLikeZipMime = mimeType === '' || mimeType === 'application/octet-stream' || allowedZipMimeTypes.has(mimeType);

        if (hasZipExtension && looksLikeZipMime) {
            cb(null, true);
            return;
        }

        cb(new Error('Only .zip archives are allowed.'));
    },
});

// Global event emitter for SSE
const progressEmitter = new EventEmitter();

// SSE Endpoint
app.get('/events/:taskId', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const taskId = req.params.taskId;

    const onProgress = (data) => {
        if (data.taskId === taskId) {
            res.write(`data: ${JSON.stringify({ message: data.message, step: data.step, progress: data.progress })}\n\n`);
        }
    };

    const onError = (data) => {
        if (data.taskId === taskId) {
            res.write(`event: taskStatusError\ndata: ${JSON.stringify({ error: data.error })}\n\n`);
            res.end();
        }
    };

    const onComplete = (data) => {
        if (data.taskId === taskId) {
            res.write(`event: complete\ndata: ${JSON.stringify({ downloadToken: data.downloadToken, themeName: data.themeName })}\n\n`);
            res.end();
        }
    };

    progressEmitter.on('progress', onProgress);
    progressEmitter.on('taskStatusError', onError);
    progressEmitter.on('complete', onComplete);

    req.on('close', () => {
        progressEmitter.removeListener('progress', onProgress);
        progressEmitter.removeListener('taskStatusError', onError);
        progressEmitter.removeListener('complete', onComplete);
    });
});

/**
 * Handle Theme Download
 */
app.get('/download', (req, res) => {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const entry = getDownloadEntry(token);

    if (!entry || !entry.zipPath || !fs.existsSync(entry.zipPath)) {
        if (token) {
            scheduleGeneratedFileCleanup(token);
        }
        return res.status(404).send('File not found');
    }

    const filename = entry.themeName || path.basename(entry.zipPath);
    res.download(entry.zipPath, filename, (err) => {
        if (err) console.error("Download error:", err);
        scheduleGeneratedFileCleanup(token, 10000);
    });
});

/**
 * Handle ZIP Upload and Conversion Pipeline
 */
app.post('/upload', upload.single('lovable_zip'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send('No zip file uploaded.');
    }

    const taskId = Date.now().toString();
    const uploadedZipPath = req.file.path;
    const originalName = req.file.originalname;
    const platform = req.body.platform || 'Lovable'; // Default to Lovable if missing

    // Send immediate response with the task ID so the frontend can connect to SSE
    res.json({ taskId });

    // Helper to emit progress (Major Steps)
    const log = (step, message) => {
        console.log(`[Task ${taskId}] Step ${step}: ${message}`);
        progressEmitter.emit('progress', { taskId, step, message });
    };

    // Helper to emit detailed granular logs inside a step
    const logDetail = (message, progressPercent = null) => {
        console.log(`      -> ${message}`);
        progressEmitter.emit('progress', { taskId, step: -1, message, progress: progressPercent });
    };

    // Run the pipeline asynchronously
    (async () => {
        let projectPath;
        try {
            log(1, `Started extraction of ${originalName}...`);
            projectPath = await extractLovableZip(uploadedZipPath);
            logDetail(`Extracted to temporary workspace.`);

            log(2, `Installing dependencies and building Vite project...`);
            const buildPath = await buildViteProject(projectPath, logDetail);

            log(3, `Capturing fully rendered HTML for all routes...`);
            const pages = await renderPages(buildPath, projectPath, logDetail);
            if(pages.length === 0){
                throw new Error("No routes detected or parsed.");
            }

            log(4, `Converting rendered HTML into WordPress templates...`);
            const themeFiles = await convertHtmlToPhp(pages, platform, logDetail);

            log(5, `Packaging WordPress Theme...`);
            const themeZipPath = await packageTheme(themeFiles, buildPath, originalName, logDetail);
            const themeName = path.basename(themeZipPath);
            const downloadToken = createDownloadToken(themeZipPath, themeName);

            // Cleanup temp extracted dir
            fs.rmSync(projectPath, { recursive: true, force: true });
            removePathIfExists(uploadedZipPath);

            // Emit completion
            progressEmitter.emit('complete', { 
                taskId, 
                downloadToken,
                themeName,
            });

        } catch (error) {
            console.error(`Pipeline error for ${taskId}:`, error);
            progressEmitter.emit('taskStatusError', { taskId, error: error.message });
            if (projectPath && fs.existsSync(projectPath)) {
                fs.rmSync(projectPath, { recursive: true, force: true });
            }
            removePathIfExists(uploadedZipPath);
        }
    })();
});

app.use((error, req, res, next) => {
    if (req && req.file && req.file.path) {
        removePathIfExists(req.file.path);
    }

    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).send(`Uploaded ZIP is too large. Maximum allowed size is ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`);
        }

        return res.status(400).send('Upload failed. Please provide one valid ZIP export.');
    }

    if (error && error.message === 'Only .zip archives are allowed.') {
        return res.status(400).send(error.message);
    }

    return next(error);
});

app.use((error, req, res, next) => {
    console.error('Unhandled server error:', error);
    if (res.headersSent) {
        return next(error);
    }

    return res.status(500).send('Unexpected server error.');
});

module.exports = app;

app.listen(port, host, () => {
    console.log(`✅ Agent UI running at http://localhost:${port}`);
});
