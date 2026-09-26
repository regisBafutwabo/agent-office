#!/usr/bin/env node
// Agent Office bridge: receives Claude Code hook events, serves the 3D office, and streams live state over WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const THREE_JS = path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js');
const PORT = Number(process.env.AGENT_OFFICE_PORT || 4747);
const HOST = process.env.AGENT_OFFICE_HOST || '127.0.0.1';
const MAX_BODY = 1024 * 1024;

const store = new Store();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/hook') {
    try {
      const payload = JSON.parse(await readBody(req));
      const event = store.ingest(payload, req.headers['x-agent-office-entrypoint'], req.headers['x-agent-office-project']);
      if (event) broadcast({ type: 'event', event });
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end(); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/log') {   // page errors and frame rate, for debugging
    try { console.error('[office page]', (await readBody(req)).slice(0, 2000)); } catch {}
    res.writeHead(204); res.end(); return;
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (url.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(store.snapshot())); return; }
  if (url.pathname === '/vendor/three.min.js') return sendFile(res, THREE_JS);

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); res.end(); return; }
  sendFile(res, file);
});

const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
wss.on('connection', ws => ws.send(JSON.stringify({ type: 'snapshot', ...store.snapshot() })));
setInterval(() => store.prune(), 60_000).unref();

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is Agent Office already running? Set AGENT_OFFICE_PORT to use another port.`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Agent Office is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log('Waiting for Claude Code sessions (desktop app or terminal)…');
});
