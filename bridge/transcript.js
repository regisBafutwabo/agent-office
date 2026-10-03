// What the office shows from a Claude Code transcript (the .jsonl in the hook payload's transcript_path):
// the chat's title and its last few messages. Only the end of the file is read.
//   Title: {"type":"custom-title","customTitle":…} when a chat is named (by you or the desktop app), else
//   {"type":"ai-title","aiTitle":…} when Claude Code names it itself; both repeat as the chat goes on.
//   Messages: your prompts and Claude's text replies. Tool calls, tool results, thinking and subagent
//   (sidechain) turns are left out; the live feed already shows tool calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read the last 256 KB; if big tool outputs crowd the messages out, look further back (up to 4 MB).
const TAIL_BYTES = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
export const MESSAGES_MAX = 12, MESSAGE_CHARS = 600;

// Only transcripts in the user's home folder: the path comes from a hook payload.
function readable(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !p.endsWith('.jsonl')) return false;
  return path.resolve(p).startsWith(os.homedir() + path.sep);
}

// Keeps line breaks (replies are often lists), trims runs of blank lines, cuts long messages.
function clipText(s) {
  s = String(s).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > MESSAGE_CHARS ? s.slice(0, MESSAGE_CHARS - 1).trimEnd() + '…' : s;
}

function messageOf(o) {
  if ((o.type !== 'user' && o.type !== 'assistant') || o.isMeta || o.isSidechain || !o.message) return null;
  const c = o.message.content;
  if (o.type === 'user') {
    if (Array.isArray(c) && c.some(x => x && x.type === 'tool_result')) return null;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
    if (!text.trim() || text.trimStart().startsWith('<')) return null;   // slash commands, hook and system notes
    return { role: 'user', text: clipText(text) };
  }
  const text = Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '';
  return text.trim() ? { role: 'assistant', text: clipText(text) } : null;
}

export function parseTranscript(text) {
  let custom = null, ai = null; const messages = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }   // first line of the tail is usually cut in half
    if (o.type === 'custom-title' && o.customTitle) custom = String(o.customTitle);
    else if (o.type === 'ai-title' && o.aiTitle) ai = String(o.aiTitle);
    else { const m = messageOf(o); if (m) messages.push(m); }
  }
  const title = (custom || ai || '').replace(/\s+/g, ' ').trim() || null;
  return { title, messages: messages.slice(-MESSAGES_MAX) };
}

export function readTranscript(p) {
  return readable(p) ? readTail(p) : null;
}

// Reads a transcript the office found itself (see discover.js), so no path check.
export function readTail(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size; let t;
    for (const max of TAIL_BYTES) {
      const len = Math.min(size, max), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      t = parseTranscript(buf.toString('utf8'));
      if (t.messages.length >= MESSAGES_MAX || len === size) break;
    }
    return t;
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
