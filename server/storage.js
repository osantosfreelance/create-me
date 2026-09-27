'use strict';

/**
 * In-memory storage for opt-in "Save" photos.
 *
 * By default this app is stateless (see server/index.js). Saving a photo is
 * an explicit, attendee-initiated action: a photo is only ever kept here
 * when the user taps "Save" on the result screen — nothing is ever written
 * to disk, and no bucket/volume is used.
 *
 * This is a small, fixed-size ring buffer: at most MAX_PHOTOS are held in
 * process memory at once. Once that cap is reached, saving a new photo
 * evicts the oldest saved photo first (FIFO). There is no expiry job and no
 * persistence across restarts — this is by design for a small, single-event
 * operation. Operators should tell attendees to download their QR-linked
 * photo promptly, since it may be overwritten once 5 newer photos are saved,
 * and everything is gone once the instance restarts or redeploys.
 */

const crypto = require('crypto');

const MAX_PHOTOS = 5;

// Only ever match a bare, well-formed v4-style UUID — used both to validate
// generated ids and to gate the public `/:uuid` lookup route so it can never
// be used for arbitrary path traversal.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Ordered oldest-first; a plain array keeps FIFO eviction and lookup simple
// at this tiny scale (at most 5 entries).
const photos = [];

/**
 * Stores a saved photo in memory, evicting the oldest entry if the buffer
 * is already at capacity.
 * @param {{imageBase64: string, mimeType: string, sessionCode: string}} params
 * @returns {Promise<{id: string}>}
 */
async function savePhoto({ imageBase64, mimeType, sessionCode }) {
  const normalizedMimeType = mimeType.toLowerCase();
  if (!KNOWN_MIME_TYPES.has(normalizedMimeType)) {
    throw new Error(`Unsupported mime type for storage: ${mimeType}`);
  }

  const id = crypto.randomUUID();
  const buffer = Buffer.from(imageBase64, 'base64');

  if (photos.length >= MAX_PHOTOS) {
    photos.shift(); // drop the oldest saved photo
  }
  photos.push({
    id,
    buffer,
    mimeType: normalizedMimeType,
    sessionCode,
    createdAt: new Date().toISOString(),
  });

  return { id };
}

/**
 * Finds a stored photo by id.
 * @param {string} id
 * @returns {Promise<{buffer: Buffer, mimeType: string} | null>}
 */
async function findPhoto(id) {
  if (!UUID_PATTERN.test(id)) return null;
  const photo = photos.find((p) => p.id === id);
  if (!photo) return null;
  return { buffer: photo.buffer, mimeType: photo.mimeType };
}

/**
 * Lists currently saved photos for a given session code, most recent first.
 * @param {string} sessionCode
 * @returns {Promise<Array<{id: string, createdAt: string}>>}
 */
async function listPhotosForSession(sessionCode) {
  return photos
    .filter((p) => p.sessionCode === sessionCode)
    .map((p) => ({ id: p.id, createdAt: p.createdAt }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

module.exports = {
  savePhoto,
  findPhoto,
  listPhotosForSession,
  UUID_PATTERN,
  MAX_PHOTOS,
};
