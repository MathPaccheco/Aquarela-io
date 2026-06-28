/**
 * @file messageHandler.js
 * @description Routes incoming WebSocket messages to the appropriate handler
 * based on the `type` field in the JSON payload.
 *
 * Responsibilities (SRP):
 *  - Parse raw message buffers into JSON.
 *  - Validate minimum required fields per message type.
 *  - Dispatch to the correct domain handler.
 *  - Send structured `error` responses for invalid payloads.
 *
 * This module does NOT manage room state directly — it delegates to roomManager.
 */

/**
 * @typedef {import('ws').WebSocket} WebSocket
 * @typedef {import('./roomManager')} RoomManager
 */

const writeBatcher = require('./writeBatcher');
const { fetchRoomChunks } = require('./db/chunkRepository');
const chunkVersionManager = require('./chunkVersionManager');
const simulationBatcher = require('./simulationBatcher');

/**
 * Sends a structured error message back to a single client.
 *
 * @param {WebSocket} ws - The client to notify.
 * @param {string} message - Human-readable error description.
 */
function sendError(ws, message) {
  ws.send(JSON.stringify({ type: 'error', message }));
}

/**
 * Handles a `join_room` event from a client.
 * Registers the client in the requested room and broadcasts a `client_joined`
 * notification to all existing room members.
 *
 * @param {WebSocket} ws - The connecting client.
 * @param {object} payload - The parsed message payload.
 * @param {string} payload.roomId - Target room identifier.
 * @param {string} payload.userId - Unique identifier of the joining user.
 * @param {object} roomManager - The roomManager module instance.
 */
function handleJoinRoom(ws, payload, roomManager) {
  const { roomId, userId } = payload;

  if (!roomId || typeof roomId !== 'string') {
    return sendError(ws, 'join_room requires a non-empty string roomId.');
  }
  if (!userId || typeof userId !== 'string') {
    return sendError(ws, 'join_room requires a non-empty string userId.');
  }

  // Persist metadata on the socket for use in close/error events.
  ws.userId = userId;
  ws.roomId = roomId;

  const clientCount = roomManager.joinRoom(ws, roomId);

  console.log(`[gateway] user=${userId} joined room=${roomId} (${clientCount} clients)`);

  // Acknowledge the join to the requesting client.
  ws.send(JSON.stringify({ type: 'room_joined', roomId, clientCount }));

  // Notify everyone else in the room.
  roomManager.broadcastToRoom(roomId, { type: 'client_joined', userId, clientCount }, ws);

  // Fire-and-forget: restore canvas state for the joining client.
  // Sent *after* room_joined so the client ACK is never blocked by a DB query.
  // This is the correct pattern for distributed state restoration: the join
  // confirmation is decoupled from the (potentially slow) persistence read.
  fetchRoomChunks(roomId)
    .then((chunks) => {
      // Hydrate the in-memory OCC version map from the persisted DB versions.
      // This is critical on Gateway restart: without hydration, the in-memory
      // version for every chunk defaults to 0, causing every client with a
      // non-zero version to receive a spurious conflict_event.
      for (const chunk of chunks) {
        chunkVersionManager.initChunk(roomId, chunk.chunkId, chunk.version ?? 0);
      }

      if (chunks.length === 0) return; // brand-new room — nothing to restore

      // The canvas_state payload now carries `version` per chunk so the
      // frontend can seed its own chunkVersions map immediately on join,
      // enabling correct OCC payloads from the very first stroke.
      ws.send(JSON.stringify({ type: 'canvas_state', roomId, chunks }));
      console.log(`[gateway] canvas_state sent to user=${userId} — ${chunks.length} chunk(s) restored`);
    })
    .catch((err) => {
      console.error(`[gateway] failed to fetch canvas state for room=${roomId}: ${err.message}`);
    });
}

/**
 * Handles a `stroke_event` from a client, applying Optimistic Concurrency
 * Control (OCC) before accepting the stroke.
 *
 * OCC decision (why not pessimistic locking):
 *  Pessimistic locking would block the event loop on every stroke while
 *  waiting for a lock release, serialising all painters on the same chunk.
 *  OCC assumes conflicts are rare — it validates the client's `version`
 *  against the in-memory counter (a synchronous Map lookup), rejects stale
 *  strokes instantly, and only notifies the affected client.  All other
 *  clients continue painting without any contention overhead.
 *
 * On ACCEPT:
 *  - The in-memory version for the chunk is atomically incremented.
 *  - A `stroke_ack` carrying the new version is sent back to the sender so
 *    it can advance its local chunkVersions map.
 *  - The stroke is broadcast (with the new version) to all other room members
 *    so they also advance their local chunkVersions maps.
 *  - The stroke is queued in the write-batcher for async DB persistence.
 *
 * On REJECT:
 *  - A `conflict_event` is sent back to the sender with the authoritative
 *    version.  The client updates its local version map and can re-paint.
 *    No broadcast is performed — the stroke never lands on other canvases.
 *
 * @param {WebSocket} ws - The client that sent the stroke.
 * @param {object} payload - The parsed message payload.
 * @param {string} payload.roomId - Room the stroke belongs to.
 * @param {string} payload.userId - Author of the stroke.
 * @param {number} payload.x - Horizontal canvas coordinate.
 * @param {number} payload.y - Vertical canvas coordinate.
 * @param {string} payload.color - CSS hex color string.
 * @param {number} payload.brushSize - Brush radius in pixels.
 * @param {number} payload.timestamp - Unix epoch milliseconds.
 * @param {string} payload.chunkId - Canvas chunk identifier (e.g. "0_0").
 * @param {number} payload.version - Client's last-known version for the chunk.
 * @param {object} roomManager - The roomManager module instance.
 */
function handleStrokeEvent(ws, payload, roomManager) {
  const { roomId, userId, x, y, color, brushSize, timestamp, chunkId } = payload;

  const missingFields = ['roomId', 'userId', 'x', 'y', 'color', 'brushSize', 'timestamp', 'chunkId']
    .filter((field) => payload[field] === undefined || payload[field] === null);

  if (missingFields.length > 0) {
    return sendError(ws, `stroke_event is missing required fields: ${missingFields.join(', ')}.`);
  }

  // Treat a missing `version` field as 0 for backwards compatibility with
  // clients that pre-date Phase 5.  In a production rollout this fallback
  // would be removed once all clients are updated.
  const clientVersion = typeof payload.version === 'number' ? payload.version : 0;

  // ── OCC check ────────────────────────────────────────────────────────────
  const { accepted, currentVersion } = chunkVersionManager.tryAcceptStroke(
    roomId,
    chunkId,
    clientVersion
  );

  if (!accepted) {
    // The client's version is stale — another stroke was accepted on this chunk
    // after the client last synced.  Inform the client of the current version
    // so it can reconcile and re-paint if desired.
    console.log(
      `[gateway] conflict rejected stroke — user=${userId} room=${roomId} chunk=${chunkId} ` +
      `clientVersion=${clientVersion} currentVersion=${currentVersion}`
    );

    ws.send(JSON.stringify({
      type: 'conflict_event',
      roomId,
      chunkId,
      rejectedVersion: clientVersion,
      currentVersion,
    }));

    return;
  }

  // ── Accepted ─────────────────────────────────────────────────────────────

  // Acknowledge to the sender with the new authoritative version so it can
  // advance its local chunkVersions map without waiting for its own echo.
  ws.send(JSON.stringify({ type: 'stroke_ack', chunkId, newVersion: currentVersion }));

  // Broadcast the stroke (with its new version) to every OTHER client in the
  // room so they also advance their chunkVersions maps.
  roomManager.broadcastToRoom(
    roomId,
    { type: 'stroke_event', roomId, userId, x, y, color, brushSize, timestamp, chunkId, version: currentVersion },
    ws
  );

  // Queue the accepted stroke for async persistence via the write-batcher.
  // The version is threaded through so the DB mirrors the in-memory state
  // after each flush, enabling correct hydration on Gateway restart.
  writeBatcher.addStroke(roomId, chunkId, { x, y, color, brushSize, userId, timestamp }, currentVersion);

  // Enqueue the stroke in the simulation batcher.  The batcher accumulates
  // strokes over a 150 ms window and publishes a single batched job to
  // RabbitMQ, reducing queue pressure from ~30 jobs/s to ~7 jobs/s.
  // Non-blocking and fire-and-forget: a publish failure here does NOT affect
  // the stroke acceptance or persistence paths.
  simulationBatcher.addStroke(roomId, chunkId, { x, y, color, brushSize, userId, timestamp });
}

/**
 * Entry point for all incoming WebSocket messages.
 * Parses the raw buffer, validates the `type` field, and dispatches
 * to the correct domain handler.
 *
 * @param {WebSocket} ws - The client that sent the message.
 * @param {Buffer|string} rawMessage - The raw WebSocket message data.
 * @param {object} roomManager - The roomManager module instance.
 */
function handleMessage(ws, rawMessage, roomManager) {
  let payload;

  try {
    payload = JSON.parse(rawMessage.toString());
  } catch {
    return sendError(ws, 'Message must be valid JSON.');
  }

  if (!payload.type || typeof payload.type !== 'string') {
    return sendError(ws, 'Message must include a string "type" field.');
  }

  switch (payload.type) {
    case 'join_room':
      handleJoinRoom(ws, payload, roomManager);
      break;

    case 'stroke_event':
      handleStrokeEvent(ws, payload, roomManager);
      break;

    default:
      sendError(ws, `Unknown message type: "${payload.type}".`);
  }
}

module.exports = { handleMessage };
