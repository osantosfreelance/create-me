'use strict';

/**
 * create-me — townhall photo booth server.
 *
 * Privacy design: this server is intentionally stateless.
 *  - No database, no filesystem writes of any photo or generated image.
 *  - Request bodies (which contain image bytes) are never logged.
 *  - The Gemini API key lives only in process env and is never sent to the browser.
 *  - Images pass through memory for the lifetime of a single request only.
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

// Session code validation. If SESSION_CODE is set, enforce it on protected endpoints.
const VALID_SESSION = process.env.SESSION_CODE || 'create-me-townhall-2k26';

function sessionCodeMiddleware(req, res, next) {
  const sessionCode = req.get('x-session-code') || (req.body && req.body.sessionCode);
  if (sessionCode !== VALID_SESSION) {
    console.warn(`[${req.requestId}] session-code validation failed: received "${sessionCode || 'none'}"`);
    return res.status(401).json({ error: 'Invalid or missing session code.' });
  }
  next();
}

// Validation endpoint for early feedback on session code
app.post('/api/validate-session', (req, res) => {
  const sessionCode = req.get('x-session-code') || (req.body && req.body.sessionCode);
  if (sessionCode !== VALID_SESSION) {
    console.warn(`[${req.requestId}] session-code validation failed: received "${sessionCode || 'none'}"`);
    return res.status(401).json({ error: 'Invalid or missing session code.' });
  }
  res.json({ ok: true });
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
