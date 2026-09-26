// Turns raw Claude Code hook payloads into a small, UI-friendly model of sessions and subagents.
import path from 'node:path';

const STALE_MS = 6 * 60 * 60 * 1000;   // forget sessions that went silent (crashed without SessionEnd)
const RECENT_MAX = 200;

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

export class Store {
  constructor() { this.sessions = new Map(); this.recent = []; }

  snapshot() {
    this.prune();
    return { sessions: [...this.sessions.values()].map(s => ({ ...s, subagents: Object.values(s.subagents) })), recent: this.recent.slice(-80) };
  }

  prune() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastEventAt > STALE_MS) this.sessions.delete(id);
  }

  // A permission request answered from the office: the session (or subagent) stops waiting.
  resolveWaiting(sessionId, agentId, activity) {
    const s = this.sessions.get(sessionId); if (!s) return null;
    const target = agentId ? s.subagents[agentId] : s; if (!target) return null;
    target.status = 'thinking'; target.activity = activity;
    const e = { type: 'PermissionResolved', sessionId, at: Date.now(), agentId: agentId || null, agentType: null, message: activity,
      session: { id: s.id, agent: s.agent, cwd: s.cwd, project: s.project, entrypoint: s.entrypoint, permissionMode: s.permissionMode, status: s.status, activity: s.activity } };
    this.recent.push(e); if (this.recent.length > RECENT_MAX) this.recent.shift();
    return e;
  }

  // Returns the normalized event (or null if the payload is unusable).
  // projectDir is CLAUDE_PROJECT_DIR from the hook; it stays put when the session cds into a subfolder.
  ingest(p, entrypoint, projectDir, agent = 'claude-code') {
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

    const e = { type, sessionId: sid, at: now, agentId: p.agent_id || null, agentType: p.agent_type || null };
    // Internal helper agents (e.g. the desktop app's prompt suggestions) only report SubagentStop. They never did visible work, so skip them.
    if (type === 'SubagentStop' && e.agentId && !s.subagents[e.agentId]) return null;
    const sub = e.agentId ? (s.subagents[e.agentId] ||= { id: e.agentId, type: e.agentType || 'subagent', status: 'thinking', activity: 'Starting', startedAt: now }) : null;
    const target = sub || s;

    switch (type) {
      case 'SessionStart': e.source = p.source; s.status = 'idle'; s.activity = p.source === 'resume' ? 'Session resumed' : 'Session started'; break;
      case 'UserPromptSubmit': e.prompt = clip(p.prompt, 160); s.status = 'thinking'; s.activity = e.prompt || 'New prompt'; break;
      case 'PreToolUse':
        e.tool = p.tool_name; e.summary = summarizeTool(p.tool_name, p.tool_input, s.cwd);
        target.status = 'working'; target.activity = `${e.tool}${e.summary ? ' ' + e.summary : ''}`; target.tool = e.tool; break;
      case 'PostToolUse': case 'PostToolUseFailure':
        e.tool = p.tool_name; e.summary = summarizeTool(p.tool_name, p.tool_input, s.cwd); e.failed = type === 'PostToolUseFailure';
        target.status = 'thinking'; target.activity = e.failed ? `${e.tool} failed` : 'Thinking'; target.tool = null; break;
      case 'PermissionRequest':
        e.tool = p.tool_name; e.summary = summarizeTool(p.tool_name, p.tool_input, s.cwd);
        target.status = 'waiting'; target.activity = `Needs permission: ${e.tool}${e.summary ? ' ' + e.summary : ''}`; break;
      case 'Notification':
        e.message = clip(p.message, 160); e.notificationType = p.notification_type || null;
        if (e.notificationType === 'permission_prompt') { s.status = 'waiting'; s.activity = e.message || 'Needs your permission'; }
        else if (e.notificationType === 'idle_prompt') { s.status = 'idle'; s.activity = 'Waiting for your input'; }
        break;
      case 'Stop': s.status = 'done'; s.activity = 'Finished'; s.tool = null; break;
      case 'SubagentStart': if (sub) { sub.status = 'thinking'; sub.activity = 'Starting'; } break;
      case 'SubagentStop': if (sub) { sub.status = 'done'; sub.activity = 'Reported back'; e.message = clip(p.last_assistant_message, 160); delete s.subagents[e.agentId]; } break;
      case 'PreCompact': s.status = 'working'; s.activity = 'Compacting context'; break;
      case 'SessionEnd': e.reason = p.reason; this.sessions.delete(sid); break;
      default: break;
    }
    e.session = { id: s.id, agent: s.agent, cwd: s.cwd, project: s.project, entrypoint: s.entrypoint, permissionMode: s.permissionMode, status: s.status, activity: s.activity };
    this.recent.push(e); if (this.recent.length > RECENT_MAX) this.recent.shift();
    return e;
  }
}
