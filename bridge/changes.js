// What a session's checkout holds that its base branch doesn't: the file list for the agent card and one file's diff on request.
// Read-only. Git never takes a lock here, so it can't get in an agent's way.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_MS = 5000;
const CACHE_MS = 2000;             // every card and agent on one checkout shares a reading this fresh
const MAX_FILES = 300;
const MAX_DIFF = 200_000;          // characters of one file's diff
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

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => err ? reject(err) : resolve(stdout));
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
function sigOf(abs, f) {
  try { const st = fs.statSync(abs); return `${f.add}:${f.del}:${st.size}:${Math.round(st.mtimeMs)}`; } catch { return `${f.add}:${f.del}:gone`; }
}
function countLines(abs) {
  try {
    if (fs.statSync(abs).size > COUNT_BYTES) return null;
    const buf = fs.readFileSync(abs); if (buf.includes(0)) return null;
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

export async function fileDiff(cwd, rel) {
  const c = await changes(cwd); if (!c.ok) return c;
  const abs = insideRoot(c.root, rel); if (!abs) return { ok: false, error: 'Not a file in this checkout' };
  let text = await git(c.root, ['diff', '--no-renames', c.baseSha, '--', rel]).catch(() => '');
  if (!text) {                                                   // untracked: the whole file is new
    try {
      const buf = fs.readFileSync(abs);
      text = buf.includes(0) ? 'Binary file' : `@@ new file @@\n${buf.toString('utf8').replace(/\n$/, '').split('\n').map(l => '+' + l).join('\n')}`;
    } catch { return { ok: false, error: 'That file is gone' }; }
  }
  return { ok: true, path: rel, text: text.slice(0, MAX_DIFF), truncated: text.length > MAX_DIFF };
}
