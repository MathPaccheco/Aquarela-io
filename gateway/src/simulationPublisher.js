/**
 * @file simulationPublisher.js
 * @description Publishes fluid simulation job messages to the
 * ``fluid_simulation_jobs`` RabbitMQ queue after a stroke is accepted
 * by the Gateway.
 *
 * Design decision — fire-and-forget (non-throwing):
 *  A publish failure must NOT roll back an already-acknowledged stroke.
 *  The stroke was already persisted via writeBatcher and broadcast to all room
 *  clients via WebSocket.  Only the fluid diffusion visual effect is lost for
 *  that specific stroke if the publish fails.  Errors are logged so the ops
 *  team can detect RabbitMQ connectivity issues.
 *
 * Responsibilities (SRP):
 *  - Serialise the stroke into the simulation job schema.
 *  - Publish to RabbitMQ via the shared rabbitClient channel.
 *  - Log publish errors without re-raising.
 */

const { getPublishChannel, EXCHANGE_NAME, JOB_QUEUE_NAME } = require('./rabbitClient');

/**
 * @typedef {object} StrokeData
 * @property {number} x          - Horizontal canvas coordinate.
 * @property {number} y          - Vertical canvas coordinate.
 * @property {string} color      - CSS hex colour string (e.g. "#120A8F").
 * @property {number} brushSize  - Brush radius in pixels.
 * @property {string} userId     - Author of the stroke.
 * @property {number} timestamp  - Unix epoch milliseconds.
 */

/**
 * Publishes a simulation job for a single accepted stroke to RabbitMQ.
 *
 * The job payload carries the stroke data needed by the Worker to render
 * the stroke onto the NumPy grid and run the diffusion algorithm.
 * Version and OCC metadata are intentionally excluded — the simulation
 * pipeline is visual-only and does NOT participate in concurrency control.
 *
 * @param {string}     roomId  - Room the stroke belongs to.
 * @param {string}     chunkId - Canvas chunk identifier (e.g. "0_0").
 * @param {StrokeData} stroke  - Accepted stroke data (safe subset, no ws object).
 */
function publishSimulationJob(roomId, chunkId, stroke) {
  try {
    const channel = getPublishChannel();

    /** @type {{ roomId: string, chunkId: string, strokes: StrokeData[] }} */
    const job = {
      roomId,
      chunkId,
      strokes: [stroke],
    };

    channel.publish(
      EXCHANGE_NAME,
      JOB_QUEUE_NAME,
      Buffer.from(JSON.stringify(job)),
      {
        persistent: true,       // Survive RabbitMQ restart.
        contentType: 'application/json',
      }
    );

    console.log(`[simulationPublisher] job queued: room=${roomId} chunk=${chunkId}`);
  } catch (err) {
    // Non-throwing by design — see module docstring.
    console.error(
      `[simulationPublisher] failed to publish job for room=${roomId} chunk=${chunkId}: ${err.message}`
    );
  }
}

module.exports = { publishSimulationJob };
