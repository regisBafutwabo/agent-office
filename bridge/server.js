#!/usr/bin/env node
// Agent Office bridge: receives Claude Code hook events, serves the 3D office, and streams live state over WebSocket.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { normalize } from './adapters.js';
import { focus, appIcon } from './focus.js';
import { watchMusic } from './music.js';
import { scan, archivedChats } from './discover.js';
import { pollOllama } from './ollama.js';
import { listPacks, packFile, packsFolder, openPacksFolder, PACK_HEADERS } from './packs.js';
import { changes, fileDiff, rootOf } from './changes.js';
import { credentials, dataDir, same, hostOk, originOk, bearer, hookToken, wsToken, redeemLoginCode, WS_PROTOCOL } from './auth.js';
import { outdatedPlugin } from './upgrade.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const THREE_JS = path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js');
const THREE_EXAMPLES = path.join(ROOT, 'node_modules', 'three', 'examples', 'js');
const VENDOR = { '/vendor/GLTFLoader.js': path.join(THREE_EXAMPLES, 'loaders', 'GLTFLoader.js'), '/vendor/SkeletonUtils.js': path.join(THREE_EXAMPLES, 'utils', 'SkeletonUtils.js') };
const PORT = Number(process.env.AGENT_OFFICE_PORT || 4747);
const HOST = process.env.AGENT_OFFICE_HOST || '127.0.0.1';
const MAX_BODY = 1024 * 1024;
const APPROVAL_HOLD_MS = 45_000;   // how long a watched office holds a permission request before Claude Code shows its own dialog

const MAX_WS_MESSAGE = 64 * 1024;
// The office's keys travel in plain HTTP, so it only listens on this machine. To reach it from another device, use an
// encrypted tunnel that ends here (ssh -L 4747:127.0.0.1:4747 this-mac), which keeps Host as localhost.
const LOOPBACK = h => h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
if (!LOOPBACK(HOST)) {
  console.error(`Agent Office only listens on this computer (127.0.0.1, ::1 or localhost), not ${HOST}: its keys would cross the network unencrypted. To use it from another device, forward the port over SSH instead (ssh -L ${PORT}:127.0.0.1:${PORT} <this computer>).`);
  process.exit(1);
}
// Only this office's pages, holding its key, may read it or answer for you; hooks hold their own, narrower key
// (auth.js). Host must name this office, so a rebound web domain is refused even before the key is checked.
const DATA = dataDir();
const CREDS = credentials(DATA);
const EXTRA_HOSTS = [HOST, ...(process.env.AGENT_OFFICE_ALLOWED_HOSTS || '').split(',')].map(h => h.trim().toLowerCase()).filter(h => h && h !== '0.0.0.0' && h !== '::');
const addressedHere = req => hostOk(req.headers.host, PORT, EXTRA_HOSTS) && originOk(req.headers.origin, req.headers.host);
const isPage = req => same(bearer(req), CREDS.ui);
const isHook = req => same(hookToken(req), CREDS.hook);
// Where the hook came from: app, terminal, tty and chat id, for "Open in …" and "Open chat".
const originOf = req => ({ app: req.headers['x-agent-office-app'], term: req.headers['x-agent-office-term'], tty: req.headers['x-agent-office-tty'], chat: req.headers['x-agent-office-chat'], t3Thread: req.headers['x-agent-office-t3-thread'] });

const store = new Store();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };

// The office page may not be framed by other sites (its buttons approve commands), and runs only its own scripts:
// the inline ones it shipped with (by hash) and files from this office, so markup that slips into the page can't run
// code or read its key. desktop/src-tauri/src/server.rs sends the same policy.
const inlineScriptHashes = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
const pagePolicy = (html, host) => [
  "default-src 'self'", `script-src 'self' ${inlineScriptHashes(html).join(' ')}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:", `connect-src 'self' ws://${host} data: blob:`, "media-src 'self' data: blob:", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
function sendFile(res, file, headers = {}, req) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const page = type.startsWith('text/html') ? { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': pagePolicy(buf.toString('utf8'), req.headers.host) } : {};
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...page, ...headers });
    res.end(buf);
  });
}
const deny = (req, res, code) => { req.resume(); res.writeHead(code); res.end(); };

// Hooks installed before the office had keys send none, so their events are refused (401, with an empty body, so
// an old permission hook prints nothing and Claude Code asks as usual). Say so, once per kind of hook, here and in
// every office page, so updating doesn't silently empty the office. Nothing the request carried is kept but which
// agent it named.
const outdatedHooks = new Map();
function refusedHook(req, url) {
  const named = String(req.headers['x-agent-office-agent'] || url.searchParams.get('agent') || 'claude-code').toLowerCase();
  const agent = /^[a-z0-9-]{1,32}$/.test(named) ? named : 'unknown', reason = hookToken(req) ? 'wrong-key' : 'no-key', k = `${agent}|${reason}`;
  const seen = outdatedHooks.get(k);
  if (seen) { seen.count++; seen.at = Date.now(); return; }
  if (outdatedHooks.size >= 16) return;
  outdatedHooks.set(k, { agent, reason, count: 1, at: Date.now() });
  console.warn(reason === 'no-key'
    ? `[office] Refused ${agent} events sent without the office's key: those hooks predate it. ${agent === 'claude-code' ? 'Update the plugin (claude plugin marketplace update agent-office && claude plugin update agent-office@agent-office) and start a new session.' : 'Reconnect them from Connect agents, or git pull if they run this repo\'s adapters/hook.sh.'}`
    : `[office] Refused ${agent} events sent with a key this office doesn't know. If you set AGENT_OFFICE_DATA, set it for your agents too.`);
  broadcast({ type: 'hooks-outdated', hooks: [...outdatedHooks.values()] });
}
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

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
  if (!isObject(body)) { res.writeHead(400); res.end(); return; }
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

// No request, however malformed, may stop the office: errors answer that request and nothing else.
const server = http.createServer((req, res) => handle(req, res).catch(err => {
  console.error('[office] request failed:', err && err.message);
  if (!res.headersSent) res.writeHead(err instanceof URIError ? 400 : 500);
  res.end();
}));
async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!addressedHere(req)) return deny(req, res, 403);
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && (url.pathname === '/permission' || url.pathname === '/hook') && !isHook(req)) { refusedHook(req, url); return deny(req, res, 401); }
  if (req.method === 'POST' && url.pathname === '/permission') return handlePermission(req, res, url);

  if (req.method === 'POST' && url.pathname === '/hook') {
    try {
      // Other agents (Codex, Cursor, Gemini CLI…) send their own payloads through adapters/hook.sh; translate them to the Claude shape.
      const agent = String(req.headers['x-agent-office-agent'] || url.searchParams.get('agent') || 'claude-code').toLowerCase();
      const raw = JSON.parse(await readBody(req));
      if (!isObject(raw)) throw new Error('not an object');
      const payload = normalize(agent, raw, req.headers['x-agent-office-event']);
      const event = payload && store.ingest(payload, req.headers['x-agent-office-entrypoint'], req.headers['x-agent-office-project'], agent, originOf(req));
      if (event) broadcast({ type: 'event', event });
      res.writeHead(204); res.end();
    } catch { res.writeHead(400); res.end(); }
    return;
  }
  // The desktop app's "Open in browser" link carries a one-time code (auth.js) that any office holding the port redeems.
  if (req.method === 'POST' && url.pathname === '/api/login') {
    let code; try { code = JSON.parse(await readBody(req))?.code; } catch {}
    if (!redeemLoginCode(code, DATA)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ token: CREDS.ui })); return;
  }
  // Everything else under /api/ but app icons (plain <img> tags, nothing private) needs the page's key.
  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/app-icon/') && !isPage(req)) return deny(req, res, 401);
  if (req.method === 'POST' && url.pathname === '/api/log') {   // page errors and frame rate, for debugging
    try { console.error('[office page]', (await readBody(req)).slice(0, 2000)); } catch {}
    res.writeHead(204); res.end(); return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/face/')) { req.resume(); res.writeHead(204); res.end(); return; }   // only the desktop app's banners use faces
  if (req.method === 'POST' && url.pathname === '/api/packs/open') { req.resume(); res.writeHead(openPacksFolder() ? 204 : 500); res.end(); return; }
  if (req.method !== 'GET') return deny(req, res, 405);
  if (url.pathname === '/api/auth') { res.writeHead(204); res.end(); return; }   // the page asks whether its key still works
  if (url.pathname === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(snapshot())); return; }
  if (url.pathname === '/vendor/three.min.js') return sendFile(res, THREE_JS);
  if (VENDOR[url.pathname]) return sendFile(res, VENDOR[url.pathname]);
  if (url.pathname === '/api/changes' || url.pathname === '/api/changes/diff') {   // what a session's checkout holds, for its card
    const s = store.sessions.get(url.searchParams.get('session')), json = body => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!s) return json({ ok: false, error: 'That session has ended' });
    if (url.pathname.endsWith('/diff')) return json(store.showCode ? await fileDiff(s.cwd, url.searchParams.get('path')) : { ok: false, error: 'Code is hidden in Customize' });
    const c = await changes(s.cwd);
    if (c.ok) { const others = [...store.sessions.values()].filter(o => o !== s); c.shared = (await Promise.all(others.map(async o => await rootOf(o.cwd) === c.root ? o.id : null))).filter(Boolean); }
    return json(c);
  }
  if (url.pathname === '/api/packs/folder') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(packsFolder())); return; }
  if (url.pathname === '/api/packs') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(listPacks())); return; }
  if (url.pathname.startsWith('/packs/')) { const p = packFile(url.pathname); if (!p) { res.writeHead(403); res.end(); return; } return sendFile(res, p.file, { ...PACK_HEADERS, 'Content-Type': p.type }); }
  if (url.pathname.startsWith('/api/app-icon/')) {               // real app icons for floor signs and the agent list
    const png = await appIcon(decodeURIComponent(url.pathname.slice(14)).replace(/\.png$/, ''));
    if (!png) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' }); res.end(png); return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.resolve(WEB, rel);
  if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); res.end(); return; }
  sendFile(res, file, {}, req);
}

// The page offers its key as a subprotocol (browsers can't set headers on a WebSocket); hooks' key doesn't open it.
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_MESSAGE,
  verifyClient: ({ req }) => addressedHere(req) && same(wsToken(req), CREDS.ui),
  handleProtocols: protocols => protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false });
let music = null;                                               // what the rooftop DJ plays: your Spotify or Apple Music song
const snapshot = () => ({ ...store.snapshot(), showCode: store.showCode, approvals: [...pending.values()].map(p => p.approval), music, musicSupported: process.platform === 'darwin', outdatedHooks: [...outdatedHooks.values()] });
// Office pages report whether they're visible; requests are only held while at least one is.
const watchers = () => [...wss.clients].filter(c => c.readyState === 1 && c.visible).length;
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
wss.on('connection', ws => {
  ws.on('error', () => ws.terminate());                          // a malformed frame ends that connection, not the office
  ws.send(JSON.stringify({ type: 'snapshot', ...snapshot() }));
  ws.on('message', (raw, binary) => {
    let msg; try { msg = binary ? null : JSON.parse(raw); } catch { return; }
    if (!isObject(msg) || typeof msg.type !== 'string') return;
    if (msg.type === 'presence') ws.visible = !!msg.visible;
    if (msg.type === 'code') {                                     // "Show code" in Customize: off drops what was kept, too
      store.showCode = !!msg.show; if (!store.showCode) for (const e of store.recent) delete e.edit;
      broadcast({ type: 'code', show: store.showCode });
    }
    if (msg.type === 'music') ws.music = !!msg.on;                // the viewer turned "Play my music" on or off at the rooftop
    if (msg.type === 'focus') {                                    // "Open in …" from the agent card
      const s = typeof msg.sessionId === 'string' ? store.sessions.get(msg.sessionId) : null;
      (s ? focus(s) : Promise.reject(new Error('That session has ended')))
        .then(message => ws.send(JSON.stringify({ type: 'focus-result', ok: true, message })))
        .catch(err => ws.send(JSON.stringify({ type: 'focus-result', ok: false, message: err.message })));
    }
    if (msg.type === 'rescan') { rescan(); ws.send(JSON.stringify({ type: 'rescanned' })); }
    if (msg.type === 'decide' && typeof msg.id === 'string' && pending.has(msg.id) && ['allow', 'deny', 'defer'].includes(msg.decision)) pending.get(msg.id).resolve(msg.decision);
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
for (const f of scan()) { store.adopt(f); store.adoptSubs(f); }
syncOllama();
// One pass over the logs; also run right away when an empty office asks to "Check again".
function rescan() {
  for (const f of scan()) { const e = store.adopt(f); for (const x of [e, ...store.adoptSubs(f)]) if (x) broadcast({ type: 'event', event: x }); }
  for (const id of store.dropArchived(archivedChats())) broadcast({ type: 'event', event: { type: 'SessionEnd', sessionId: id, at: Date.now(), reason: 'Archived in the Claude app' } });
  syncOllama();
  const before = [...store.sessions.keys()]; store.prune();
  for (const id of before) if (!store.sessions.has(id)) broadcast({ type: 'event', event: { type: 'SessionEnd', sessionId: id, at: Date.now(), reason: 'No news for a while' } });
}
// AGENT_OFFICE_SCAN_MS only exists so browser tests can keep this timer out of their way.
setInterval(rescan, Number(process.env.AGENT_OFFICE_SCAN_MS) || 10_000).unref();
watchMusic(m => { music = m; broadcast({ type: 'music', music }); }, () => [...wss.clients].some(c => c.readyState === 1 && c.music));

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Is Agent Office already running? Set AGENT_OFFICE_PORT to use another port.`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const here = `http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;
  console.log(`Agent Office is running at ${here}`);
  // The key rides in the fragment, which never reaches a server or a log; the page keeps it and drops it from the address.
  console.log(`Open it with its key (keep this link to yourself): ${here}/#k=${CREDS.ui}`);
  console.log('Waiting for Claude Code sessions (desktop app or terminal)…');
  const old = outdatedPlugin();
  if (old) console.warn(`[office] The Agent Office plugin for Claude Code is ${old}, which can't report to this office. Update it: claude plugin marketplace update agent-office && claude plugin update agent-office@agent-office, then start new sessions.`);
});
