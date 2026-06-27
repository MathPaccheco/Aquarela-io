/**
 * @file writeBatcher.js
 * @description In-memory write-batcher for canvas chunk strokes.
 *
 * Problem: each stroke_event would otherwise trigger an individual UPDATE on
 * the database, which is expensive under high concurrency (many users painting
 * simultaneously).  By accumulating strokes in memory and flushing them in
 * periodic batches we trade a small data-loss window (≤ BATCH_FLUSH_INTERVAL_MS)
 * for significantly fewer round-trips to PostgreSQL.
 *
 * Concurrency note: Node.js is single-threaded so there is no race condition
 * between addStroke() and the flush loop.  The copy-and-clear pattern in
 * _flushPendingStrokes() ensures that strokes arriving during an async DB write
 * are buffered into a fresh Map and are not lost.
 *
 * Responsibilities (SRP):
 *  - Accumulate strokes in a keyed Map.
 *  - Periodically drain the Map and persist via chunkRepository.
 *  - Expose flushAll() for graceful shutdown.
 */

const { upsertChunk } = require('./db/chunkRepository');

/**
 * Composite key used to bucket strokes by (roomId, chunkId).
 *
 * @param {string} roomId
 * @param {string} chunkId
 * @returns {string}
 */
function buildBucketKey(roomId, chunkId) {
  return `${roomId}::${chunkId}`;
}

/**
 * Pending stroke accumulator.
 * Keys are composite "roomId::chunkId" strings; values carry the stroke array
 * and the *latest accepted OCC version* for the chunk in this batch.
 * The version is updated on every addStroke call so that the DB always receives
 * the most recent authoritative version on flush, keeping it in sync with the
 * in-memory chunkVersionManager state.
 *
 * @type {Map<string, { roomId: string, chunkId: string, strokes: object[], version: number }>}
 */
let pendingBuckets = new Map();

/**
 * Drains the current pending buckets and persists each one via upsertChunk.
 * Uses copy-and-clear so that strokes arriving during the async DB writes go
 * into a fresh accumulator and are not silently dropped.
 *
 * @returns {Promise<void>}
 */
async function _flushPendingStrokes() {
  if (pendingBuckets.size === 0) return;

  // Atomically swap the accumulator so new strokes are buffered separately
  // while we await the DB writes below.
  const bucketsToFlush = pendingBuckets;
  pendingBuckets = new Map();

  for (const [, { roomId, chunkId, strokes, version }] of bucketsToFlush) {
    try {
      await upsertChunk(roomId, chunkId, strokes, version);
      console.log(`[writeBatcher] flushed ${strokes.length} stroke(s) → room=${roomId} chunk=${chunkId} version=${version}`);
    } catch (err) {
      console.error(
        `[writeBatcher] failed to flush room=${roomId} chunk=${chunkId}: ${err.message}`
      );
      // Strokes that could not be persisted are discarded rather than
      // re-queued indefinitely — a bounded data-loss trade-off chosen
      // because the live broadcast already delivered them to all connected
      // clients.  A dead-letter strategy could be added in a future phase.
    }
  }
}

/**
 * Adds a single stroke to the in-memory accumulator.
 * This is the hot path: called on every stroke_event — must be synchronous
 * and allocation-minimal.
 *
 * @param {string} roomId   - Room the stroke belongs to.
 * @param {string} chunkId  - Chunk the stroke touches.
 * @param {object} stroke   - Stroke payload to persist.
 * @param {number} version  - The accepted OCC version returned by chunkVersionManager.
 *   Stored in the bucket and written to the DB on flush so the persisted version
 *   always mirrors the in-memory authoritative state.
 * @param {number} stroke.x         - Horizontal canvas coordinate.
 * @param {number} stroke.y         - Vertical canvas coordinate.
 * @param {string} stroke.color     - CSS hex colour string.
 * @param {number} stroke.brushSize - Brush radius in pixels.
 * @param {string} stroke.userId    - Stroke author.
 * @param {number} stroke.timestamp - Unix epoch milliseconds.
 */
function addStroke(roomId, chunkId, stroke, version) {
  const key = buildBucketKey(roomId, chunkId);

  if (!pendingBuckets.has(key)) {
    pendingBuckets.set(key, { roomId, chunkId, strokes: [], version: 0 });
  }

  const bucket = pendingBuckets.get(key);
  bucket.strokes.push(stroke);
  // Always overwrite with the latest version so the DB receives the most
  // recent authoritative value for the entire batch on flush.
  bucket.version = version;
}

/**
 * Starts the periodic flush timer.
 * Should be called once after the HTTP server begins listening.
 *
 * @param {number} intervalMs - Milliseconds between flushes (default 5 000).
 * @returns {NodeJS.Timeout} The interval handle, usable with clearInterval().
 */
function startFlushTimer(intervalMs = 5_000) {
  console.log(`[writeBatcher] flush timer started — interval=${intervalMs}ms`);
  return setInterval(() => {
    _flushPendingStrokes().catch((err) => {
      console.error('[writeBatcher] unexpected error during flush cycle:', err.message);
    });
  }, intervalMs);
}

/**
 * Performs a single immediate flush of all pending strokes.
 * Called during graceful shutdown (SIGTERM) to minimise data loss.
 *
 * @returns {Promise<void>}
 */
async function flushAll() {
  console.log('[writeBatcher] performing final flush before shutdown…');
  await _flushPendingStrokes();
  console.log('[writeBatcher] final flush complete.');
}

module.exports = { addStroke, startFlushTimer, flushAll };
