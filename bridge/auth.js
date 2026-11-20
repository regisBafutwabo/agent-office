// Who may talk to the office. Two per-user secrets live in the data folder, readable only by their owner:
//   ui-token    the office page's key: read state, see code, answer permission requests (Authorization: Bearer …)
//   hook-token  the hooks' key, kept as a curl header line: report events and ask for permission, nothing else
// The desktop app and this bridge share both files, so hooks and open pages work with whichever is running.
// Requests must also name this office in Host (an IP address, localhost, or a name you allowed), so a web page
// that rebinds its own domain to 127.0.0.1 can't reach it, and browsers' Origin must be the office itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SUPPORT = { darwin: 'Library/Application Support/Agent Office', win32: 'AppData/Roaming/Agent Office', linux: '.config/agent-office' };
export const dataDir = (home = os.homedir()) => process.env.AGENT_OFFICE_DATA || path.join(home, SUPPORT[process.platform] || SUPPORT.linux);

export const HOOK_HEADER = 'X-Agent-Office-Token';
export const WS_PROTOCOL = 'agent-office';
const WS_TOKEN = 'agent-office.token.';
const TOKEN = /^[0-9a-f]{64}$/;

const formats = {
  'ui-token': { write: t => `${t}\n`, read: s => s.trim() },
  'hook-token': { write: t => `${HOOK_HEADER}: ${t}\n`, read: s => s.trim().replace(new RegExp(`^${HOOK_HEADER}:\\s*`, 'i'), '') },
};

// The secret in <dir>/<name>, created on first use. Only its owner may read it; looser permissions are tightened.
export function secret(name, dir = dataDir()) {
  const { write, read } = formats[name], file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const st = fs.fstatSync(fd);
        if (process.platform !== 'win32' && st.uid !== process.getuid()) throw new Error(`${file} belongs to another user`);
        if (process.platform !== 'win32' && st.mode & 0o077) fs.fchmodSync(fd, 0o600);
        const token = read(fs.readFileSync(fd, 'utf8'));
        if (TOKEN.test(token)) return token;
      } finally { fs.closeSync(fd); }
      fs.rmSync(file, { force: true });                         // unreadable or not one of ours: replace it
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const token = crypto.randomBytes(32).toString('hex');
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { fs.writeFileSync(fd, write(token)); } finally { fs.closeSync(fd); }
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;                     // the other server made it first: read theirs
    }
  }
  throw new Error(`Could not create ${file}`);
}
export const credentials = (dir = dataDir()) => ({ ui: secret('ui-token', dir), hook: secret('hook-token', dir) });

// One-time sign-in codes for the desktop app's "Open in browser" link. That link passes through `open`'s command
// line, which other users can read, so it carries a code instead of the key. Whichever office holds the port must
// redeem it, so codes live in the data folder, not in one process: login-codes/<sha256 of the code>, an empty file
// made 0600 in a folder kept 0700. Redeeming deletes the file, and only one deletion can succeed, so a code works
// once, and only within a minute of its file's modification time. desktop/src-tauri/src/auth.rs writes the same files.
export const CODE_LIFE_MS = 60_000;
const ownedByMe = st => process.platform === 'win32' || st.uid === process.getuid();
export const codeFile = (code, dir = dataDir()) => path.join(dir, 'login-codes', crypto.createHash('sha256').update(code).digest('hex'));
function codesDir(dir) {
  const d = path.join(dir, 'login-codes');
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(d);
  if (!st.isDirectory() || !ownedByMe(st)) throw new Error(`${d} is not this user's folder`);
  if (process.platform !== 'win32' && st.mode & 0o077) fs.chmodSync(d, 0o700);
  return d;
}
export function issueLoginCode(dir = dataDir()) {
  const d = codesDir(dir), now = Date.now();
  for (const name of fs.readdirSync(d)) {                       // forget codes nobody used
    try { const st = fs.lstatSync(path.join(d, name)); if (now - st.mtimeMs > CODE_LIFE_MS) fs.rmSync(path.join(d, name), { force: true }); } catch {}
  }
  const code = crypto.randomBytes(32).toString('hex');
  fs.closeSync(fs.openSync(codeFile(code, dir), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600));
  return code;
}
export function redeemLoginCode(code, dir = dataDir(), now = Date.now()) {
  if (typeof code !== 'string' || !TOKEN.test(code)) return false;
  let file, st;
  try { codesDir(dir); file = codeFile(code, dir); st = fs.lstatSync(file); } catch { return false; }
  try { fs.unlinkSync(file); } catch { return false; }          // someone else redeemed it first
  const age = now - st.mtimeMs;
  return st.isFile() && ownedByMe(st) && age >= -5_000 && age < CODE_LIFE_MS;
}

export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// "localhost:4747", "127.0.0.1:4747", "[::1]:4747", a LAN address, or a name listed in `extra`, on this port.
// A rebinding attack needs its own domain name in Host, so IP literals and localhost are safe to accept.
export function hostOk(host, port, extra = []) {
  if (typeof host !== 'string') return false;
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host);
  if (!m) return false;
  const name = m[1].toLowerCase(), p = m[2] ? Number(m[2]) : 80;
  if (p !== port) return false;
  return name === 'localhost' || net.isIPv4(name) || (name.startsWith('[') && net.isIPv6(name.slice(1, -1))) || extra.includes(name);
}
// Browsers name the page in Origin; it must be this office, as the page itself addressed it. Hooks send none.
export const originOk = (origin, host) => origin === undefined || (typeof host === 'string' && String(origin).toLowerCase() === `http://${host.toLowerCase()}`);

export const bearer = req => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
export const hookToken = req => req.headers[HOOK_HEADER.toLowerCase()];
// Browsers can't set headers on a WebSocket, so the page offers its key as a second subprotocol.
export function wsToken(req) {
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
  return offered.find(p => p.startsWith(WS_TOKEN))?.slice(WS_TOKEN.length);
}
