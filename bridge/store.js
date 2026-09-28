// Turns raw Claude Code hook payloads into a small, UI-friendly model of sessions and subagents.
import path from 'node:path';
import { validTty, validChat } from './focus.js';
import { transcriptTitle } from './title.js';

const STALE_MS = 6 * 60 * 60 * 1000;   // forget sessions that went silent (crashed without SessionEnd)
const RECENT_MAX = 200;
const TITLE_RECHECK_MS = 10_000;        // while a chat has no title yet, look again at most this often

const clip = (s, n = 140) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

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
  constructor(readTitle = transcriptTitle) { this.sessions = new Map(); this.recent = []; this.readTitle = readTitle; this.titleChecks = new Map(); }

  // The chat's title from its transcript; until there is one, its first prompt stands in.
  refreshTitle(s, p, type) {
    if (type === 'UserPromptSubmit' && !s.firstPrompt && p.prompt) s.firstPrompt = clip(p.prompt, 80);
    const now = Date.now(), last = this.titleChecks.get(s.id) || 0;
    const due = ['SessionStart', 'UserPromptSubmit', 'Stop'].includes(type) || (!s.transcriptTitle && now - last > TITLE_RECHECK_MS);
    if (p.transcript_path && due) { this.titleChecks.set(s.id, now); s.transcriptTitle = this.readTitle(p.transcript_path) || s.transcriptTitle || null; }
    s.title = s.transcriptTitle || s.firstPrompt || null;
  }

  snapshot() {
    this.prune();
    return { sessions: [...this.sessions.values()].map(s => ({ ...s, subagents: Object.values(s.subagents) })), recent: this.recent.slice(-80) };
  }

  prune() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastEventAt > STALE_MS) { this.sessions.delete(id); this.titleChecks.delete(id); }
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

  // Returns the normalized event (or null if the payload is unusable).
  // projectDir is CLAUDE_PROJECT_DIR from the hook; it stays put when the session cds into a subfolder.
  // origin: { app, term, tty, chat } from the hook scripts, used for "Open in …" and "Open chat".
  ingest(p, entrypoint, projectDir, agent = 'claude-code', origin = {}) {
    const type = p.hook_event_name, sid = p.session_id;
    if (!type || !sid) return null;
    const now = Date.now();
    let s = this.sessions.get(sid);
    if (!s) {
      const root = projectDir || p.cwd || '';
      s = { id: sid, agent, cwd: root, project: path.basename(root) || 'session', entrypoint: entrypointLabel(entrypoint),
            startedAt: now, lastEventAt: now, status: 'idle', activity: 'Session started', permissionMode: p.permission_mode || 'default',
            subagents: {}, tool: null };
      this.sessions.set(sid, s);
    }
    s.lastEventAt = now;
    if (p.permission_mode) s.permissionMode = p.permission_mode;
    if (entrypoint && entrypoint !== 'unknown') s.entrypoint = entrypointLabel(entrypoint);
    if (origin.app) s.app = origin.app;
    if (origin.term) s.term = origin.term;
    if (validTty(origin.tty)) s.tty = origin.tty;
    if (validChat(origin.chat)) s.chat = origin.chat;
    this.refreshTitle(s, p, type);

    const e = { type, sessionId: sid, at: now, agentId: p.agent_id || null, agentType: p.agent_type || null };
    // Internal helper agents (e.g. the desktop app's prompt suggestions) only report SubagentStop. They never did visible work, so skip them.
    if (type === 'SubagentStop' && e.agentId && !s.subagents[e.agentId]) return null;
    const sub = e.agentId ? (s.subagents[e.agentId] ||= { id: e.agentId, type: e.agentType || 'subagent', status: 'thinking', activity: 'Starting', startedAt: now }) : null;
    const target = sub || s;

    switch (type) {
      case 'SessionStart': e.source = p.source; s.status = 'idle'; s.activity = p.source === 'resume' ? 'Session resumed' : 'Session started'; break;
      case 'UserPromptSubmit': e.prompt = clip(p.prompt, 160); s.merged = false; s.status = 'thinking'; s.activity = e.prompt || 'New prompt'; break;
      case 'PreToolUse':
        e.tool = p.tool_name; e.summary = summarizeTool(p.tool_name, p.tool_input, s.cwd);
        target.status = 'working'; target.activity = `${e.tool}${e.summary ? ' ' + e.summary : ''}`; target.tool = e.tool; break;
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
      case 'SubagentStop': if (sub) { sub.status = 'done'; sub.activity = 'Reported back'; e.message = clip(p.last_assistant_message, 160); delete s.subagents[e.agentId]; } break;
      case 'PreCompact': s.status = 'working'; s.activity = 'Compacting context'; break;
      case 'SessionEnd': e.reason = p.reason; this.sessions.delete(sid); this.titleChecks.delete(sid); break;
      default: break;
    }
    e.session = { id: s.id, agent: s.agent, app: s.app || null, term: s.term || null, chat: s.chat || null, cwd: s.cwd, project: s.project, title: s.title || null, merged: !!s.merged, entrypoint: s.entrypoint, permissionMode: s.permissionMode, status: s.status, activity: s.activity };
    this.recent.push(e); if (this.recent.length > RECENT_MAX) this.recent.shift();
    return e;
  }
}
