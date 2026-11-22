import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secret, credentials, hostOk, originOk, same, wsToken, codeFile, issueLoginCode, redeemLoginCode } from './auth.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'office-auth-'));

test('keys are made once, kept in files only their owner can read, and the hook key is a curl header line', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(tmp(), 'data');
  try {
    const first = credentials(dir);
    assert.match(first.ui, /^[0-9a-f]{64}$/); assert.match(first.hook, /^[0-9a-f]{64}$/); assert.notEqual(first.ui, first.hook);
    assert.deepEqual(credentials(dir), first);
    for (const name of ['ui-token', 'hook-token']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(dir, 'hook-token'), 'utf8'), `X-Agent-Office-Token: ${first.hook}\n`);
    fs.chmodSync(path.join(dir, 'ui-token'), 0o644);                 // loosened by someone: tightened, same key
    assert.equal(secret('ui-token', dir), first.ui);
    assert.equal(fs.statSync(path.join(dir, 'ui-token')).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dir, 'ui-token'), 'not a key');        // garbage: replaced with a fresh key
    assert.match(secret('ui-token', dir), /^[0-9a-f]{64}$/);
    assert.notEqual(secret('ui-token', dir), first.ui);
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('a key file that is a symlink is not followed', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'elsewhere'), 'a'.repeat(64));
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'ui-token'));
    assert.throws(() => secret('ui-token', dir), /ELOOP|EMLINK|symbolic/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Host must name this office on its port; Origin must be the office itself', () => {
  for (const h of ['localhost:4747', '127.0.0.1:4747', '[::1]:4747', '192.168.1.20:4747', 'LOCALHOST:4747']) assert.equal(hostOk(h, 4747), true, h);
  for (const h of [undefined, '', 'evil.example:4747', 'localhost.evil.example:4747', 'localhost:4748', 'localhost', '127.0.0.1:4747:1', 'a b:4747', 'localhost:4747/x', '[zz]:4747'])
    assert.equal(hostOk(h, 4747), false, String(h));
  assert.equal(hostOk('my-mac.local:4747', 4747, ['my-mac.local']), true);
  assert.equal(originOk(undefined, 'localhost:4747'), true);
  assert.equal(originOk('http://localhost:4747', 'localhost:4747'), true);
  for (const o of ['http://localhost:5000', 'http://evil.example', 'null', 'https://localhost:4747', 'http://127.0.0.1:4747']) assert.equal(originOk(o, 'localhost:4747'), false, o);
});

test('keys compare exactly, and the page offers its key as a WebSocket subprotocol', () => {
  assert.equal(same('abc', 'abc'), true);
  for (const [a, b] of [['abc', 'abd'], ['abc', 'ab'], [undefined, 'abc'], ['abc', undefined], [['abc'], 'abc']]) assert.equal(same(a, b), false);
  assert.equal(wsToken({ headers: { 'sec-websocket-protocol': 'agent-office, agent-office.token.k1' } }), 'k1');
  assert.equal(wsToken({ headers: {} }), undefined);
});

test('one-time sign-in codes are files any office redeems once, within a minute', { skip: process.platform === 'win32' }, () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'office-codes-')), 'data');
  try {
    // The same name the desktop app gives the file (desktop/src-tauri/src/auth.rs checks this vector too).
    assert.equal(codeFile('ab'.repeat(32), '/d'), '/d/login-codes/271a413bd339c5709fdceaec41f14f11e9fbfb5042d72d331c65f32b284cd09a');
    const code = issueLoginCode(dir);
    assert.equal(fs.statSync(path.join(dir, 'login-codes')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(codeFile(code, dir)).mode & 0o777, 0o600);
    assert.ok(!redeemLoginCode('nope', dir) && !redeemLoginCode('0'.repeat(64), dir) && !redeemLoginCode(undefined, dir));
    assert.ok(redeemLoginCode(code, dir));
    assert.ok(!redeemLoginCode(code, dir), 'a code works once');
    const late = issueLoginCode(dir);
    assert.ok(!redeemLoginCode(late, dir, Date.now() + 61_000), 'an expired code is refused');
    const linked = 'cd'.repeat(32);
    fs.symlinkSync(path.join(dir, 'ui-token'), codeFile(linked, dir));
    assert.ok(!redeemLoginCode(linked, dir), 'a symlink is not a code');
    fs.chmodSync(path.join(dir, 'login-codes'), 0o755);
    issueLoginCode(dir);
    assert.equal(fs.statSync(path.join(dir, 'login-codes')).mode & 0o777, 0o700, 'a loosened folder is tightened');
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});
