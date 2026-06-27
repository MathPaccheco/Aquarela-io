/**
 * @file pool.js
 * @description Singleton pg.Pool for the Aquarela.io Gateway.
 *
 * A single Pool instance is shared across the entire process lifetime.
 * Using a singleton avoids exhausting the PostgreSQL max_connections limit
 * and removes the overhead of establishing a new TCP handshake per query.
 *
 * Phase 7 — Read-Replica hook:
 *   To offload SELECT queries to a read-only replica, export a second Pool
 *   here (e.g. `readPool`) pointed at POSTGRES_READ_HOST and import it
 *   selectively in chunkRepository.fetchRoomChunks().  No code change is
 *   needed elsewhere — SRP keeps the swap localised to this file.
 */

const { Pool } = require('pg');

/**
 * Connection pool for the primary (read-write) PostgreSQL instance.
 * Configuration is sourced exclusively from environment variables so that no
 * credentials appear in source code (OWASP A02 — Cryptographic Failures).
 *
 * @type {import('pg').Pool}
 */
const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT) || 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  // Keep the pool small: the Gateway is I/O-bound, not CPU-bound, so a
  // handful of connections is sufficient and avoids saturating the DB server.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[db/pool] Unexpected error on idle PostgreSQL client:', err.message);
});

module.exports = { pool };
