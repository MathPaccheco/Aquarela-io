/**
 * @file roomManager.js
 * @description Pure state module for managing WebSocket rooms.
 * This module is the single source of truth for room membership.
 * It has NO knowledge of HTTP, WebSocket protocol, or message handling —
 * only Map/Set manipulation. This isolation makes it easy to replace
 * with a Redis-backed implementation in Phase 7 (horizontal scaling).
 */

/**
 * @typedef {import('ws').WebSocket} WebSocket
 */

/** @type {Map<string, Set<WebSocket>>} */
const rooms = new Map();

/**
 * Adds a WebSocket client to a room, creating the room if it doesn't exist.
 *
 * @param {WebSocket} ws - The WebSocket connection to add.
 * @param {string} roomId - The room identifier.
 * @returns {number} The number of clients in the room after joining.
 */
function joinRoom(ws, roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  rooms.get(roomId).add(ws);

  return rooms.get(roomId).size;
}

/**
 * Removes a WebSocket client from its room. Cleans up the room entry
 * if it becomes empty to avoid memory leaks.
 *
 * @param {WebSocket} ws - The WebSocket connection to remove.
 * @param {string} roomId - The room identifier.
 * @returns {number} The number of clients remaining in the room.
 */
function leaveRoom(ws, roomId) {
  if (!rooms.has(roomId)) {
    return 0;
  }

  const room = rooms.get(roomId);
  room.delete(ws);

  if (room.size === 0) {
    rooms.delete(roomId);
    return 0;
  }

  return room.size;
}

/**
 * Broadcasts a serialized JSON message to all clients in a room,
 * optionally excluding the sender.
 *
 * @param {string} roomId - The room to broadcast to.
 * @param {object} message - The message object to serialize and send.
 * @param {WebSocket|null} [excludeWs=null] - A client to exclude from the broadcast (typically the sender).
 * @returns {number} The number of clients the message was sent to.
 */
function broadcastToRoom(roomId, message, excludeWs = null) {
  if (!rooms.has(roomId)) {
    return 0;
  }

  const serialized = JSON.stringify(message);
  let sentCount = 0;

  for (const client of rooms.get(roomId)) {
    if (client === excludeWs) continue;
    if (client.readyState !== 1 /* WebSocket.OPEN */) continue;

    client.send(serialized);
    sentCount++;
  }

  return sentCount;
}

/**
 * Returns the number of clients currently in a room.
 *
 * @param {string} roomId - The room identifier.
 * @returns {number} Client count, or 0 if the room does not exist.
 */
function getRoomSize(roomId) {
  return rooms.has(roomId) ? rooms.get(roomId).size : 0;
}

module.exports = { joinRoom, leaveRoom, broadcastToRoom, getRoomSize };
