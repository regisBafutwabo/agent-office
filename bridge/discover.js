// Finds agent chats that were already running when the office opened, from the logs each tool keeps on disk.
// Hooks only report what happens next, so without this the office starts empty until each chat does something.
// It also shows chats from tools whose hooks aren't installed. Mirrors desktop/src-tauri/src/discover.rs.
//   Claude Code  ~/.claude/projects/<project>/<session id>.jsonl
//   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl (first line: session_meta)
//   Cursor       ~/.cursor/projects/<project>/agent-transcripts/<chat id>/<chat id>.jsonl
// Only logs written to in the last FOUND_WINDOW_MS count. The ids match what each tool's hooks send
// (Codex and Cursor ones unverified against their hooks), so a hook takes over the same agent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTail } from './transcript.js';

export const FOUND_WINDOW_MS = 30 * 60 * 1000;
const QUIET_MS = 3 * 60 * 1000;    // a log this quiet while mid-turn: probably waiting on you
const TAIL_BYTES = 256 * 1024;
const CODEX_DAYS = 7;              // Codex files a chat under the day it started; look back this many day folders

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const dirs = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(p, e.name)))).map(e => path.join(p, e.name)); } catch { return []; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const parse = l => { if (!l.startsWith('{')) return null; try { return JSON.parse(l); } catch { return null; } };

// .jsonl files in dir written to within the window, with their write time.
function recentLogs(dir, now) {
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => n.endsWith('.jsonl')).map(n => {
    const file = path.join(dir, n); try { return { file, at: Math.floor(fs.statSync(file).mtimeMs) }; } catch { return null; }
  }).filter(x => x && now - x.at <= FOUND_WINDOW_MS);
}

function readSlice(file, fromEnd, len) {
  let fd; try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, len), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, fromEnd ? size - n : 0);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
// The JSON lines in the last 256 KB of a log (the first one is usually cut in half and skipped).
const tail = file => readSlice(file, true, TAIL_BYTES).split('\n').map(parse).filter(Boolean);
// The first n JSON lines of a log.
const head = (file, n) => readSlice(file, false, 4 * 1024 * 1024).split('\n').slice(0, n).map(parse).filter(Boolean);

// How Claude Code and Cursor name a project folder: every character but letters and digits becomes "-".
export const encode = p => String(p).replace(/[^A-Za-z0-9]/g, '-');

// Turns an encoded folder name back into a real path by walking the disk ("a-b" could be "a/b" or "a-b").
export function decode(name) {
  const walk = (dir, rest, depth) => {
    if (depth > 16) return null;
    const kids = dirs(dir).map(p => ({ e: encode(path.basename(p)), p })).sort((a, b) => b.e.length - a.e.length);   // longest name first
    for (const { e, p } of kids) {
      if (rest === e) return p;
      if (rest.startsWith(e + '-')) { const found = walk(p, rest.slice(e.length + 1), depth + 1); if (found) return found; }
    }
    return null;
  };
  const rest = name.startsWith('-') ? name.slice(1) : name;
  return rest ? walk('/', rest, 0) : null;
}

// Mid-turn but silent for a while: most likely waiting on a permission prompt or a question.
export const settle = (status, activity, at, now) =>
  status !== 'done' && now - at > QUIET_MS ? ['idle', 'Quiet for a few minutes'] : [status, activity];

function claude(home, now, out) {
  for (const proj of dirs(path.join(home, '.claude', 'projects'))) {
    const folder = path.basename(proj);
    for (const { file, at } of recentLogs(proj, now)) {
      const lines = tail(file), info = [...lines].reverse().find(o => typeof o.cwd === 'string');
      if (!info) continue;
      if (String(info.entrypoint || '').startsWith('sdk')) continue;   // background helpers run through the Agent SDK, not chats you opened
      // The session may have cd'd into a subfolder; hooks file it under the project folder, so do the same.
      let root = info.cwd; for (let p = info.cwd; ; p = path.dirname(p)) { if (encode(p) === folder) { root = p; break; } if (p === path.dirname(p)) break; }
      const last = [...lines].reverse().find(o => (o.type === 'user' || o.type === 'assistant') && !o.isSidechain && !o.isMeta);
      let [status, activity] = !last ? ['idle', 'Session started'] : last.type === 'user' ? ['thinking', 'Thinking']
        : Array.isArray(last.message?.content) && last.message.content.some(x => x?.type === 'tool_use') ? ['working', 'Working'] : ['done', 'Finished'];
      [status, activity] = settle(status, activity, at, now);
      const t = readTail(file) || { title: null, messages: [] };
      out.push({ agent: 'claude-code', id: path.basename(file, '.jsonl'), cwd: root, entrypoint: info.entrypoint || null, at, status, activity, title: t.title, messages: t.messages });
    }
  }
}

function codex(home, now, out) {
  const days = dirs(path.join(home, '.codex', 'sessions')).flatMap(dirs).flatMap(dirs).sort();
  for (const day of days.slice(-CODEX_DAYS)) {
    for (const { file, at } of recentLogs(day, now)) {
      const first = head(file, 3), meta = first.find(o => o.type === 'session_meta')?.payload;
      const id = meta?.session_id || meta?.id;
      // Subagent threads and chats imported from other tools aren't chats you're running.
      const imported = first.some(o => String(o.payload?.turn_id || '').startsWith('external-import'));
      if (!id || imported || (meta.thread_source && meta.thread_source !== 'user')) continue;
      const last = tail(file).reverse().map(o => o.payload?.type).find(t => ['task_started', 'task_complete', 'turn_aborted'].includes(t));
      const [status, activity] = settle(...(!last ? ['idle', 'Session started'] : last === 'task_started' ? ['thinking', 'Thinking'] : ['done', 'Finished']), at, now);
      out.push({ agent: 'codex', id: `codex:${id}`, cwd: meta.cwd || '', entrypoint: meta.originator || null, at, status, activity, title: null, messages: [] });
    }
  }
}

// Cursor wraps your prompt as "<user_query>\n…\n</user_query>" after a timestamp.
function cursorPrompt(o) {
  const text = Array.isArray(o?.message?.content) && o.message.content.find(x => typeof x?.text === 'string')?.text;
  if (!text) return null;
  const q = text.includes('<user_query>') ? text.split('<user_query>')[1].split('</user_query>')[0] : text;
  return clip(q, 80) || null;
}

function cursor(home, now, out) {
  for (const proj of dirs(path.join(home, '.cursor', 'projects'))) {
    const folder = path.basename(proj); let cwd;
    for (const chat of dirs(path.join(proj, 'agent-transcripts'))) {
      for (const { file, at } of recentLogs(chat, now)) {
        cwd ??= decode(folder) || '/' + folder.replace(/-/g, '/');
        const done = tail(file).at(-1)?.type === 'turn_ended';
        const [status, activity] = settle(done ? 'done' : 'thinking', done ? 'Finished' : 'Thinking', at, now);
        const first = head(file, 1)[0];
        out.push({ agent: 'cursor', id: `cursor:${path.basename(file, '.jsonl')}`, cwd, entrypoint: null, at, status, activity,
                   title: first?.role === 'user' ? cursorPrompt(first) : null, messages: [] });
      }
    }
  }
}

// Every chat whose log was written to in the last 30 minutes.
export function scan(home = os.homedir(), now = Date.now()) {
  const out = [];
  claude(home, now, out); codex(home, now, out); cursor(home, now, out);
  return out;
}
