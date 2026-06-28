/**
 * @file simulationResultsConsumer.js
 * @description Consumes ``simulation_results`` messages from RabbitMQ and
 * broadcasts ``pixel_update`` events to all WebSocket clients in the
 * affected room.
 *
 * Message flow:
 *   Worker (fluid diffusion) → RabbitMQ [simulation_results]
 *   → this consumer → roomManager.broadcastToRoom()
 *   → Frontend WebSocket clients (pixel_update)
 *
 * Acknowledgement strategy:
 *  - ``noAck: false`` (manual ack) is used so that a message is only removed
 *    from the queue after the broadcast call returns.
 *  - Malformed messages and broadcast errors are nack'd with ``requeue=false``
 *    so they are discarded (the results queue has no DLQ — a stale pixel_update
 *    has no value after the round-trip delay, so retrying is pointless).
 *
 * Responsibilities (SRP):
 *  - Parse the result payload.
 *  - Call roomManager.broadcastToRoom() with the pixel_update event.
 *  - Ack / nack the message.
 */

const { getConsumeChannel, RESULTS_QUEUE_NAME } = require('./rabbitClient');

/**
 * Starts the simulation results consumer on the shared consume channel.
 * Must be called after rabbitClient.connect() resolves.
 *
 * @param {object} roomManager - The roomManager module (broadcastToRoom).
 * @returns {void}
 */
function startSimulationResultsConsumer(roomManager) {
  const channel = getConsumeChannel();

  channel.consume(
    RESULTS_QUEUE_NAME,
    (msg) => {
      // null delivery = consumer cancelled by the broker (e.g. queue deleted).
      if (!msg) return;

      try {
        const result = JSON.parse(msg.content.toString());
        const { roomId, chunkId, pixels } = result;

        if (
          typeof roomId !== 'string' ||
          typeof chunkId !== 'string' ||
          !Array.isArray(pixels)
        ) {
          console.warn('[simulationResultsConsumer] malformed result payload — discarding.');
          channel.nack(msg, false, false);
          return;
        }

        const sentCount = roomManager.broadcastToRoom(roomId, {
          type: 'pixel_update',
          chunkId,
          pixels,
        });

        console.log(
          `[simulationResultsConsumer] pixel_update broadcast: ` +
          `room=${roomId} chunk=${chunkId} pixels=${pixels.length} clients=${sentCount}`
        );

        channel.ack(msg);
      } catch (err) {
        console.error('[simulationResultsConsumer] error processing result:', err.message);
        // nack without requeue — stale pixel data has no recovery value.
        channel.nack(msg, false, false);
      }
    },
    { noAck: false }
  );

  console.log(`[simulationResultsConsumer] listening on queue '${RESULTS_QUEUE_NAME}'`);
}

module.exports = { startSimulationResultsConsumer };
