// The bridge as a separate process with its own HOME, data folder, packs and port: who may read it, who may
// answer for you, and that no request can stop it. Never touches a running office.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const SERVER = fileURLToPath(new URL('./server.js', import.meta.url));
let root, data, port, child, ui, hook, repo, outside;

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const page = (h = {}) => ({ authorization: `Bearer ${ui}`, ...h });
const hookHeaders = (h = {}) => ({ 'x-agent-office-token': hook, 'content-type': 'application/json', ...h });
const sendHook = (payload, h) => request('POST', '/hook', { headers: hookHeaders(h), body: JSON.stringify(payload) });
const alive = async () => assert.equal((await request('GET', '/api/auth', { headers: page() })).status, 204);
function socket({ key = ui, origin, host } = {}) {
  const headers = { host: host || `127.0.0.1:${port}` }; if (origin) headers.origin = origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, key ? ['agent-office', `agent-office.token.${key}`] : ['agent-office'], { headers });
  const messages = []; ws.on('message', m => messages.push(JSON.parse(m)));
  const opened = new Promise(resolve => { ws.on('open', () => resolve({ ok: true })); ws.on('unexpected-response', (_, res) => resolve({ ok: false, status: res.statusCode })); ws.on('error', () => resolve({ ok: false })); });
  const next = type => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${type}`)), 5000);
    const check = () => { const m = messages.find(x => x.type === type); if (m) { clearTimeout(t); resolve(m); } else setTimeout(check, 20); }; check();
  });
  return { ws, opened, next };
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-server-')));
  data = path.join(root, 'data'); port = await freePort();
  // A checkout with a changed, an unchanged, an ignored and an untracked file, and an untracked symlink out of it.
  repo = path.join(root, 'repo'); outside = path.join(root, 'outside.txt');
  fs.mkdirSync(repo); fs.writeFileSync(outside, 'AUDIT_FIXTURE_ONLY outside the checkout\n');
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'changed.txt'), 'one\n'); fs.writeFileSync(path.join(repo, 'same.txt'), 'AUDIT_FIXTURE_ONLY unchanged\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.env\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(repo, 'changed.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'secret.env'), 'AUDIT_FIXTURE_ONLY ignored\n');
  fs.writeFileSync(path.join(repo, 'new.txt'), 'brand new\n');
  fs.symlinkSync(outside, path.join(repo, 'escape.txt'));
  // A pack with a model, plus things a malicious pack might carry.
  const pack = path.join(root, 'packs', 'kit'); fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, 'pack.json'), JSON.stringify({ name: 'Kit', slots: { sofa: { model: 'sofa.glb' } } }));
  fs.writeFileSync(path.join(pack, 'sofa.glb'), 'glTF-fixture');
  fs.writeFileSync(path.join(pack, 'evil.html'), '<script>fetch("/api/state")</script>');
  fs.writeFileSync(path.join(pack, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(root, 'outside.png'), 'AUDIT_FIXTURE_ONLY');
  fs.symlinkSync(path.join(root, 'outside.png'), path.join(pack, 'escape.png'));

  const home = path.join(root, 'home'); fs.mkdirSync(home);
  child = spawn(process.execPath, [SERVER], { env: { ...process.env, HOME: home, AGENT_OFFICE_DATA: data, AGENT_OFFICE_PACKS: path.join(root, 'packs'), AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 100 && !/#k=/.test(out); i++) await new Promise(r => setTimeout(r, 50));
  ui = fs.readFileSync(path.join(data, 'ui-token'), 'utf8').trim();
  hook = fs.readFileSync(path.join(data, 'hook-token'), 'utf8').trim().split(': ')[1];
  assert.ok(out.includes(`#k=${ui}`), out);
  assert.equal((await sendHook({ hook_event_name: 'SessionStart', session_id: 'sec-test', cwd: repo })).status, 204);
});
after(() => { child?.kill(); fs.rmSync(root, { recursive: true, force: true }); });

test('reading the office needs the page key; the hook key and no key are refused', async () => {
  assert.equal((await request('GET', '/api/state')).status, 401);
  assert.equal((await request('GET', '/api/state', { headers: { authorization: `Bearer ${hook}` } })).status, 401);
  assert.equal((await request('GET', '/api/state', { headers: { 'x-agent-office-token': hook } })).status, 401);
  assert.equal((await request('GET', '/api/state', { headers: { authorization: 'Bearer ' + 'f'.repeat(64) } })).status, 401);
  for (const url of ['/api/changes?session=sec-test', '/api/changes/diff?session=sec-test&path=changed.txt', '/api/packs', '/api/auth'])
    assert.equal((await request('GET', url)).status, 401, url);
  assert.equal((await request('POST', '/api/log', { body: 'x' })).status, 401);
  const state = await request('GET', '/api/state', { headers: page() });
  assert.equal(state.status, 200);
  assert.ok(state.json().sessions.some(s => s.id === 'sec-test'));
});

test('only the hook key may report events', async () => {
  const ev = { hook_event_name: 'UserPromptSubmit', session_id: 'sec-test', cwd: repo, prompt: 'hi' };
  assert.equal((await request('POST', '/hook', { body: JSON.stringify(ev) })).status, 401);
  assert.equal((await request('POST', '/hook', { headers: page(), body: JSON.stringify(ev) })).status, 401);
  assert.equal((await request('POST', '/permission', { body: JSON.stringify(ev) })).status, 401);
  assert.equal((await sendHook(ev)).status, 204);
});

test('a foreign Host or Origin is refused even with the key', async () => {
  for (const host of ['evil.example:' + port, `localhost.evil.example:${port}`, `127.0.0.1:${port + 1}`, 'localhost'])
    assert.equal((await request('GET', '/api/state', { headers: page({ host }) })).status, 403, host);
  assert.equal((await request('GET', '/', { headers: { host: 'rebind.example:' + port } })).status, 403);
  assert.equal((await sendHook({ hook_event_name: 'Stop', session_id: 'x' }, { host: 'evil.example:' + port })).status, 403);
  for (const origin of ['http://evil.example', `http://localhost:${port + 1}`, 'null'])
    assert.equal((await request('GET', '/api/state', { headers: page({ origin }) })).status, 403, origin);
  assert.equal((await request('GET', '/api/state', { headers: page({ host: `localhost:${port}`, origin: `http://localhost:${port}` }) })).status, 200);
  assert.equal((await request('GET', '/api/state', { headers: page({ host: `192.168.7.7:${port}` }) })).status, 200);   // a phone on the LAN
});

test('the page itself is public, carries no key, and cannot be framed', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(ui) && !r.text.includes(hook));
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('the WebSocket needs the page key and this office as Origin', async () => {
  for (const opts of [{ key: null }, { key: hook }, { key: 'f'.repeat(64) }, { origin: 'http://evil.example' }, { origin: `http://localhost:${port + 1}` }, { host: 'evil.example:' + port }]) {
    const s = socket(opts); const r = await s.opened; s.ws.terminate();
    assert.equal(r.ok, false, JSON.stringify(opts));
  }
  const s = socket({ origin: `http://127.0.0.1:${port}` });
  assert.equal((await s.opened).ok, true);
  assert.equal(s.ws.protocol, 'agent-office');
  assert.ok(Array.isArray((await s.next('snapshot')).approvals));
  s.ws.close();
});

test('a held permission request is answered only by a page with the key', async () => {
  const watcher = socket(); await watcher.opened; await watcher.next('snapshot');
  watcher.ws.send(JSON.stringify({ type: 'presence', visible: true }));
  await new Promise(r => setTimeout(r, 100));
  const answer = request('POST', '/permission', { headers: hookHeaders(), body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'sec-test', cwd: repo, tool_name: 'Bash', tool_input: { command: 'echo AUDIT_FIXTURE_ONLY' } }) });
  const { approval } = await watcher.next('approval');
  const intruder = socket({ key: hook }); assert.equal((await intruder.opened).ok, false); intruder.ws.terminate();
  watcher.ws.send(JSON.stringify({ type: 'decide', id: approval.id, decision: 'deny' }));
  const r = await answer;
  assert.equal(r.status, 200);
  assert.equal(r.json().hookSpecificOutput.decision.behavior, 'deny');
  watcher.ws.close();
});

test('nobody watching: a permission request falls back to Claude Code at once', async () => {
  const r = await request('POST', '/permission', { headers: hookHeaders(), body: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'sec-test', cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }) });
  assert.equal(r.status, 204);
});

test('malformed URLs, bodies and socket messages are refused without stopping the office', async () => {
  assert.equal((await request('GET', '/%ZZ')).status, 400);
  assert.equal((await request('GET', '/api/app-icon/%ZZ.png')).status, 400);
  assert.equal((await request('GET', '/packs/kit/%ZZ')).status, 403);
  await alive();
  for (const body of ['{', 'null', '5', '"x"', '[1]', ''])
    assert.equal((await request('POST', '/hook', { headers: hookHeaders(), body })).status, 400, body);
  for (const body of ['{', 'null', '[]'])
    assert.equal((await request('POST', '/permission', { headers: hookHeaders(), body })).status, 400, body);
  await alive();
  const s = socket(); await s.opened; await s.next('snapshot');
  for (const m of ['null', '5', '"x"', '[]', '{"type":5}', '{"type":"focus","sessionId":{"a":1}}', '{"type":"decide","id":{"x":1},"decision":"allow"}', 'not json']) s.ws.send(m);
  s.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  await new Promise(r => setTimeout(r, 200));
  await alive();
  const closed = new Promise(r => s.ws.on('close', r));
  s.ws.send('x'.repeat(70 * 1024));                                   // over the message limit: this socket ends
  await closed;
  await alive();
});

test('a diff is only for a file the card lists: not unchanged, ignored, or a symlink out of the checkout', async () => {
  const diff = async p => (await request('GET', `/api/changes/diff?session=sec-test&path=${encodeURIComponent(p)}`, { headers: page() })).json();
  const ok = await diff('changed.txt');
  assert.equal(ok.ok, true); assert.match(ok.text, /^\+two$/m);
  assert.match((await diff('new.txt')).text, /^\+brand new$/m);
  for (const p of ['same.txt', 'secret.env', '.git/config', '../outside.txt', outside, '']) {
    const d = await diff(p);
    assert.equal(d.ok, false, p); assert.ok(!JSON.stringify(d).includes('AUDIT_FIXTURE_ONLY'), p);
  }
  const link = await diff('escape.txt');
  assert.ok(!JSON.stringify(link).includes('AUDIT_FIXTURE_ONLY'));
  const list = (await request('GET', '/api/changes?session=sec-test', { headers: page() })).json();
  assert.deepEqual(list.files.map(f => f.path).sort(), ['changed.txt', 'escape.txt', 'new.txt']);
});

test('packs serve models and textures only, inert, and never through a symlink out', async () => {
  const glb = await request('GET', '/packs/kit/sofa.glb');
  assert.equal(glb.status, 200);
  assert.equal(glb.headers['content-type'], 'model/gltf-binary');
  assert.equal(glb.headers['x-content-type-options'], 'nosniff');
  assert.match(glb.headers['content-security-policy'], /sandbox/);
  for (const p of ['/packs/kit/evil.html', '/packs/kit/evil.svg', '/packs/kit/pack.json', '/packs/kit/escape.png'])
    assert.equal((await request('GET', p)).status, 403, p);
  const up = await request('GET', '/packs/kit/%2e%2e/%2e%2e/outside.png');   // the URL parser resolves the dots first: not a pack file at all
  assert.notEqual(up.status, 200); assert.ok(!up.text.includes('AUDIT_FIXTURE_ONLY'));
  assert.equal((await request('GET', '/api/packs', { headers: page() })).json()[0].id, 'kit');
});

test('a one-time code from the desktop app signs a browser in here too, once', async () => {
  // The desktop app's format (desktop/src-tauri/src/auth.rs): an empty 0600 file named by the code's SHA-256.
  const code = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.join(data, 'login-codes'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(data, 'login-codes', crypto.createHash('sha256').update(code).digest('hex')), '', { mode: 0o600 });
  const login = c => request('POST', '/api/login', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c }) });
  const r = await login(code);
  assert.equal(r.status, 200);
  assert.equal(r.json().token, ui);
  assert.equal((await login(code)).status, 401, 'a code works once');
  for (const c of ['0'.repeat(64), 'nope', null]) assert.equal((await login(c)).status, 401);
  assert.equal((await request('POST', '/api/login', { body: '{' })).status, 401);
  const late = crypto.randomBytes(32).toString('hex'), lateFile = path.join(data, 'login-codes', crypto.createHash('sha256').update(late).digest('hex'));
  fs.writeFileSync(lateFile, '', { mode: 0o600 }); const old = new Date(Date.now() - 120_000); fs.utimesSync(lateFile, old, old);
  assert.equal((await login(late)).status, 401, 'an expired code is refused');
  assert.equal((await login(code)).status, 401);
  assert.equal((await request('POST', '/api/login', { headers: { host: 'evil.example:' + port }, body: JSON.stringify({ code }) })).status, 403);
});

test('hooks without the key are refused with an empty body, and the office says they need updating', async () => {
  const watcher = socket(); await watcher.opened; await watcher.next('snapshot');
  watcher.ws.send(JSON.stringify({ type: 'presence', visible: true }));
  await new Promise(r => setTimeout(r, 100));
  const ev = { hook_event_name: 'PermissionRequest', session_id: 'old-hook', cwd: repo, tool_name: 'Bash', tool_input: { command: 'echo AUDIT_FIXTURE_ONLY' } };
  // An old permission.sh prints whatever the office answers; an empty answer means Claude Code asks as usual.
  const refused = await request('POST', '/permission', { headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) });
  assert.equal(refused.status, 401); assert.equal(refused.text, '');
  // Earlier tests already sent keyless Claude Code events, so the first notice of a new kind is a Gemini one.
  await request('POST', '/hook', { headers: { 'content-type': 'application/json', 'x-agent-office-agent': 'gemini' }, body: JSON.stringify(ev) });
  const notice = await watcher.next('hooks-outdated');
  assert.deepEqual(notice.hooks.map(h => `${h.agent}/${h.reason}`).sort(), ['claude-code/no-key', 'gemini/no-key']);
  assert.ok(!JSON.stringify(notice).includes('AUDIT_FIXTURE_ONLY') && !JSON.stringify(notice).includes('old-hook'));
  await request('POST', '/hook', { headers: { 'content-type': 'application/json', 'x-agent-office-agent': 'codex', 'x-agent-office-token': 'f'.repeat(64) }, body: '{}' });
  await request('POST', '/hook', { headers: { 'content-type': 'application/json', 'x-agent-office-agent': '<b>x</b>' }, body: '{}' });
  const state = (await request('GET', '/api/state', { headers: page() })).json();
  assert.deepEqual(state.outdatedHooks.map(h => `${h.agent}/${h.reason}`).sort(), ['claude-code/no-key', 'codex/wrong-key', 'gemini/no-key', 'unknown/no-key']);
  assert.ok(!state.sessions.some(s => s.id === 'old-hook'));
  assert.equal(state.approvals.length, 0, 'nothing was held for a refused request');
  watcher.ws.close();
});

test('the real permission hook with a stale key prints nothing, so Claude Code asks as usual', async () => {
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'office-stale-'));
  try {
    fs.writeFileSync(path.join(stale, 'hook-token'), `X-Agent-Office-Token: ${'e'.repeat(64)}\n`, { mode: 0o600 });
    const watcher = socket(); await watcher.opened; await watcher.next('snapshot');
    watcher.ws.send(JSON.stringify({ type: 'presence', visible: true }));
    const env = { ...process.env, AGENT_OFFICE_DATA: stale, AGENT_OFFICE_PORT: String(port) };
    for (const k of ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH']) delete env[k];
    const out = await new Promise((resolve, reject) => {
      const p = spawn('sh', [fileURLToPath(new URL('../plugin/hooks/permission.sh', import.meta.url))], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let o = ''; p.stdout.on('data', d => { o += d; }); p.on('error', reject); p.on('close', code => resolve({ code, o }));
      p.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'stale-key', tool_name: 'Bash', tool_input: { command: 'ls' } }));
    });
    assert.deepEqual(out, { code: 0, o: '' });
    watcher.ws.close();
  } finally { fs.rmSync(stale, { recursive: true, force: true }); }
});

test('the page runs only its own scripts: inline ones by hash, files from this office', async () => {
  const r = await request('GET', '/');
  const csp = r.headers['content-security-policy'];
  const script = csp.split(';').map(s => s.trim()).find(s => s.startsWith('script-src '));
  assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:/.test(script), script);
  const inline = [...r.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  assert.ok(inline.length >= 2);
  for (const h of inline) assert.ok(script.includes(h), h);
  assert.ok(!/<script[^>]*\bsrc=["']?https?:/i.test(r.text.replace(/document\.write\([^)]*\)/g, '')), 'no external script tags');
  assert.ok(!/\son[a-z]+=["']/i.test(r.text), 'no inline event handlers, which the policy would block');
  for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", `connect-src 'self' ws://127.0.0.1:${port}`]) assert.ok(csp.includes(d), d);
});

test('the bridge refuses to listen beyond this computer', async () => {
  for (const host of ['0.0.0.0', '192.168.1.20', '::']) {
    const p = spawn(process.execPath, [SERVER], { env: { ...process.env, HOME: path.join(root, 'home'), AGENT_OFFICE_DATA: path.join(root, 'data-lan'), AGENT_OFFICE_PORT: String(await freePort()), AGENT_OFFICE_HOST: host }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    const code = await new Promise(r => p.on('close', r));
    assert.equal(code, 1, host); assert.match(err, /only listens on this computer/);
  }
});
