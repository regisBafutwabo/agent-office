// Finds agent chats that were already running when the office opened, from the logs each tool keeps on disk.
// Hooks only report what happens next, so without this the office starts empty until each chat does something.
// It also shows chats from tools whose hooks aren't installed. Mirrors desktop/src-tauri/src/discover.rs.
//   Claude Code  ~/.claude/projects/<project>/<session id>.jsonl
//   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread id>.jsonl (first line: session_meta)
//   Cursor       ~/.cursor/projects/<project>/agent-transcripts/<chat id>/<chat id>.jsonl
// Chats you archived in the Claude desktop app are skipped: archiving writes to the log, which would bring them back.
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

// The Claude desktop app keeps a file per chat (<app data>/claude-code-sessions/<org>/<account>/local_<id>.json).
// Archiving a chat sets isArchived there; cliSessionId is the Claude Code session id the hooks send.
// The files run to megabytes, but both fields sit in the first few hundred bytes, and a file is re-read only when it changes.
const APP_DATA = { darwin: 'Library/Application Support/Claude', win32: 'AppData/Roaming/Claude', linux: '.config/Claude' };
const archiveCache = new Map();   // file -> { mtime, id, archived }
export const desktopSessionsDir = home => path.join(home, APP_DATA[process.platform] || APP_DATA.linux, 'claude-code-sessions');
export function archivedChats(home = os.homedir()) {
  const ids = new Set(), root = desktopSessionsDir(home);
  for (const account of dirs(root).flatMap(dirs)) {
    let names; try { names = fs.readdirSync(account); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith('local_') || !n.endsWith('.json')) continue;
      const file = path.join(account, n); let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      let c = archiveCache.get(file);
      if (!c || c.mtime !== mtime) {
        const head = readSlice(file, false, 4096);
        c = { mtime, id: head.match(/"cliSessionId"\s*:\s*"([^"]+)"/)?.[1], archived: /"isArchived"\s*:\s*true/.test(head) };
        archiveCache.set(file, c);
      }
      if (c.archived && c.id) ids.add(c.id);
    }
  }
  return ids;
}

// Subagents a session's logs show still at work. Hooks report a subagent's start once, so an office opened later
// (or restarted) finds it here. One that was cut off mid-tool looks the same until its log leaves the window.
function runningSubs(proj, id, now) {
  const subs = [];
  for (const { file, at } of recentLogs(path.join(proj, id, 'subagents'), now)) {
    const last = tail(file).reverse().find(o => o.type === 'user' || o.type === 'assistant');
    const midTurn = last && (last.type === 'user' || (Array.isArray(last.message?.content) && last.message.content.some(x => x?.type === 'tool_use')));
    if (!midTurn) continue;
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
    subs.push({ id: path.basename(file, '.jsonl').replace(/^agent-/, ''), type: clip(meta.agentType, 60) || 'subagent', task: clip(meta.description, 120) || null, at });
  }
  return subs;
}

function claude(home, now, out, archived) {
  for (const proj of dirs(path.join(home, '.claude', 'projects'))) {
    const folder = path.basename(proj);
    for (const { file, at } of recentLogs(proj, now)) {
      if (archived.has(path.basename(file, '.jsonl'))) continue;
      const lines = tail(file), info = [...lines].reverse().find(o => typeof o.cwd === 'string');
      if (!info) continue;
      if (String(info.entrypoint || '').startsWith('sdk')) continue;   // background helpers run through the Agent SDK, not chats you opened
      // The session may have cd'd into a subfolder; hooks file it under the project folder, so do the same.
      let root = info.cwd; for (let p = info.cwd; ; p = path.dirname(p)) { if (encode(p) === folder) { root = p; break; } if (p === path.dirname(p)) break; }
      const last = [...lines].reverse().find(o => (o.type === 'user' || o.type === 'assistant') && !o.isSidechain && !o.isMeta);
      let [status, activity] = !last ? ['idle', 'Session started'] : last.type === 'user' ? ['thinking', 'Thinking']
        : Array.isArray(last.message?.content) && last.message.content.some(x => x?.type === 'tool_use') ? ['working', 'Working'] : ['done', 'Finished'];
      const id = path.basename(file, '.jsonl'), subs = runningSubs(proj, id, now), seen = Math.max(at, ...subs.map(x => x.at));
      [status, activity] = subs.length ? ['working', 'Waiting on a subagent'] : settle(status, activity, at, now);
      const t = readTail(file) || { title: null, messages: [] };
      out.push({ agent: 'claude-code', id, subs, cwd: root, entrypoint: info.entrypoint || null, at: seen, status, activity, title: t.title, messages: t.messages });
    }
  }
}

function codex(home, now, out) {
  const days = dirs(path.join(home, '.codex', 'sessions')).flatMap(dirs).flatMap(dirs).sort();
  for (const day of days.slice(-CODEX_DAYS)) {
    for (const { file, at } of recentLogs(day, now)) {
      const first = head(file, 3), meta = first.find(o => o.type === 'session_meta')?.payload;
      const id = meta?.session_id || meta?.id;
      // Subagent threads and chats imported from other tools aren't chats you're running. A subagent names its parent;
      // T3 Code marks the threads it starts "subagent" too, but those have no parent and are chats of their own.
      const imported = first.some(o => String(o.payload?.turn_id || '').startsWith('external-import'));
      const subagent = !!(meta?.parent_thread_id || meta?.forked_from_id || meta?.source?.subagent);
      if (!id || imported || subagent || (meta.thread_source && !['user', 'subagent'].includes(meta.thread_source))) continue;
      const last = tail(file).reverse().map(o => o.payload?.type).find(t => ['task_started', 'task_complete', 'turn_aborted'].includes(t));
      const [status, activity] = settle(...(!last ? ['idle', 'Session started'] : last === 'task_started' ? ['thinking', 'Thinking'] : ['done', 'Finished']), at, now);
      // ended: the log itself says the turn is over, so it overrides hooks still saying "thinking" (see Store.adopt).
      const prompt = codexPrompt(head(file, 80));
      out.push({ agent: 'codex', id: `codex:${id}`, cwd: meta.cwd || '', entrypoint: meta.originator || null, at, status, activity, title: prompt ? promptTitle(prompt) : null, messages: [],
                 ended: !!last && last !== 'task_started', delegatedBy: delegatedBy(prompt) });
    }
  }
}

// Cursor wraps your prompt as "<user_query>\n…\n</user_query>" after a timestamp.
// T3 Code adds its own instructions inside that and puts your words in "<user_request>…</user_request>".
const cursorText = o => Array.isArray(o?.message?.content) && o.message.content.find(x => typeof x?.text === 'string')?.text || '';
const between = (text, tag) => text.includes(`<${tag}>`) ? text.split(`<${tag}>`)[1].split(`</${tag}>`)[0] : null;
export const fromT3 = text => text.includes('<t3_code_orchestration_instructions>');
// The T3 Code thread that handed this task to the agent, from the line T3 Code puts before it:
// [T3 Code: the agent in T3 thread "<thread id>" sent this message, not the user.]
const T3_THREAD = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|thread:[A-Za-z0-9%._:-]{1,300})$/i;   // as focus.js validT3Thread
export function delegatedBy(text) {
  const id = String(text ?? '').split('[T3 Code: the agent in T3 thread "')[1]?.split('"')[0];
  return id && T3_THREAD.test(id) ? id : null;
}

// A prompt, as a chat name: your words only. T3 Code wraps a task it hands to another agent in its own lines
// ("[T3 Code: the agent in T3 thread … sent this message, not the user.]", "Act as the research sub-agent for this task.").
const T3_LINE = /^\s*(\[T3 Code:[^\]]*\]|Act as the [\w -]+ for this task\.?)\s*$/;
export function promptTitle(text) {
  const words = between(String(text ?? ''), 'user_request') ?? between(String(text ?? ''), 'user_query') ?? String(text ?? '');
  return clip(words.split('\n').filter(l => !T3_LINE.test(l)).join('\n'), 80) || null;
}
function cursorPrompt(o) {
  const text = cursorText(o);
  return text ? promptTitle(text) : null;
}

// Cursor ends a turn with "turn_ended", but not when T3 Code runs it. There the answer is a last assistant message
// with no tool call; the log must also have been quiet a moment, since text-only messages can come in a row mid-answer.
export const CURSOR_QUIET_MS = 10_000;
export function cursorDone(last, at, now) {
  if (!last) return false;
  if (last.type === 'turn_ended') return true;
  const c = last.message?.content;
  const textOnly = last.role === 'assistant' && Array.isArray(c) && c.length > 0 && c.every(x => x?.type === 'text');
  return textOnly && now - at >= CURSOR_QUIET_MS;
}

// The first thing you asked a Codex thread: its user_message event, or else the first user message that isn't
// the AGENTS.md or environment block Codex adds before it (T3 Code's threads have only those).
function codexPrompt(lines) {
  const ev = lines.find(o => o.type === 'event_msg' && o.payload?.type === 'user_message')?.payload?.message;
  if (typeof ev === 'string') return ev;
  return lines.filter(o => o.type === 'response_item' && o.payload?.type === 'message' && o.payload?.role === 'user')
    .map(o => (Array.isArray(o.payload.content) ? o.payload.content : []).map(x => x?.text).filter(t => typeof t === 'string').join('\n'))
    .find(t => { t = t.trimStart(); return t && !t.startsWith('#') && !t.startsWith('<'); }) || null;
}
// Cursor keeps a transcript per subagent in <chat>/subagents/; the ones still at work, named after their task.
function cursorSubs(chat, now) {
  const subs = [];
  for (const { file, at } of recentLogs(path.join(chat, 'subagents'), now)) {
    if (cursorDone(tail(file).at(-1), at, now)) continue;
    const first = head(file, 1)[0];
    subs.push({ id: path.basename(file, '.jsonl'), type: 'subagent', task: first?.role === 'user' ? cursorPrompt(first) : null, at });
  }
  return subs;
}

function cursor(home, now, out) {
  for (const proj of dirs(path.join(home, '.cursor', 'projects'))) {
    const folder = path.basename(proj); let cwd;
    for (const chat of dirs(path.join(proj, 'agent-transcripts'))) {
      for (const { file, at } of recentLogs(chat, now)) {
        cwd ??= decode(folder) || '/' + folder.replace(/-/g, '/');
        const done = cursorDone(tail(file).at(-1), at, now);
        const [status, activity] = settle(done ? 'done' : 'thinking', done ? 'Finished' : 'Thinking', at, now);
        const first = head(file, 1)[0], user = first?.role === 'user';
        out.push({ agent: 'cursor', id: `cursor:${path.basename(file, '.jsonl')}`, cwd, entrypoint: user && fromT3(cursorText(first)) ? 't3-code' : null, at, status, activity,
                   title: user ? cursorPrompt(first) : null, messages: [], ended: done, subs: done ? [] : cursorSubs(chat, now), delegatedBy: user ? delegatedBy(cursorText(first)) : null });
      }
    }
  }
}

// Every chat whose log was written to in the last 30 minutes.
export function scan(home = os.homedir(), now = Date.now()) {
  const out = [];
  claude(home, now, out, archivedChats(home)); codex(home, now, out); cursor(home, now, out);
  return out;
}
