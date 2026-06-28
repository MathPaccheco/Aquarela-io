/**
 * @file simulationBatcher.js
 * @description Accumulates stroke events per chunk over a fixed time window
 * and publishes a single batched simulation job to RabbitMQ at the end of
 * each window.
 *
 * Design rationale — why batch instead of one job per stroke:
 *  At ~30 fps mouse movement the Gateway would produce ~30 RabbitMQ round-trips
 *  per second (Gateway → RabbitMQ → Worker → RabbitMQ → Gateway → WebSocket).
 *  The queue grows faster than the Worker can drain it, causing compounding
 *  latency.  Batching over 150 ms reduces this to ~7 jobs/s — well within the
 *  Worker's processing capacity — while remaining imperceptible to the user
 *  because the fluid diffusion effect is expected to appear "a moment later".
 *
 * Responsibilities (SRP):
 *  - Accumulate strokes per (roomId, chunkId) pair within a time window.
 *  - Flush each accumulated batch as a single RabbitMQ job on window expiry.
 *  - Expose a `close()` method for graceful shutdown (flushes pending batches).
 */

const { getPublishChannel, EXCHANGE_NAME, JOB_QUEUE_NAME } = require('./rabbitClient');

/** @type {number} Batching window in milliseconds. */
const BATCH_WINDOW_MS = Number(process.env.SIMULATION_BATCH_WINDOW_MS) || 150;

/**
 * @typedef {object} StrokeData
 * @property {number} x         - Horizontal canvas coordinate.
 * @property {number} y         - Vertical canvas coordinate.
 * @property {string} color     - CSS hex colour string.
 * @property {number} brushSize - Brush diameter in pixels.
 * @property {string} userId    - Author of the stroke.
 * @property {number} timestamp - Unix epoch milliseconds.
 */

/**
 * @typedef {object} BatchEntry
 * @property {string}        roomId  - Room the strokes belong to.
 * @property {string}        chunkId - Chunk the strokes paint on.
 * @property {StrokeData[]}  strokes - Accumulated strokes for this window.
 * @property {NodeJS.Timeout} timer  - Handle for the flush timeout.
 */

/** @type {Map<string, BatchEntry>} Maps "roomId::chunkId" → pending batch. */
const _batches = new Map();

/**
 * Builds the composite key for a (roomId, chunkId) pair.
 *
 * @param {string} roomId
 * @param {string} chunkId
 * @returns {string}
 */
function _batchKey(roomId, chunkId) {
  return `${roomId}::${chunkId}`;
}

/**
 * Flushes a single batch: publishes one simulation job to RabbitMQ with all
 * accumulated strokes, then removes the batch entry from the map.
 *
 * Fire-and-forget on publish error — a flush failure does NOT block future
 * strokes or affect the stroke acceptance / persistence paths.
 *
 * @param {string} key - The "roomId::chunkId" map key.
 */
function _flush(key) {
  const entry = _batches.get(key);
  if (!entry) return;

  _batches.delete(key);

  const { roomId, chunkId, strokes } = entry;

  try {
    const channel = getPublishChannel();

    /** @type {{ roomId: string, chunkId: string, strokes: StrokeData[] }} */
    const job = { roomId, chunkId, strokes };

    channel.publish(
      EXCHANGE_NAME,
      JOB_QUEUE_NAME,
      Buffer.from(JSON.stringify(job)),
      { persistent: true, contentType: 'application/json' }
    );

    console.log(
      `[batcher] flush chunk=${chunkId} room=${roomId} strokes=${strokes.length}`
    );
  } catch (err) {
    // Non-throwing by design — simulation is visual-only and not on the
    // critical path for stroke acceptance or persistence.
    console.error(
      `[batcher] failed to flush chunk=${chunkId} room=${roomId}: ${err.message}`
    );
  }
}

/**
 * Adds a stroke to the pending batch for its (roomId, chunkId) pair.
 *
 * If no batch exists for this pair a new one is created and a flush timer is
 * scheduled for BATCH_WINDOW_MS from now.  Subsequent strokes on the same
 * pair within the window are appended to the existing batch — no extra timers.
 *
 * @param {string}     roomId  - Room the stroke belongs to.
 * @param {string}     chunkId - Canvas chunk identifier (e.g. "0_0").
 * @param {StrokeData} stroke  - Accepted stroke data.
 */
function addStroke(roomId, chunkId, stroke) {
  const key = _batchKey(roomId, chunkId);

  if (_batches.has(key)) {
    _batches.get(key).strokes.push(stroke);
    return;
  }

  // First stroke in this window — create the batch and schedule its flush.
  const timer = setTimeout(() => _flush(key), BATCH_WINDOW_MS);

  // Unref the timer so it does not prevent Node.js from exiting during tests
  // or when the process is winding down before the window expires.
  if (timer.unref) timer.unref();

  _batches.set(key, { roomId, chunkId, strokes: [stroke], timer });
}

/**
 * Flushes all pending batches immediately and clears the internal map.
 *
 * Call this during graceful shutdown to ensure no accumulated strokes are
 * silently dropped when the process exits.
 */
function flushAll() {
  for (const [key, entry] of _batches.entries()) {
    clearTimeout(entry.timer);
    _flush(key);
  }
}

module.exports = { addStroke, flushAll };
