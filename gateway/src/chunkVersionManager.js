/**
 * @file chunkVersionManager.js
 * @description In-memory Optimistic Concurrency Control (OCC) version store
 * for canvas chunks.
 *
 * ── Why OCC (Optimistic Locking) and NOT PCC (Pessimistic Locking)? ──────────
 *
 * Pessimistic Concurrency Control would require acquiring a mutex or DB row-
 * lock *before* processing each stroke, serialising all writers on the same
 * chunk.  Under the Aquarela.io workload — many users painting rapidly — this
 * turns the Gateway into a bottleneck: each stroke_event would stall waiting
 * for the previous holder to release the lock, degrading latency for all
 * participants even when conflicts are rare.
 *
 * Optimistic Concurrency Control assumes conflicts are the exception, not the
 * rule.  Each client tracks the last-known version of every chunk it has
 * painted.  The Gateway checks the version in O(1) (a single Map lookup) and
 * either:
 *   • accepts the stroke (versions match) — bumps the version and continues.
 *   • rejects the stroke (versions diverge) — returns a conflict_event so the
 *     client can update its local version and re-paint.
 *
 * The critical section is a synchronous Map lookup + increment — microseconds,
 * not milliseconds.  Because Node.js is single-threaded, no explicit mutex is
 * needed: two stroke_events are never processed simultaneously in the same
 * process.
 *
 * ── Phase 7 hook ─────────────────────────────────────────────────────────────
 * When scaling to multiple Gateway instances, replace the `versionMap` with
 * Redis INCR + CAS (WATCH / MULTI / EXEC) so version state is shared across
 * nodes.  The public API of this module remains identical — callers need not
 * change.
 *
 * Responsibilities (SRP):
 *  - Maintain a per-(roomId, chunkId) version counter in memory.
 *  - Seed versions from the database on Gateway restart (via initChunk).
 *  - Expose tryAcceptStroke() as the single OCC decision point.
 *  - Clean up memory when a room becomes empty.
 */

/**
 * Composite key builder for the version map.
 *
 * @param {string} roomId
 * @param {string} chunkId
 * @returns {string}
 */
function buildKey(roomId, chunkId) {
  return `${roomId}::${chunkId}`;
}

/**
 * In-memory version store.
 * Keys are composite "roomId::chunkId" strings; values are the current
 * version number (BIGINT-compatible JS integer).
 *
 * @type {Map<string, number>}
 */
const versionMap = new Map();

/**
 * Seeds the in-memory version for a specific chunk.
 *
 * Called in two scenarios:
 *  1. A client joins a room — versions are hydrated from the DB rows returned
 *     by fetchRoomChunks().
 *  2. A stroke is accepted for a brand-new chunk that has never been persisted
 *     — the version starts at 0 and is immediately bumped by tryAcceptStroke.
 *
 * Idempotent: calling initChunk on an already-tracked chunk updates the stored
 * version.  This is intentional so that a DB-authoritative version always wins
 * over a stale in-memory value after a Gateway restart where some clients
 * reconnect in parallel.
 *
 * @param {string} roomId   - Room that owns the chunk.
 * @param {string} chunkId  - Chunk identifier (e.g. "0_0").
 * @param {number} version  - The version number to seed (typically from DB).
 */
function initChunk(roomId, chunkId, version) {
  const key = buildKey(roomId, chunkId);
  const inMemoryVersion = versionMap.get(key) ?? 0;
  const dbVersion = Number(version);

  // Use Math.max so a DB read never downgrades the in-memory version.
  // The write-batcher flushes asynchronously (every BATCH_FLUSH_INTERVAL_MS),
  // so the DB version may legitimately lag behind the in-memory state when a
  // second client joins mid-session.  Overwriting with the stale DB value
  // would cause clients whose chunkVersions map is ahead to receive spurious
  // conflict_events on their next stroke.
  versionMap.set(key, Math.max(inMemoryVersion, dbVersion));
}

/**
 * Atomically validates and accepts (or rejects) an incoming stroke based on
 * its client-reported version.
 *
 * OCC decision logic:
 *  - If the client's version matches the stored version → the client has an
 *    up-to-date view of this chunk.  The stroke is accepted and the version
 *    is incremented immediately (before any async I/O) so the next concurrent
 *    stroke in the event loop sees the bumped value.
 *  - If the client's version is lower than the stored version → another stroke
 *    was accepted after the client last synced.  The stroke is rejected and the
 *    current authoritative version is returned so the client can reconcile.
 *
 * Note: because Node.js event processing is single-threaded, the check-and-
 * increment sequence below is effectively atomic — no two stroke_events can
 * interleave within a single synchronous call stack.
 *
 * @param {string} roomId        - Room that owns the chunk.
 * @param {string} chunkId       - Chunk the stroke targets.
 * @param {number} clientVersion - The version the client believed was current.
 * @returns {{ accepted: boolean, currentVersion: number }}
 *   `accepted` is true if the stroke was accepted and the version was bumped.
 *   `currentVersion` is the authoritative version after the operation:
 *     - on accept: the newly incremented version.
 *     - on reject: the version the Gateway has (client should sync to this).
 */
function tryAcceptStroke(roomId, chunkId, clientVersion) {
  const key = buildKey(roomId, chunkId);

  // Default to 0 for chunks that have never been painted — this handles
  // the very first stroke on a fresh chunk without requiring an explicit init.
  const storedVersion = versionMap.get(key) ?? 0;

  if (clientVersion !== storedVersion) {
    // Conflict: client is operating on a stale version of this chunk.
    return { accepted: false, currentVersion: storedVersion };
  }

  // Accept: bump the version atomically (synchronous — no await between
  // the read above and this write).
  const newVersion = storedVersion + 1;
  versionMap.set(key, newVersion);

  return { accepted: true, currentVersion: newVersion };
}

/**
 * Returns the current in-memory version for a chunk.
 * Returns 0 if the chunk has not been seeded yet.
 *
 * @param {string} roomId  - Room that owns the chunk.
 * @param {string} chunkId - Chunk identifier.
 * @returns {number}
 */
function getVersion(roomId, chunkId) {
  return versionMap.get(buildKey(roomId, chunkId)) ?? 0;
}

/**
 * Removes all version entries for a given room from the in-memory map.
 *
 * Should be called when the last client leaves a room to prevent unbounded
 * memory growth in long-running Gateway processes with many transient rooms.
 * Versions are re-hydrated from the DB when the room is next joined.
 *
 * @param {string} roomId - Room whose entries should be purged.
 */
function clearRoom(roomId) {
  const prefix = `${roomId}::`;

  for (const key of versionMap.keys()) {
    if (key.startsWith(prefix)) {
      versionMap.delete(key);
    }
  }

  console.log(`[chunkVersionManager] version entries cleared for room=${roomId}`);
}

module.exports = { initChunk, tryAcceptStroke, getVersion, clearRoom };
