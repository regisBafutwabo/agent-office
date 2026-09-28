// The conversation's title, read from the end of a Claude Code transcript (the .jsonl in the hook payload's transcript_path).
// Claude Code writes {"type":"custom-title","customTitle":…} when a chat is named (by you or the desktop app) and
// {"type":"ai-title","aiTitle":…} when it names one itself; both are repeated as the chat goes on, so the tail is enough.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAIL_BYTES = 256 * 1024;

// Only transcripts in the user's home folder: the path comes from a hook payload.
function readable(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !p.endsWith('.jsonl')) return false;
  const home = os.homedir();
  return path.resolve(p).startsWith(home + path.sep);
}

// Latest custom title, else latest AI title, else null.
export function titleFromText(text) {
  let custom = null, ai = null;
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === 'custom-title' && o.customTitle) custom = String(o.customTitle);
      else if (o.type === 'ai-title' && o.aiTitle) ai = String(o.aiTitle);
    } catch { /* first line of the tail is usually cut in half */ }
  }
  const t = (custom || ai || '').replace(/\s+/g, ' ').trim();
  return t || null;
}

export function transcriptTitle(p) {
  if (!readable(p)) return null;
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size, len = Math.min(size, TAIL_BYTES), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return titleFromText(buf.toString('utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
