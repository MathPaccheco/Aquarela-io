/**
 * @file rabbitClient.js
 * @description Singleton RabbitMQ client for the Gateway.
 *
 * Manages a persistent amqplib connection with exponential-backoff reconnect,
 * idempotent topology declaration, and shared publish/consume channels.
 *
 * AMQP topology (mirrored on the Worker side for idempotency — either side
 * can start first without error):
 *
 *   Exchange : aquarela_events (direct, durable)
 *   Queue    : fluid_simulation_jobs       — Gateway publishes, Worker consumes
 *   Queue    : fluid_simulation_jobs.dlq   — dead letters from failed Worker jobs
 *   Queue    : simulation_results          — Worker publishes, Gateway consumes
 *
 * Responsibilities (SRP):
 *  - Manage AMQP connection and channel lifecycle.
 *  - Declare topology once on startup.
 *  - Expose getPublishChannel() and getConsumeChannel() to domain modules.
 */

const amqplib = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672/';

/** @type {string} AMQP direct exchange shared by all Aquarela queues. */
const EXCHANGE_NAME = 'aquarela_events';

/** @type {string} Queue where the Gateway publishes fluid simulation jobs. */
const JOB_QUEUE_NAME = 'fluid_simulation_jobs';

/** @type {string} Dead-letter queue for Worker jobs that fail processing. */
const DLQ_NAME = 'fluid_simulation_jobs.dlq';

/** @type {string} Queue where the Worker publishes diffusion results. */
const RESULTS_QUEUE_NAME = 'simulation_results';

const MAX_RETRY_ATTEMPTS = 10;
const BASE_RETRY_DELAY_MS = 2000;

/** @type {import('amqplib').Connection|null} */
let connection = null;

/**
 * Dedicated channel for outgoing simulation job publishes.
 * @type {import('amqplib').Channel|null}
 */
let publishChannel = null;

/**
 * Dedicated channel for consuming simulation results.
 * @type {import('amqplib').Channel|null}
 */
let consumeChannel = null;

/**
 * Resolves after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Declares the full AMQP exchange / queue / DLQ topology on a channel.
 * All entities are durable so they survive a RabbitMQ restart.
 * Calling this multiple times is safe (idempotent assert semantics).
 *
 * @param {import('amqplib').Channel} channel
 * @returns {Promise<void>}
 */
async function declareTopology(channel) {
  await channel.assertExchange(EXCHANGE_NAME, 'direct', { durable: true });

  // Dead-letter queue — receives nack'd messages from the jobs queue.
  await channel.assertQueue(DLQ_NAME, { durable: true });
  await channel.bindQueue(DLQ_NAME, EXCHANGE_NAME, DLQ_NAME);

  // Simulation jobs queue: failed messages route to the DLQ instead of
  // looping forever, bounding retry amplification in fault scenarios.
  await channel.assertQueue(JOB_QUEUE_NAME, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': EXCHANGE_NAME,
      'x-dead-letter-routing-key': DLQ_NAME,
    },
  });
  await channel.bindQueue(JOB_QUEUE_NAME, EXCHANGE_NAME, JOB_QUEUE_NAME);

  // Simulation results queue — consumed by simulationResultsConsumer.js.
  await channel.assertQueue(RESULTS_QUEUE_NAME, { durable: true });
  await channel.bindQueue(RESULTS_QUEUE_NAME, EXCHANGE_NAME, RESULTS_QUEUE_NAME);

  console.log(`[rabbitClient] topology declared: exchange=${EXCHANGE_NAME}, queues=${JOB_QUEUE_NAME}, ${RESULTS_QUEUE_NAME}, ${DLQ_NAME}`);
}

/**
 * Establishes the AMQP connection with exponential-backoff retry.
 * Initialises publish and consume channels and declares the queue topology.
 *
 * Should be called once during Gateway startup (index.js) before accepting
 * WebSocket traffic, so simulation publishing is ready from the first stroke.
 *
 * @returns {Promise<void>}
 * @throws {Error} If all retry attempts are exhausted.
 */
async function connect() {
  let delay = BASE_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      connection = await amqplib.connect(RABBITMQ_URL);
      console.log(`[rabbitClient] connected to RabbitMQ (attempt ${attempt})`);

      // Reconnect automatically on unexpected connection drops.
      connection.on('error', (err) => {
        console.error('[rabbitClient] connection error:', err.message);
      });
      connection.on('close', () => {
        console.warn('[rabbitClient] connection closed — scheduling reconnect…');
        publishChannel = null;
        consumeChannel = null;
        setTimeout(() => connect(), BASE_RETRY_DELAY_MS);
      });

      publishChannel = await connection.createChannel();
      consumeChannel = await connection.createChannel();

      // Topology is declared on the publish channel; the consume channel
      // inherits the already-declared entities from the broker.
      await declareTopology(publishChannel);
      return;

    } catch (err) {
      console.warn(
        `[rabbitClient] attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed: ${err.message}. ` +
        `Retrying in ${delay}ms…`
      );
      if (attempt === MAX_RETRY_ATTEMPTS) {
        throw new Error(`Cannot connect to RabbitMQ after ${MAX_RETRY_ATTEMPTS} attempts.`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

/**
 * Returns the channel dedicated to publishing simulation jobs.
 * Requires connect() to have been called and resolved first.
 *
 * @returns {import('amqplib').Channel}
 * @throws {Error} If the channel is not yet initialised.
 */
function getPublishChannel() {
  if (!publishChannel) {
    throw new Error('[rabbitClient] publishChannel not initialised — call connect() first.');
  }
  return publishChannel;
}

/**
 * Returns the channel dedicated to consuming simulation results.
 * Requires connect() to have been called and resolved first.
 *
 * @returns {import('amqplib').Channel}
 * @throws {Error} If the channel is not yet initialised.
 */
function getConsumeChannel() {
  if (!consumeChannel) {
    throw new Error('[rabbitClient] consumeChannel not initialised — call connect() first.');
  }
  return consumeChannel;
}

/**
 * Gracefully closes all AMQP channels and the connection.
 * Called during Gateway graceful shutdown in index.js.
 *
 * @returns {Promise<void>}
 */
async function close() {
  try {
    if (publishChannel) await publishChannel.close();
    if (consumeChannel) await consumeChannel.close();
    if (connection) await connection.close();
    console.log('[rabbitClient] AMQP connection closed cleanly.');
  } catch (err) {
    console.error('[rabbitClient] error during close:', err.message);
  }
}

module.exports = {
  connect,
  getPublishChannel,
  getConsumeChannel,
  close,
  EXCHANGE_NAME,
  JOB_QUEUE_NAME,
  RESULTS_QUEUE_NAME,
};
