/**
 * BrowserCoin WebRTC signaling helper.
 *
 * Role: PeerJS WebSocket signaling. NO chain state, NO HTTP API endpoints.
 * Pure WebRTC handshake brokering — clients connect via WebSocket, exchange
 * SDP offer/answer + ICE candidates, then form direct browser-to-browser
 * RTCDataChannels that are completely independent of this server. Once a
 * connection is established, killing this server doesn't affect it at all.
 *
 * Lives in its own process so a crash or restart of the chain backup helper
 * (`server/api.ts`) doesn't take down signaling, and vice versa.
 */

import express from 'express';
import http from 'node:http';
import { ExpressPeerServer } from 'peer';
import { parsePort } from './lib/cli.js';

const PORT = parsePort(9001);

const app = express();
const server = http.createServer(app);

const peerServer = ExpressPeerServer(server, {
  path: '/',
  allow_discovery: true,
});

let connectedCount = 0;

peerServer.on('connection', (client: { getId(): string }) => {
  connectedCount++;
  const id = client.getId();
  console.log(`[peer] connect ${id} (total=${connectedCount})`);
});
peerServer.on('disconnect', (client: { getId(): string }) => {
  connectedCount = Math.max(0, connectedCount - 1);
  const id = client.getId();
  console.log(`[peer] disconnect ${id} (total=${connectedCount})`);
});

app.use('/peerjs', peerServer);

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    [
      'BrowserCoin WebRTC signaling helper',
      `currently signaling: ${connectedCount} client${connectedCount === 1 ? '' : 's'}`,
      '',
      'This service brokers WebRTC handshakes only. Chain backup, peer',
      'discovery, and heartbeat live on a separate API helper.',
      '',
      'endpoint:',
      `  ws://localhost:${PORT}/peerjs   — PeerJS signaling`,
    ].join('\n'),
  );
});

server.listen(PORT, () => {
  console.log(`BrowserCoin signaling helper listening on :${PORT}`);
  console.log(`  PeerJS signaling: ws://localhost:${PORT}/peerjs`);
});
