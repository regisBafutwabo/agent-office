// What a session's checkout holds that its base branch doesn't: the file list for the agent card and one file's diff on request.
// Read-only. Git never takes a lock here, so it can't get in an agent's way.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_MS = 5000;
const CACHE_MS = 2000;             // every card and agent on one checkout shares a reading this fresh
const MAX_FILES = 300;
const MAX_DIFF = 200_000;          // characters of one file's diff
const MAX_READ = 4 * MAX_DIFF;     // bytes read for it, git's output or a new file, before it is cut to MAX_DIFF
const COUNT_BYTES = 256 * 1024;    // untracked files larger than this don't get their lines counted
const EDIT_LINES = 6, EDIT_CHARS = 160;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BASES = ['origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop'];

// The lines an edit took out and put in, without the unchanged ones around them, short enough for a card.
export function editOf(tool, input = {}) {
  const lines = s => { const l = String(s ?? '').replace(/\r/g, '').split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
  let del, add;
  if (tool === 'Edit') { del = lines(input.old_string); add = lines(input.new_string); }
  else if (tool === 'Write') { del = []; add = lines(input.content); }
  else return null;
  if (typeof (tool === 'Edit' ? input.new_string : input.content) !== 'string') return null;
  while (del.length && add.length && del[0] === add[0]) { del.shift(); add.shift(); }
  while (del.length && add.length && del[del.length - 1] === add[add.length - 1]) { del.pop(); add.pop(); }
  const cut = list => list.slice(0, EDIT_LINES).map(l => l.length > EDIT_CHARS ? l.slice(0, EDIT_CHARS - 1) + '…' : l);
  return { del: cut(del), add: cut(add), more: Math.max(0, del.length - EDIT_LINES) + Math.max(0, add.length - EDIT_LINES) };
}

// `git diff --numstat -z --no-renames`: "added<TAB>removed<TAB>path<NUL>", with "-" for both counts on a binary file.
export function parseNumstat(out) {
  const files = new Map();
  for (const rec of out.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec); if (!m) continue;
    files.set(m[3], { add: m[1] === '-' ? null : +m[1], del: m[2] === '-' ? null : +m[2] });
  }
  return files;
}
// `git diff --name-status -z --no-renames`: "M<NUL>path<NUL>A<NUL>path<NUL>".
export function parseNameStatus(out) {
  const status = new Map(), parts = out.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) status.set(parts[i + 1], parts[i][0] === 'A' ? 'added' : parts[i][0] === 'D' ? 'deleted' : 'modified');
  return status;
}
// A path from the page is only ever a file inside the checkout.
export function insideRoot(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) ? abs : null;
}

// Paths are always literal, so a file named like a pathspec (":(glob)*") is only ever that file.
function git(cwd, args, maxBuffer = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_MS, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1' } },
      (err, stdout) => err ? reject(Object.assign(err, { stdout })) : resolve(stdout));
  });
}
const quiet = (cwd, args) => git(cwd, args).then(s => s.trim(), () => '');

async function baseOf(root) {
  const head = await quiet(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head) return { sha: EMPTY_TREE, ref: null };
  const remote = await quiet(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  for (const ref of [remote, ...BASES].filter(Boolean)) {
    const sha = await quiet(root, ['merge-base', 'HEAD', ref]);
    if (sha) return sha === head ? { sha: 'HEAD', ref: null } : { sha, ref };   // on the base branch itself: only what isn't committed
  }
  return { sha: 'HEAD', ref: null };
}
// A fingerprint that changes when the file does, so "reviewed" can mean "reviewed this version".
// lstat, here and below: a symlink in the checkout is described, never followed.
function sigOf(abs, f) {
  try { const st = fs.lstatSync(abs); return `${f.add}:${f.del}:${st.size}:${Math.round(st.mtimeMs)}`; } catch { return `${f.add}:${f.del}:gone`; }
}
function countLines(abs) {
  try {
    const st = fs.lstatSync(abs); if (!st.isFile() || st.size > COUNT_BYTES) return null;
    const buf = readNoFollow(abs, COUNT_BYTES).buf; if (buf.includes(0)) return null;
    let n = 0; for (const b of buf) if (b === 10) n++;
    return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
  } catch { return null; }
}

async function read(cwd) {
  const top = await quiet(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return { ok: false, error: 'Not a git checkout' };
  const root = fs.realpathSync(top);
  const [branch, prefix, base] = await Promise.all([quiet(root, ['rev-parse', '--abbrev-ref', 'HEAD']), quiet(cwd, ['rev-parse', '--show-prefix']), baseOf(root)]);
  const [numstat, names, others] = await Promise.all([
    git(root, ['diff', '--numstat', '-z', '--no-renames', base.sha, '--']),
    git(root, ['diff', '--name-status', '-z', '--no-renames', base.sha, '--']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'])]);
  const status = parseNameStatus(names), files = [];
  for (const [p, n] of parseNumstat(numstat)) files.push({ path: p, status: status.get(p) || 'modified', ...n });
  for (const p of others.split('\0').filter(Boolean)) files.push({ path: p, status: 'untracked', add: countLines(path.join(root, p)), del: 0 });
  for (const f of files) f.sig = sigOf(path.join(root, f.path), f);
  return { ok: true, root, branch: branch === 'HEAD' ? null : branch, prefix, base: base.ref, baseSha: base.sha, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES, at: Date.now() };
}

const roots = new Map();           // cwd → checkout root, to tell which sessions share one
export async function rootOf(cwd) {
  if (!roots.has(cwd)) { const top = await quiet(cwd, ['rev-parse', '--show-toplevel']); roots.set(cwd, top ? fs.realpathSync(top) : null); }
  return roots.get(cwd);
}
const cache = new Map();           // cwd → { at, promise }
export function changes(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = read(cwd).catch(err => ({ ok: false, error: err.killed ? 'Git took too long' : 'Git could not read this checkout' }));
  cache.set(cwd, { at: Date.now(), promise });
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return promise;
}

// Up to `max` bytes of a regular file, refusing a symlink in its last component.
function readNoFollow(abs, max) {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
    const buf = Buffer.alloc(Math.min(st.size, max)); let n = 0, got;
    while (n < buf.length && (got = fs.readSync(fd, buf, n, buf.length - n, null)) > 0) n += got;
    return { buf: buf.subarray(0, n), more: st.size > max };
  } finally { fs.closeSync(fd); }
}
// A new file's text, read without leaving the checkout: symlinks, here or in a folder above, are not followed.
function newFile(root, abs) {
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return { text: 'Symbolic link' };
    if (!fs.realpathSync(abs).startsWith(root + path.sep)) return { error: 'Not a file in this checkout' };
    const { buf, more } = readNoFollow(abs, MAX_READ);
    if (buf.includes(0)) return { text: 'Binary file' };
    return { text: `@@ new file @@\n${buf.toString('utf8').replace(/\n$/, '').split('\n').map(l => '+' + l).join('\n')}`, more };
  } catch { return { error: 'That file is gone' }; }
}

// Only a file the card lists can be shown: nothing ignored, unchanged, or outside the checkout.
export async function fileDiff(cwd, rel) {
  const c = await changes(cwd); if (!c.ok) return c;
  const f = typeof rel === 'string' ? c.files.find(f => f.path === rel) : null;
  const abs = f && insideRoot(c.root, rel); if (!abs) return { ok: false, error: 'Not a changed file in this checkout' };
  let text, more = false;
  if (f.status === 'untracked') {
    const n = newFile(c.root, abs); if (n.error) return { ok: false, error: n.error };
    ({ text } = n); more = !!n.more;
  } else {
    try { text = await git(c.root, ['diff', '--no-renames', c.baseSha, '--', rel], MAX_READ); }
    catch (err) { if (err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ok: false, error: 'Git could not read this file' }; text = String(err.stdout); more = true; }
    if (!text) text = 'No line changes';
  }
  return { ok: true, path: rel, text: text.slice(0, MAX_DIFF), truncated: more || text.length > MAX_DIFF };
}
