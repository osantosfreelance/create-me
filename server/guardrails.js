'use strict';

/**
 * Input guardrails for the /api/generate endpoint.
 *
 * Defense-in-depth: Gemini has its own safety filters, but rejecting obviously
 * abusive input here (a) is instant/free (no paid API call), (b) reduces the
 * prompt-injection surface before user text ever reaches the model, and
 * (c) matters a lot once this is deployed unattended at a public kiosk or
 * resold as a product to other customers who may not be watching it closely.
 */

const MAX_PROMPT_LENGTH = 500;
const MIN_PROMPT_LENGTH = 2;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB decoded
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Patterns aimed at detecting attempts to manipulate the model/backend rather
// than simply describe a desired photo edit. This is intentionally narrow —
// it should almost never trigger on a legitimate "make me look like X" prompt.
const INJECTION_PATTERNS = [
  /ignore (all |the |any )?(previous|prior|above|earlier) instructions?/i,
  /disregard (all |the |any )?(previous|prior|above|earlier)/i,
  /system\s*(prompt|instruction|message)/i,
  /you are (now|no longer)/i,
  /act as (if you|a| an)?\s*(jailbreak|dan|unfiltered|uncensored)/i,
  /jailbreak/i,
  /reveal (your|the) (prompt|instructions|api key|system)/i,
  /\bapi[\s_-]?key\b/i,
  /<\s*script[\s>]/i,
  /\{\{.*\}\}/, // template-injection style payloads
];

// A minimal denylist of clearly disallowed content categories. This is not a
// substitute for Gemini's own safety filtering, just a fast, free first pass.
const DISALLOWED_CONTENT_PATTERNS = [
  /\b(child|kid|minor|toddler|infant)\b[^.]{0,40}\b(nude|naked|sexual|explicit|porn)\b/i,
  /\b(nude|naked|sexual|explicit|porn|nsfw)\b[^.]{0,40}\b(child|kid|minor|toddler|infant)\b/i,
  /\bgore\b|\bdecapitat/i,
  /how to (make|build) a (bomb|weapon|explosive)/i,
];

const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Validates and normalizes a user-supplied prompt.
 * @param {unknown} rawPrompt
 * @returns {{ok: true, prompt: string} | {ok: false, error: string}}
 */
function validatePrompt(rawPrompt) {
  if (typeof rawPrompt !== 'string') {
    return { ok: false, error: 'Prompt must be text.' };
  }

  // Strip control characters (defends against terminal/log injection and
  // odd unicode tricks), then collapse whitespace.
  const cleaned = rawPrompt.replace(CONTROL_CHAR_PATTERN, '').replace(/\s+/g, ' ').trim();

  if (cleaned.length < MIN_PROMPT_LENGTH) {
    return { ok: false, error: 'Please describe how you want your image to look.' };
  }
  if (cleaned.length > MAX_PROMPT_LENGTH) {
    return { ok: false, error: `Prompt too long (max ${MAX_PROMPT_LENGTH} characters).` };
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      return {
        ok: false,
        error: 'Please only describe how you want your photo to look (no instructions to the system).',
      };
    }
  }

  for (const pattern of DISALLOWED_CONTENT_PATTERNS) {
    if (pattern.test(cleaned)) {
      return { ok: false, error: 'This request is not allowed. Please try a different description.' };
    }
  }

  return { ok: true, prompt: cleaned };
}

/**
 * Validates the uploaded image's mime type and size.
 * @param {unknown} mimeType
 * @param {unknown} base64
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validateImage(mimeType, base64) {
  if (typeof base64 !== 'string' || !base64) {
    return { ok: false, error: 'Missing image data.' };
  }
  if (typeof mimeType !== 'string' || !ALLOWED_MIME_TYPES.has(mimeType.toLowerCase())) {
    return { ok: false, error: 'Unsupported image type.' };
  }
  // Base64 must only contain valid characters (defends against attempts to
  // smuggle non-image data through this field).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { ok: false, error: 'Image data is not valid base64.' };
  }
  // Rough decoded-size check without allocating a buffer for oversized input.
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Image is too large (max 10MB).' };
  }
  return { ok: true };
}

module.exports = {
  validatePrompt,
  validateImage,
  MAX_PROMPT_LENGTH,
  MAX_IMAGE_BYTES,
  ALLOWED_MIME_TYPES,
};
