// Turns raw Claude Code hook payloads into a small, UI-friendly model of sessions and subagents.
import path from 'node:path';
import { validTty, validChat } from './focus.js';
import { readTranscript, MESSAGE_CHARS } from './transcript.js';
import { FOUND_WINDOW_MS } from './discover.js';

const STALE_MS = 6 * 60 * 60 * 1000;   // forget sessions that went silent (crashed without SessionEnd)
const RECENT_MAX = 200;
const TRANSCRIPT_RECHECK_MS = 5_000;    // between prompts and stops, re-read the transcript at most this often
const TASK_WAIT_MS = 2 * 60 * 1000;    // how long a launched Task/Agent call waits for its subagent to show up
const LATE_HOOK_MS = 10 * 1000;        // hooks post in parallel: a stopped subagent's last tool event can land after its SubagentStop

const clip = (s, n = 140) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// No project folder: a tool's background helper (Codex's app runs one in "/" when it opens), not a chat you started.
const isHelperDir = cwd => !cwd || cwd === '/';

export function entrypointLabel(raw) {
  if (!raw || raw === 'unknown') return 'unknown';
  if (raw.includes('desktop')) return 'desktop';
  if (raw === 'cli') return 'terminal';
  if (raw.startsWith('sdk')) return 'sdk';
  return raw;
}

// A short human description of what a tool call is doing.
export function summarizeTool(name, input = {}, cwd = '') {
  const rel = p => { if (!p) return ''; const r = cwd ? path.relative(cwd, p) : p; return r && !r.startsWith('..') ? r : p; };
  switch (name) {
    case 'Bash': return clip(input.command, 120);
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return rel(input.file_path || input.notebook_path);
    case 'Grep': return `"${clip(input.pattern, 60)}"${input.path ? ' in ' + rel(input.path) : ''}`;
    case 'Glob': return clip(input.pattern, 80);
    case 'WebFetch': return clip(input.url, 100);
    case 'WebSearch': return `"${clip(input.query, 80)}"`;
    case 'Task': case 'Agent': return clip(`${input.subagent_type || 'agent'}: ${input.description || ''}`, 100);
    case 'TodoWrite': return 'updating the task list';
    default:
      if (name?.startsWith('mcp__')) { const [, server, tool] = name.split('__'); return `${server} · ${tool}`; }
      return '';
  }
}

// A tool call that merges work: a PR merge (gh or a GitHub MCP tool), or merging a branch.
// Pulling main into a branch is only syncing, and `gh pr merge --auto` merges later, so neither counts.
const SYNC_REF = /^(main|master|trunk|develop|(origin|upstream)\/.+)$/;
export function isMerge(tool, input = {}) {
  if (tool?.startsWith('mcp__')) return /merge_pull_request|merge_pr$/.test(tool);
  if (tool !== 'Bash') return false;
  return String(input.command || '').split(/&&|\|\||[;|\n]/).some(part => {
    const w = part.trim().split(/\s+/); while (w.length && /^\w+=/.test(w[0])) w.shift();
    if (w[0] === 'gh') return w[1] === 'pr' && w[2] === 'merge' && !w.includes('--auto') && !w.includes('--disable-auto');
    if (w[0] !== 'git') return false;
    let i = 1; while (i < w.length && w[i].startsWith('-')) i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
    if (w[i] !== 'merge') return false;
    const args = w.slice(i + 1), refs = args.filter(x => !x.startsWith('-')).map(x => x.replace(/^['"]|['"]$/g, ''));
    if (args.includes('--abort') || args.includes('--quit')) return false;
    return args.includes('--continue') || (refs.length > 0 && !refs.some(r => SYNC_REF.test(r)));
  });
}

export class Store {
  constructor(read = readTranscript) { this.sessions = new Map(); this.recent = []; this.read = read; this.transcriptChecks = new Map(); this.pendingTasks = new Map();
    this.ended = new Set(); this.codexIds = new Set(); this.stoppedSubs = new Map(); }   // ended logs and imported hooks mustn't bring sessions back

  // Imported Claude hooks can report a Codex thread without the tool header. Only an exact
  // thread-id match proves it's the same session; sharing a project or terminal doesn't.
  claimCodex(agent, id) {
    if (agent !== 'codex' || !id.startsWith('codex:')) return null;
    const raw = id.slice(6); this.codexIds.add(raw);
    if (this.sessions.get(raw)?.agent !== 'claude-code') return null;
    this.sessions.delete(raw); this.transcriptChecks.delete(raw); this.pendingTasks.delete(raw);
    this.recent = this.recent.filter(e => e.sessionId !== raw);
    return raw;
  }

  // SubagentStart has no task description, but the parent's Task/Agent call just before it does.
  // Remember those calls and hand each new subagent the oldest one of its type.
  rememberTask(sid, input, now) {
    const q = (this.pendingTasks.get(sid) || []).filter(t => now - t.at < TASK_WAIT_MS);
    q.push({ type: input?.subagent_type || '', task: clip(input?.description, 40), at: now });
    this.pendingTasks.set(sid, q);
  }

  claimTask(sid, type, now) {
    const q = (this.pendingTasks.get(sid) || []).filter(t => now - t.at < TASK_WAIT_MS);
    let i = q.findIndex(t => t.type && t.type === type);
    if (i < 0) i = q.findIndex(t => !t.type || !type);
    const [t] = i < 0 ? [] : q.splice(i, 1);
    this.pendingTasks.set(sid, q);
    return t?.task || null;
  }

  // The chat's title and last messages from its transcript; until it has a title, its first prompt stands in.
  // Returns true when the messages changed, so only those events carry them.
  refreshTranscript(s, p, type) {
    const before = JSON.stringify(s.messages || []);
    if (type === 'UserPromptSubmit' && p.prompt) {
      if (!s.firstPrompt) s.firstPrompt = clip(p.prompt, 80);
      // The hook can fire before the prompt reaches the transcript: show it right away.
      const text = clip(p.prompt, MESSAGE_CHARS), m = s.messages || (s.messages = []);
      if (!m.length || m[m.length - 1].role !== 'user' || m[m.length - 1].text !== text) m.push({ role: 'user', text });
    }
    const now = Date.now(), last = this.transcriptChecks.get(s.id) || 0;
    const due = ['SessionStart', 'UserPromptSubmit', 'Stop'].includes(type) || now - last > TRANSCRIPT_RECHECK_MS;
    if (p.transcript_path && due) {
      this.transcriptChecks.set(s.id, now);
      const t = this.read(p.transcript_path);
      if (t) { if (t.title) s.transcriptTitle = t.title; if (t.messages.length && type !== 'UserPromptSubmit') s.messages = t.messages; }
    }
    s.title = s.transcriptTitle || s.firstPrompt || null;
    return JSON.stringify(s.messages || []) !== before;
  }

  snapshot() {
    this.prune();
    return { sessions: [...this.sessions.values()].map(s => ({ ...s, subagents: Object.values(s.subagents) })), recent: this.recent.slice(-80) };
  }

  prune() {
    const now = Date.now();
    // Found in a log and never heard from (fromLog): gone once the log goes quiet (it may have been a closed chat).
    for (const [id, s] of this.sessions) if (now - s.lastEventAt > (s.fromLog ? FOUND_WINDOW_MS : STALE_MS)) { this.sessions.delete(id); this.transcriptChecks.delete(id); this.pendingTasks.delete(id); }
    for (const [k, at] of this.stoppedSubs) if (now - at > LATE_HOOK_MS) this.stoppedSubs.delete(k);
  }

  // A permission request answered from the office: the session (or subagent) stops waiting.
  resolveWaiting(sessionId, agentId, activity) {
    const s = this.sessions.get(sessionId); if (!s) return null;
    const target = agentId ? s.subagents[agentId] : s; if (!target) return null;
    target.status = 'thinking'; target.activity = activity;
    const e = { type: 'PermissionResolved', sessionId, at: Date.now(), agentId: agentId || null, agentType: null, message: activity,
      session: { id: s.id, agent: s.agent, cwd: s.cwd, project: s.project, title: s.title || null, entrypoint: s.entrypoint, permissionMode: s.permissionMode, status: s.status, activity: s.activity } };
    this.recent.push(e); if (this.recent.length > RECENT_MAX) this.recent.shift();
    return e;
  }

  // A chat found in its log (discover.js): add it, or refresh it while no hook has reported on it.
  // Returns a SessionFound event when something on screen changes; hooks always win over logs.
  adopt(f) {
    if (f.agent === 'claude-code' && this.codexIds.has(f.id)) return null;
    const replacesSessionId = !isHelperDir(f.cwd) ? this.claimCodex(f.agent, f.id) : null;
    if (this.ended.has(f.id)) return null;
    let s = this.sessions.get(f.id), isNew = !s;
    if (s && !s.fromLog) return null;
    if (isNew && isHelperDir(f.cwd)) return null;
    if (isNew) {
      s = { id: f.id, agent: f.agent, cwd: f.cwd, project: f.project || path.basename(f.cwd) || 'session', entrypoint: entrypointLabel(f.entrypoint),
            startedAt: f.at, lastEventAt: f.at, status: f.status, activity: f.activity, permissionMode: 'default', subagents: {}, tool: null,
            title: f.title || null, transcriptTitle: f.title || null, messages: f.messages, fromLog: true };
      this.sessions.set(f.id, s);
    } else {
      s.lastEventAt = Math.max(s.lastEventAt, f.at);
      const title = f.title || s.transcriptTitle || null, messages = f.messages.length ? f.messages : s.messages;
      const changed = s.status !== f.status || s.activity !== f.activity || JSON.stringify(s.messages) !== JSON.stringify(messages) || s.title !== title;
      Object.assign(s, { status: f.status, activity: f.activity, messages, transcriptTitle: title, title });
      if (!changed) return null;
    }
    const e = { type: 'SessionFound', sessionId: s.id, at: Date.now(), agentId: null, agentType: null, message: isNew ? 'Already running' : null,
      session: { id: s.id, agent: s.agent, app: null, term: null, chat: null, cwd: s.cwd, project: s.project, title: s.title, merged: false,
                 entrypoint: s.entrypoint, permissionMode: s.permissionMode, status: s.status, activity: s.activity, messages: s.messages } };
    if (replacesSessionId) e.replacesSessionId = replacesSessionId;
    if (isNew) { this.recent.push(e); if (this.recent.length > RECENT_MAX) this.recent.shift(); }   // only the arrival goes in the feed
    return e;
  }

  // Found agents a poll no longer reports (Ollama unloaded the model) leave now, not after the usual quiet spell.
  // Returns their ids.
  retire(agent, keep) {
    const gone = [...this.sessions.values()].filter(s => s.agent === agent && s.fromLog && !keep.includes(s.id)).map(s => s.id);
    for (const id of gone) { this.sessions.delete(id); this.transcriptChecks.delete(id); this.pendingTasks.delete(id); }
    return gone;
  }

  // Returns the normalized event (or null if the payload is unusable).
  // projectDir is CLAUDE_PROJECT_DIR from the hook; it stays put when the session cds into a subfolder.
  // origin: { app, term, tty, chat } from the hook scripts, used for "Open in …" and "Open chat".
  ingest(p, entrypoint, projectDir, agent = 'claude-code', origin = {}) {
    const type = p.hook_event_name, sid = p.session_id;
    if (!type || !sid) return null;
    if (agent === 'claude-code' && this.codexIds.has(sid)) return null;
    const replacesSessionId = !isHelperDir(projectDir || p.cwd || '') ? this.claimCodex(agent, sid) : null;
    const now = Date.now();
    let s = this.sessions.get(sid);
    if (!s) {
      const root = projectDir || p.cwd || '';
      if (isHelperDir(root)) return null;
      s = { id: sid, agent, cwd: root, project: path.basename(root) || 'session', entrypoint: entrypointLabel(entrypoint),
            startedAt: now, lastEventAt: now, status: 'idle', activity: 'Session started', permissionMode: p.permission_mode || 'default',
            subagents: {}, tool: null };
      this.sessions.set(sid, s);
    }
    s.lastEventAt = now; s.fromLog = false;
    if (p.permission_mode) s.permissionMode = p.permission_mode;
    if (entrypoint && entrypoint !== 'unknown') s.entrypoint = entrypointLabel(entrypoint);
    if (origin.app) s.app = origin.app;
    if (origin.term) s.term = origin.term;
    if (validTty(origin.tty)) s.tty = origin.tty;
    if (validChat(origin.chat)) s.chat = origin.chat;
    const chatChanged = this.refreshTranscript(s, p, type);

    const e = { type, sessionId: sid, at: now, agentId: p.agent_id || null, agentType: p.agent_type || null };
    if (replacesSessionId) e.replacesSessionId = replacesSessionId;
    // Internal helper agents (e.g. the desktop app's prompt suggestions) only report SubagentStop. They never did visible work, so skip them.
    if (type === 'SubagentStop' && e.agentId && !s.subagents[e.agentId]) return null;
    // A straggler from a subagent that just stopped mustn't bring it back, stuck "thinking". A later one is a real resume.
    if (e.agentId && type !== 'SubagentStart' && now - (this.stoppedSubs.get(`${sid}\n${e.agentId}`) ?? -Infinity) < LATE_HOOK_MS) return null;
    const sub = e.agentId ? (s.subagents[e.agentId] ||= { id: e.agentId, type: e.agentType || 'subagent', task: this.claimTask(sid, e.agentType, now),
                                                          status: 'thinking', activity: 'Starting', startedAt: now }) : null;
    if (sub) e.agentTask = sub.task;
    const target = sub || s;

    switch (type) {
      case 'SessionStart': e.source = p.source; s.status = 'idle'; s.activity = p.source === 'resume' ? 'Session resumed' : 'Session started'; break;
      case 'UserPromptSubmit': e.prompt = clip(p.prompt, 160); s.merged = false; s.status = 'thinking'; s.activity = e.prompt || 'New prompt'; break;
      case 'PreToolUse':
        e.tool = p.tool_name; e.summary = summarizeTool(p.tool_name, p.tool_input, s.cwd);
        target.status = 'working'; target.activity = `${e.tool}${e.summary ? ' ' + e.summary : ''}`; target.tool = e.tool;
        if (!sub && (e.tool === 'Task' || e.tool === 'Agent')) this.rememberTask(sid, p.tool_input, now);
        break;
      case 'PostToolUse': case 'PostToolUseFailure':
        e.tool = p.tool_name; e.summary = summarizeTool(p.tool_name, p.tool_input, s.cwd); e.failed = type === 'PostToolUseFailure';
        target.status = 'thinking'; target.activity = e.failed ? `${e.tool} failed` : 'Thinking'; target.tool = null;
        if (!e.failed && isMerge(e.tool, p.tool_input)) { e.merged = true; s.merged = true; }
        break;
      case 'PermissionRequest':
        e.tool = p.tool_name; e.summary = summarizeTool(p.tool_name, p.tool_input, s.cwd);
        target.status = 'waiting'; target.activity = `Needs permission: ${e.tool}${e.summary ? ' ' + e.summary : ''}`; break;
      case 'Notification':
        e.message = clip(p.message, 160); e.notificationType = p.notification_type || null;
        if (e.notificationType === 'permission_prompt') { s.status = 'waiting'; s.activity = e.message || 'Needs your permission'; }
        else if (e.notificationType === 'idle_prompt') { s.status = 'idle'; s.activity = 'Waiting for your input'; }
        break;
      case 'Stop': s.status = 'done'; s.activity = s.merged ? 'Finished · merged' : 'Finished'; s.tool = null; break;
      case 'SubagentStart': if (sub) { sub.status = 'thinking'; sub.activity = 'Starting'; } break;
      case 'SubagentStop': if (sub) { sub.status = 'done'; sub.activity = 'Reported back'; e.message = clip(p.last_assistant_message, 160); delete s.subagents[e.agentId]; this.stoppedSubs.set(`${sid}\n${e.agentId}`, now); } break;
      case 'PreCompact': s.status = 'working'; s.activity = 'Compacting context'; break;
      case 'SessionEnd': e.reason = p.reason; this.ended.add(sid); this.sessions.delete(sid); this.transcriptChecks.delete(sid); this.pendingTasks.delete(sid); break;
      default: break;
    }
    e.session = { id: s.id, agent: s.agent, app: s.app || null, term: s.term || null, chat: s.chat || null, cwd: s.cwd, project: s.project, title: s.title || null, merged: !!s.merged, entrypoint: s.entrypoint, permissionMode: s.permissionMode, status: s.status, activity: s.activity };
    if (chatChanged) e.session.messages = s.messages;
    this.recent.push(e); if (this.recent.length > RECENT_MAX) this.recent.shift();
    return e;
  }
}
