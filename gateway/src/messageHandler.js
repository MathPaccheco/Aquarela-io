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
      if (chunks.length === 0) return; // brand-new room — nothing to restore
      ws.send(JSON.stringify({ type: 'canvas_state', roomId, chunks }));
      console.log(`[gateway] canvas_state sent to user=${userId} — ${chunks.length} chunk(s) restored`);
    })
    .catch((err) => {
      console.error(`[gateway] failed to fetch canvas state for room=${roomId}: ${err.message}`);
    });
}

/**
 * Handles a `stroke_event` from a client.
 * Validates the minimum required fields and broadcasts the stroke to all
 * other participants in the same room.
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
 * @param {object} roomManager - The roomManager module instance.
 */
function handleStrokeEvent(ws, payload, roomManager) {
  const { roomId, userId, x, y, color, brushSize, timestamp, chunkId } = payload;

  const missingFields = ['roomId', 'userId', 'x', 'y', 'color', 'brushSize', 'timestamp', 'chunkId']
    .filter((field) => payload[field] === undefined || payload[field] === null);

  if (missingFields.length > 0) {
    return sendError(ws, `stroke_event is missing required fields: ${missingFields.join(', ')}.`);
  }

  // Broadcast the full original payload to every OTHER client in the room.
  roomManager.broadcastToRoom(roomId, { type: 'stroke_event', roomId, userId, x, y, color, brushSize, timestamp, chunkId }, ws);

  // Accumulate the stroke for async persistence via the write-batcher.
  // We persist only the fields needed for canvas restoration and Phase 6
  // fluid-simulation processing — not the full broadcast payload.
  writeBatcher.addStroke(roomId, chunkId, { x, y, color, brushSize, userId, timestamp });
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
