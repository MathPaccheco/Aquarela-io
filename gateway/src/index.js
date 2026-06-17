/**
 * @file index.js
 * @description Gateway entry point — bootstraps the HTTP/WebSocket server.
 * Full implementation is added in Phase 1 (WebSocket + Rooms).
 */

require('dotenv').config();

const http = require('http');

const PORT = process.env.GATEWAY_PORT || 3000;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'aquarela-gateway' }));
});

server.listen(PORT, () => {
  console.log(`[gateway] HTTP server listening on port ${PORT}`);
});
