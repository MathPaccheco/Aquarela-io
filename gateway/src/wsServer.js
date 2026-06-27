/**
 * @file wsServer.js
 * @description Initializes and wires the WebSocket server onto the existing HTTP server.
 *
 * Responsibilities (SRP):
 *  - Instantiate the `ws` WebSocket server.
 *  - Attach connection lifecycle hooks (connect, message, close, error).
 *  - Delegate all message routing to messageHandler.
 *  - Delegate all room state mutations to roomManager.
 *
 * This module intentionally owns NO business logic — it is purely glue code
 * between the transport layer (ws) and the domain modules.
 */

const { WebSocketServer } = require('ws');
const { handleMessage } = require('./messageHandler');
const roomManager = require('./roomManager');
const chunkVersionManager = require('./chunkVersionManager');

/**
 * Attaches a WebSocket server to an existing Node.js HTTP server instance.
 * All WebSocket upgrade requests are handled automatically by the `ws` library.
 *
 * @param {import('http').Server} httpServer - The HTTP server to attach the WebSocket server to.
 * @returns {WebSocketServer} The initialized WebSocket server instance.
 */
function initWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;

    // Initialize metadata fields used by roomManager and message handlers.
    ws.userId = null;
    ws.roomId = null;

    console.log(`[gateway] client connected from ${clientIp}`);

    ws.on('message', (rawMessage) => {
      handleMessage(ws, rawMessage, roomManager);
    });

    ws.on('close', () => {
      handleClientDisconnect(ws);
    });

    ws.on('error', (err) => {
      console.error(`[gateway] WebSocket error for user=${ws.userId}: ${err.message}`);
      handleClientDisconnect(ws);
    });
  });

  console.log('[gateway] WebSocket server initialized');

  return wss;
}

/**
 * Handles cleanup when a client disconnects (graceful close or error).
 * Removes the client from its room and notifies remaining participants.
 *
 * @param {import('ws').WebSocket} ws - The disconnected client.
 */
function handleClientDisconnect(ws) {
  const { userId, roomId } = ws;

  if (!roomId) {
    // Client disconnected before joining any room — nothing to clean up.
    return;
  }

  const remainingCount = roomManager.leaveRoom(ws, roomId);

  console.log(`[gateway] user=${userId} left room=${roomId} (${remainingCount} clients remaining)`);

  // When the last client leaves the room, evict the in-memory OCC version
  // entries for all of its chunks.  Versions will be re-hydrated from the DB
  // the next time any client joins this room, preventing unbounded memory
  // growth in long-running Gateway processes with many transient rooms.
  if (remainingCount === 0) {
    chunkVersionManager.clearRoom(roomId);
  }

  roomManager.broadcastToRoom(roomId, {
    type: 'client_left',
    userId,
    clientCount: remainingCount,
  });
}

module.exports = { initWsServer };
