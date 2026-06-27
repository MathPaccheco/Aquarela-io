/**
 * @file index.js
 * @description Gateway entry point — bootstraps the HTTP/WebSocket server.
 * Full implementation is added in Phase 1 (WebSocket + Rooms).
 * Phase 3 adds PostgreSQL connection eagerness and write-batcher lifecycle.
 */

require('dotenv').config();

const http = require('http');
const { initWsServer } = require('./wsServer');

// Eagerly require the pool so the process fails fast if env vars are missing
// rather than silently operating without persistence.
const { pool } = require('./db/pool');
const writeBatcher = require('./writeBatcher');

const PORT = process.env.GATEWAY_PORT || 3000;
const BATCH_FLUSH_INTERVAL_MS = Number(process.env.BATCH_FLUSH_INTERVAL_MS) || 5_000;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'aquarela-gateway' }));
});

initWsServer(server);

server.listen(PORT, () => {
  console.log(`[gateway] HTTP server listening on port ${PORT}`);

  // Verify the DB connection is reachable before accepting traffic.
  pool.query('SELECT 1').then(() => {
    console.log('[gateway] PostgreSQL connection verified.');
  }).catch((err) => {
    console.error('[gateway] PostgreSQL connection failed:', err.message);
    // Do not exit — the server can still serve WebSocket connections;
    // write-batcher flushes will fail and log until the DB recovers.
  });

  // Start the periodic write-batcher flush loop.
  writeBatcher.startFlushTimer(BATCH_FLUSH_INTERVAL_MS);
});

/**
 * Graceful shutdown: flush all pending strokes before the process exits.
 * Ensures minimal data loss when the container is stopped (SIGTERM from
 * Docker / Kubernetes) or the process is interrupted (SIGINT from CLI).
 */
async function gracefulShutdown(signal) {
  console.log(`[gateway] ${signal} received — starting graceful shutdown…`);
  try {
    await writeBatcher.flushAll();
    await pool.end();
    console.log('[gateway] PostgreSQL pool closed. Bye!');
  } catch (err) {
    console.error('[gateway] error during shutdown:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

