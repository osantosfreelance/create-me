'use strict';

/**
 * create-me — townhall photo booth server.
 *
 * Privacy design: this server is intentionally stateless by default.
 *  - No database; nothing is written to disk or a bucket, ever.
 *  - Request bodies (which contain image bytes) are never logged.
 *  - The Gemini API key lives only in process env and is never sent to the browser.
 *  - Images pass through memory for the lifetime of a single request only,
 *    UNLESS an attendee explicitly taps "Save" — that photo is then kept in
 *    a small in-memory ring buffer (max 5, oldest overwritten first; see
 *    server/storage.js) until an operator downloads it or the process restarts.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { generateImage } = require('./gemini');
const { validatePrompt, validateImage } = require('./guardrails');
const { savePhoto, findPhoto, listPhotosForSession, UUID_PATTERN } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers. CSP is scoped to this app's own same-origin assets since
// the frontend only ever talks to its own backend (Gemini calls happen
// server-side), plus camera access which browsers gate separately via
// Permissions Policy, not CSP.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Generated images (base64) can be a couple MB; allow a generous but bounded body size.
const MAX_BODY_SIZE = '15mb';
app.use(express.json({ limit: MAX_BODY_SIZE }));

function makeRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

app.use((req, res, next) => {
  const incoming = typeof req.get('x-client-request-id') === 'string' ? req.get('x-client-request-id').trim() : '';
  // Accept a simple client-provided id for correlation, otherwise issue one.
  req.requestId = /^[A-Za-z0-9._:-]{8,80}$/.test(incoming) ? incoming : makeRequestId();
  res.setHeader('x-request-id', req.requestId);
  next();
});

// Basic request logging that deliberately excludes body content.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `[${req.requestId}] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// Serve static files with no-cache for CSS/JS to ensure updates are fetched
app.use((req, res, next) => {
  if (req.path.match(/\.(css|js|html)$/i)) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rate limiting: /api/generate calls a paid API, so cap it tightly per-IP to
// contain both cost abuse and denial-of-service. A booth is normally used by
// one attendee at a time, so this ceiling is generous for real use but
// meaningfully blocks scripted abuse.
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

// A looser global limiter as a backstop against blunt-force traffic floods.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// Session code validation. Each valid code maps to an asset index, which selects the
// branding assets served to the browser (`public/<index>-photo-frame.png` and
// `public/<index>-watermark.png`). Assets that don't exist are simply skipped client-side.
const DEFAULT_SESSIONS = {
  'townhall-2k26': 1,
  'tech-fest-2k26': 2,
  'ai-experience-2k26': 3,
};

// SESSION_CODES overrides the defaults: a list of `code:index` pairs separated by
// commas or `|` (the `|` form is handy for tools like gcloud that treat commas as
// their own delimiter). The index is optional and falls back to the entry's position
// (1-based). Legacy SESSION_CODE (a single code) is still honoured when SESSION_CODES
// is unset.
function buildSessions() {
  const raw = process.env.SESSION_CODES || process.env.SESSION_CODE;
  if (!raw || !raw.trim()) return { ...DEFAULT_SESSIONS };

  const sessions = {};
  raw
    .split(/[,|]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, position) => {
      const sep = entry.lastIndexOf(':');
      const code = sep === -1 ? entry : entry.slice(0, sep).trim();
      const rawIndex = sep === -1 ? '' : entry.slice(sep + 1).trim();
      const parsedIndex = Number.parseInt(rawIndex, 10);
      if (!code) return;
      sessions[code] = Number.isInteger(parsedIndex) && parsedIndex > 0 ? parsedIndex : position + 1;
    });

  return Object.keys(sessions).length ? sessions : { ...DEFAULT_SESSIONS };
}

const SESSIONS = buildSessions();
console.log(`session codes configured: ${Object.keys(SESSIONS).length}`);

function resolveSession(req) {
  const sessionCode = req.get('x-session-code') || (req.body && req.body.sessionCode);
  const assetIndex = sessionCode ? SESSIONS[sessionCode] : undefined;
  return { sessionCode, valid: assetIndex !== undefined, assetIndex };
}

function sessionCodeMiddleware(req, res, next) {
  const { valid, sessionCode } = resolveSession(req);
  if (!valid) {
    console.warn(`[${req.requestId}] session-code validation failed: received "${sessionCode || 'none'}"`);
    return res.status(401).json({ error: 'Invalid or missing session code.' });
  }
  next();
}

// Validation endpoint for early feedback on session code
app.post('/api/validate-session', (req, res) => {
  const { valid, sessionCode, assetIndex } = resolveSession(req);
  if (!valid) {
    console.warn(`[${req.requestId}] session-code validation failed: received "${sessionCode || 'none'}"`);
    return res.status(401).json({ error: 'Invalid or missing session code.' });
  }
  res.json({ ok: true, assetIndex });
});

app.post('/api/generate', generateLimiter, sessionCodeMiddleware, async (req, res) => {
  const opStart = Date.now();
  try {
    const { imageBase64, mimeType, prompt } = req.body || {};
    const promptChars = typeof prompt === 'string' ? prompt.length : 0;
    const imageBytesApprox = typeof imageBase64 === 'string' ? Math.floor((imageBase64.length * 3) / 4) : 0;

    console.log(
      `[${req.requestId}] generate:start mime=${String(mimeType || '').toLowerCase() || 'unknown'} promptChars=${promptChars} imageBytesApprox=${imageBytesApprox}`
    );

    const imageCheck = validateImage(mimeType, imageBase64);
    if (!imageCheck.ok) {
      console.warn(`[${req.requestId}] generate:reject image validation failed: ${imageCheck.error}`);
      return res.status(400).json({ error: imageCheck.error });
    }

    const promptCheck = validatePrompt(prompt);
    if (!promptCheck.ok) {
      console.warn(`[${req.requestId}] generate:reject prompt validation failed: ${promptCheck.error}`);
      return res.status(400).json({ error: promptCheck.error });
    }

    if (!process.env.GEMINI_API_KEY) {
      console.error(`[${req.requestId}] generate:reject missing GEMINI_API_KEY`);
      return res.status(500).json({ error: 'Server is not configured with GEMINI_API_KEY.' });
    }

    const result = await generateImage({
      imageBase64,
      mimeType: mimeType.toLowerCase(),
      prompt: promptCheck.prompt,
      requestId: req.requestId,
    });

    const resultBytesApprox = Math.floor((result.imageBase64.length * 3) / 4);
    console.log(
      `[${req.requestId}] generate:success mime=${result.mimeType} imageBytesApprox=${resultBytesApprox} totalMs=${Date.now() - opStart}`
    );

    res.json(result);
  } catch (err) {
    // Never log err.request/response bodies here — they may contain image data.
    console.error(`[${req.requestId}] generate:failed`, err.message);
    const status = err.statusCode || 502;
    res.status(status).json({ error: err.publicMessage || 'Image generation failed. Please try again.' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.GEMINI_API_KEY) });
});

// Saving a photo is opt-in (attendee taps "Save") and rate-limited like
// /api/generate to bound memory usage from scripted abuse. Storage itself is
// a fixed-size in-memory ring buffer (see server/storage.js) capped at
// MAX_PHOTOS, so at most a handful of photos are ever held at once.
const saveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

app.post('/api/photos', saveLimiter, sessionCodeMiddleware, async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body || {};
    const { sessionCode } = resolveSession(req);

    const imageCheck = validateImage(mimeType, imageBase64);
    if (!imageCheck.ok) {
      console.warn(`[${req.requestId}] save:reject image validation failed: ${imageCheck.error}`);
      return res.status(400).json({ error: imageCheck.error });
    }

    const { id } = await savePhoto({ imageBase64, mimeType: mimeType.toLowerCase(), sessionCode });
    const host = req.get('host');
    const url = `${req.protocol}://${host}/${id}`;
    console.log(`[${req.requestId}] save:success id=${id}`);
    res.json({ id, url });
  } catch (err) {
    console.error(`[${req.requestId}] save:failed`, err.message);
    res.status(500).json({ error: 'Could not save photo. Please try again.' });
  }
});

// Operator portal: lists saved photos for the caller's session code.
app.get('/api/photos', sessionCodeMiddleware, async (req, res) => {
  try {
    const { sessionCode } = resolveSession(req);
    const photos = await listPhotosForSession(sessionCode);
    res.json({ photos });
  } catch (err) {
    console.error(`[${req.requestId}] list-photos:failed`, err.message);
    res.status(500).json({ error: 'Could not load saved photos.' });
  }
});

// QR/link target: serves a saved photo's raw image bytes directly (no HTML
// viewer page). Constrained to a strict UUID pattern and placed after the
// static/API routes above so it can never shadow them. Express wraps this
// pattern inside its own capture group, so the anchors (^...$) from
// UUID_PATTERN must be stripped here or the route never matches.
const UUID_ROUTE_PATTERN = UUID_PATTERN.source.replace(/^\^/, '').replace(/\$$/, '');
app.get(`/:uuid(${UUID_ROUTE_PATTERN})`, async (req, res) => {
  try {
    const photo = await findPhoto(req.params.uuid);
    if (!photo) {
      return res.status(404).send('Photo not found.');
    }
    // No caching: these photos can be overwritten (FIFO eviction) as soon
    // as newer ones are saved, so a stale cached copy would be misleading.
    res.set('Cache-Control', 'no-store');
    res.type(photo.mimeType).send(photo.buffer);
  } catch (err) {
    console.error(`[${req.requestId}] photo-fetch:failed`, err.message);
    res.status(500).send('Could not load photo.');
  }
});

const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');
const hasTlsCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);
const isDocker = fs.existsSync('/.dockerenv') || process.env.container === 'docker';
const protocol = hasTlsCerts ? 'https' : 'http';

const server = hasTlsCerts
  ? https.createServer(
      {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
      },
      app
    )
  : http.createServer(app);

server.listen(PORT, () => {
  const hostIp = (process.env.HOST_IP || '').trim();
  const localUrl = `${protocol}://localhost:${PORT}`;
  console.log(`create-me listening on ${localUrl}`);

  if (isDocker) {
    if (hostIp) {
      console.log(`Network: ${protocol}://${hostIp}:${PORT}`);
    } else {
      console.log('Set HOST_IP in .env to see your LAN URL here');
    }
  }
});
