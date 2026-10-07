// Ollama has no hooks and keeps no chat logs, so the office asks the Ollama server itself which models are
// loaded (GET /api/ps) and reads the end of its log to tell whether one is answering. Each loaded model is an
// agent on an "Ollama" floor, and it leaves when Ollama unloads the model. Ollama doesn't know which tool or
// project sent a prompt, so these agents never raise a hand or show the chat. Mirrors desktop/src-tauri/src/ollama.rs.
//   Models  http://127.0.0.1:11434/api/ps
//   Log     ~/.ollama/logs/server.log (the Mac app's; llama.cpp runner lines, absent on older versions)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PS_URL = 'http://127.0.0.1:11434/api/ps';
const LOG_TAIL = 64 * 1024;

function readTail(file) {
  let fd; try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, LOG_TAIL), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// The runner logs "processing task" when a prompt starts and "stop processing" / "all slots are idle" when it ends.
export function answering(log) {
  let start = -1, stop = -1;
  log.split('\n').forEach((l, i) => {
    if (l.includes('processing task')) start = i;
    else if (l.includes('stop processing') || l.includes('all slots are idle')) stop = i;
  });
  return start > stop;
}

// /api/ps models as found agents. The log doesn't say which model is answering; Ollama pushes a model's
// expires_at forward each time it's used, so it's the one that expires last.
export function models(ps, log, home, now) {
  const list = (Array.isArray(ps?.models) ? ps.models : []).filter(m => typeof m?.name === 'string' && m.name);
  const expiry = m => Date.parse(m.expires_at) || 0;
  const latest = list.reduce((a, m) => !a || expiry(m) > expiry(a) ? m : a, null), busy = answering(log);
  return list.map(m => {
    const on = busy && m === latest;
    return { agent: 'ollama', id: `ollama:${m.name}`, cwd: path.join(home, '.ollama'), project: 'Ollama', entrypoint: null, at: now,
             status: on ? 'working' : 'idle', activity: on ? 'Answering a prompt' : 'Loaded, waiting for a prompt', title: m.name, messages: [] };
  });
}

// Every model Ollama has loaded right now; none when Ollama isn't running.
export async function pollOllama(home = os.homedir(), now = Date.now()) {
  let ps = null;
  try { const r = await fetch(PS_URL, { signal: AbortSignal.timeout(1000) }); if (r.ok) ps = await r.json(); } catch {}
  return ps ? models(ps, readTail(path.join(home, '.ollama', 'logs', 'server.log')), home, now) : [];
}
