#!/usr/bin/env node
// Agent Office bridge: receives Claude Code hook events, serves the 3D office, and streams live state over WebSocket.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { normalize } from './adapters.js';
import { focus, appIcon } from './focus.js';
import { watchMusic } from './music.js';
import { scan } from './discover.js';
import { pollOllama } from './ollama.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const THREE_JS = path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js');
const PORT = Number(process.env.AGENT_OFFICE_PORT || 4747);
const HOST = process.env.AGENT_OFFICE_HOST || '127.0.0.1';
const MAX_BODY = 1024 * 1024;
const APPROVAL_HOLD_MS = 45_000;   // how long a watched office holds a permission request before Claude Code shows its own dialog

// Only this machine's office pages may talk to the bridge. Without this, any website open in a browser
// could reach localhost and approve commands. Hooks (curl) send no Origin header.
const ALLOWED_ORIGINS = new Set(['localhost', '127.0.0.1', '[::1]'].map(h => `http://${h}:${PORT}`));
// Where the hook came from: app, terminal, tty and chat id, for "Open in …" and "Open chat".
const originOf = req => ({ app: req.headers['x-agent-office-app'], term: req.headers['x-agent-office-term'], tty: req.headers['x-agent-office-tty'], chat: req.headers['x-agent-office-chat'] });
const originOk = req => !req.headers.origin || ALLOWED_ORIGINS.has(req.headers.origin);

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

// Pending permission requests, keyed by id: { approval, resolve }.
const pending = new Map();
let seq = 0;
const decisionJson = behavior => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
  decision: behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Denied from Agent Office' } } });

// PermissionRequest hook: hold the request while someone is watching the office, so they can allow or deny it there.
async function handlePermission(req, res, url) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end(); return; }
  const event = store.ingest(body, req.headers['x-agent-office-entrypoint'], req.headers['x-agent-office-project'], 'claude-code', originOf(req));
  if (event) broadcast({ type: 'event', event });
  if (!event || watchers() === 0) { res.writeHead(204); res.end(); return; }   // nobody watching: Claude Code asks as usual
  const id = `a${Date.now().toString(36)}${(++seq).toString(36)}`;
  const approval = { id, sessionId: event.sessionId, agentId: event.agentId, tool: event.tool, summary: event.summary, expiresAt: Date.now() + APPROVAL_HOLD_MS };
  const decision = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('defer'), APPROVAL_HOLD_MS);
    pending.set(id, { approval, resolve: d => { clearTimeout(timer); resolve(d); } });
    res.on('close', () => { if (!res.writableEnded) pending.get(id)?.resolve('defer'); });   // the hook gave up or was cancelled
    broadcast({ type: 'approval', approval });
  });
  pending.delete(id);
  if (decision === 'allow' || decision === 'deny') {
    const e = store.resolveWaiting(event.sessionId, event.agentId, decision === 'allow' ? 'Allowed from the office' : 'Denied from the office');
    if (e) broadcast({ type: 'event', event: e });
  }
  broadcast({ type: 'approval-resolved', id, decision });
  if (decision === 'allow' || decision === 'deny') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(decisionJson(decision)); }
  else { res.writeHead(204); res.end(); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!originOk(req)) { res.writeHead(403); res.end(); return; }
  if (req.method === 'POST' && url.pathname === '/permission') return handlePermission(req, res, url);

  if (req.method === 'POST' && url.pathname === '/hook') {
    try {
      // Other agents (Codex, Cursor, Gemini CLI…) send their own payloads through adapters/hook.sh; translate them to the Claude shape.
      const agent = String(req.headers['x-agent-office-agent'] || url.searchParams.get('agent') || 'claude-code').toLowerCase();
      const payload = normalize(agent, JSON.parse(await readBody(req)), req.headers['x-agent-office-event']);
      const event = payload && store.ingest(payload, req.headers['x-agent-office-entrypoint'], req.headers['x-agent-office-project'], agent, originOf(req));
      if (event) broadcast({ type: 'event', event });
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end(); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/log') {   // page errors and frame rate, for debugging
    try { console.error('[office page]', (await readBody(req)).slice(0, 2000)); } catch {}
    res.writeHead(204); res.end(); return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/face/')) { req.resume(); res.writeHead(204); res.end(); return; }   // only the desktop app's banners use faces
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (url.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(snapshot())); return; }
  if (url.pathname === '/vendor/three.min.js') return sendFile(res, THREE_JS);
  if (url.pathname.startsWith('/api/app-icon/')) {               // real app icons for floor signs and the agent list
    const png = await appIcon(decodeURIComponent(url.pathname.slice(14)).replace(/\.png$/, ''));
    if (!png) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); res.end(png); return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); res.end(); return; }
  sendFile(res, file);
});

const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => originOk(req) });
let music = null;                                               // what the rooftop DJ plays: your Spotify or Apple Music song
const snapshot = () => ({ ...store.snapshot(), approvals: [...pending.values()].map(p => p.approval), music, musicSupported: process.platform === 'darwin' });
// Office pages report whether they're visible; requests are only held while at least one is.
const watchers = () => [...wss.clients].filter(c => c.readyState === 1 && c.visible).length;
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'snapshot', ...snapshot() }));
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'presence') ws.visible = !!msg.visible;
    if (msg.type === 'music') ws.music = !!msg.on;                // the viewer turned "Play my music" on or off at the rooftop
    if (msg.type === 'focus') {                                    // "Open in …" from the agent card
      const s = store.sessions.get(msg.sessionId);
      (s ? focus(s) : Promise.reject(new Error('That session has ended')))
        .then(message => ws.send(JSON.stringify({ type: 'focus-result', ok: true, message })))
        .catch(err => ws.send(JSON.stringify({ type: 'focus-result', ok: false, message: err.message })));
    }
    if (msg.type === 'decide' && pending.has(msg.id) && ['allow', 'deny', 'defer'].includes(msg.decision)) pending.get(msg.id).resolve(msg.decision);
  });
});
// Models Ollama has loaded are agents too (ollama.js); one walks out as soon as Ollama unloads it.
async function syncOllama() {
  const found = await pollOllama();
  for (const f of found) { const e = store.adopt(f); if (e) broadcast({ type: 'event', event: e }); }
  for (const id of store.retire('ollama', found.map(f => f.id))) broadcast({ type: 'event', event: { type: 'SessionEnd', sessionId: id, at: Date.now(), reason: 'Ollama unloaded the model' } });
}
// Chats that were already running move in from their logs (discover.js); keep the ones no hook reports on up to date,
// and walk out the ones whose log went quiet.
for (const f of scan()) store.adopt(f);
syncOllama();
setInterval(() => {
  for (const f of scan()) { const e = store.adopt(f); if (e) broadcast({ type: 'event', event: e }); }
  syncOllama();
  const before = [...store.sessions.keys()]; store.prune();
  for (const id of before) if (!store.sessions.has(id)) broadcast({ type: 'event', event: { type: 'SessionEnd', sessionId: id, at: Date.now(), reason: 'No news for a while' } });
}, 10_000).unref();
watchMusic(m => { music = m; broadcast({ type: 'music', music }); }, () => [...wss.clients].some(c => c.readyState === 1 && c.music));

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is Agent Office already running? Set AGENT_OFFICE_PORT to use another port.`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Agent Office is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log('Waiting for Claude Code sessions (desktop app or terminal)…');
});
