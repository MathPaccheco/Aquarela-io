/**
 * @file chunkRepository.js
 * @description Data-access layer for the `canvas_chunks` table.
 *
 * Responsibilities (SRP):
 *  - Encapsulate all SQL for canvas chunk persistence.
 *  - Expose two async functions consumed by writeBatcher and messageHandler.
 *
 * This module is intentionally free of business logic — it speaks only SQL
 * and delegates connection management to the shared pool singleton.
 */

const { pool } = require('./pool');

/**
 * Persists a batch of new strokes for a specific chunk, together with the
 * current OCC version number.
 *
 * Uses INSERT … ON CONFLICT DO UPDATE with the PostgreSQL `||` JSONB
 * concatenation operator to **append** incoming strokes to the existing
 * array rather than overwriting it.  This is safe for concurrent writers
 * because the update expression reads from the persisted column at statement
 * execution time — any stroke committed between the INSERT attempt and the
 * conflict resolution is preserved.
 *
 * The `version` column mirrors the in-memory version maintained by
 * chunkVersionManager.js.  It is persisted here so the Gateway can hydrate
 * the in-memory map correctly after a restart, preventing false conflict
 * rejections against clients that had a valid version before the crash.
 *
 * @param {string}   roomId   - Room that owns this chunk.
 * @param {string}   chunkId  - Chunk identifier (e.g. "0_0", "1_2").
 * @param {object[]} strokes  - Array of stroke objects to append.
 * @param {number}   version  - The accepted OCC version to persist.
 * @param {number} strokes[].x          - Horizontal canvas coordinate.
 * @param {number} strokes[].y          - Vertical canvas coordinate.
 * @param {string} strokes[].color      - CSS hex colour string.
 * @param {number} strokes[].brushSize  - Brush radius in pixels.
 * @param {string} strokes[].userId     - Stroke author identifier.
 * @param {number} strokes[].timestamp  - Unix epoch milliseconds.
 * @returns {Promise<void>}
 */
async function upsertChunk(roomId, chunkId, strokes, version) {
  const strokesJson = JSON.stringify(strokes);

  await pool.query(
    `INSERT INTO canvas_chunks (room_id, chunk_id, pixel_data, last_updated, version)
     VALUES ($1, $2, $3::jsonb, NOW(), $4)
     ON CONFLICT (room_id, chunk_id) DO UPDATE
       SET pixel_data   = canvas_chunks.pixel_data || EXCLUDED.pixel_data,
           last_updated = NOW(),
           version      = EXCLUDED.version`,
    [roomId, chunkId, strokesJson, version]
  );
}

/**
 * Retrieves all chunks belonging to a room, including their OCC version numbers.
 *
 * Called during `join_room` handling to restore the full canvas state for a
 * newly connected client and to hydrate the in-memory version map.
 * Query targets the primary read-write pool; in Phase 7 this can be swapped
 * for a `readPool` without changing callers.
 *
 * @param {string} roomId - Room whose chunks should be fetched.
 * @returns {Promise<Array<{ chunkId: string, strokes: object[], version: number }>>}
 *   An array of chunk objects, each carrying the full stroke history and version.
 */
async function fetchRoomChunks(roomId) {
  const result = await pool.query(
    `SELECT chunk_id AS "chunkId", pixel_data AS strokes, version
     FROM canvas_chunks
     WHERE room_id = $1`,
    [roomId]
  );

  // node-postgres returns BIGINT columns as strings to avoid JavaScript's
  // 53-bit integer precision limit.  We coerce to Number here because our
  // version counters will never approach Number.MAX_SAFE_INTEGER in practice,
  // and the rest of the system (chunkVersionManager, frontend) depends on
  // strict numeric equality checks (===).
  return result.rows.map((row) => ({
    chunkId: row.chunkId,
    strokes: row.strokes,
    version: Number(row.version),
  }));
}

module.exports = { upsertChunk, fetchRoomChunks };
