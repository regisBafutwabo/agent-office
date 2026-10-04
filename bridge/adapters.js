// Translate other coding agents' hook payloads into the Claude Code shape that store.js understands.
// Event and field names come from each vendor's docs (checked 2026-09-27, see docs/adapters.md).
// Lines marked "unverified" are best guesses where the docs didn't show the exact field.

const TOOL_ALIASES = {
  bash: 'Bash', shell: 'Bash', run_shell_command: 'Bash', run_terminal_cmd: 'Bash', execute_command: 'Bash', terminal: 'Bash',
  read: 'Read', read_file: 'Read', view: 'Read', read_many_files: 'Read',
  write: 'Write', write_file: 'Write', create: 'Write', write_to_file: 'Write',
  edit: 'Edit', edit_file: 'Edit', replace: 'Edit', str_replace: 'Edit', apply_patch: 'Edit', search_replace: 'Edit', replace_in_file: 'Edit',
  grep: 'Grep', search_file_content: 'Grep', search_files: 'Grep', codebase_search: 'Grep',
  glob: 'Glob', list_directory: 'Glob', list_files: 'Glob', file_search: 'Glob', ls: 'Glob',
  web_fetch: 'WebFetch', fetch: 'WebFetch', google_web_search: 'WebSearch', web_search: 'WebSearch',
  task: 'Task', agent: 'Task', subagent: 'Task', spawn_agent: 'Task',
};
export const AGENTS = ['claude-code', 'codex', 'cursor', 'gemini', 'copilot', 'factory', 'qwen', 'goose', 'kiro', 'windsurf', 'cline', 'opencode', 'amp'];

export function claudeTool(name) {
  if (!name || name.startsWith('mcp__')) return name;
  return TOOL_ALIASES[name] || TOOL_ALIASES[name.toLowerCase()] || name;
}

// Map common argument names onto Claude's (command, file_path, pattern, url, query).
export function claudeInput(tool, input) {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
  const i = input || {}, out = { ...i };
  out.command ??= i.cmd ?? i.command_line;
  out.file_path ??= i.absolute_path ?? i.target_file ?? i.filePath ?? (tool !== 'Grep' && tool !== 'Glob' ? i.path : undefined);
  if (tool === 'Grep' || tool === 'Glob') out.pattern ??= i.query ?? i.regex ?? i.glob;
  if (tool === 'WebSearch') out.query ??= i.q ?? i.search_term;
  if (tool === 'Task') { out.description ??= i.task_name; out.subagent_type ??= i.agent_type; }   // Codex spawn_agent; its message is encrypted
  if (tool === 'Edit' && !out.file_path) {                         // Codex apply_patch carries the patch text
    const m = String(i.input ?? i.patch ?? i.command ?? '').match(/\*\*\* (?:Update|Add|Delete) File: (.+)/);
    if (m) out.file_path = m[1].trim();
  }
  return out;
}

const lcFirst = s => s ? s[0].toLowerCase() + s.slice(1) : s;

// Rename the event and normalize tool fields; returns null for events the office doesn't show.
function reshape(p, name, extra = {}) {
  if (!name) return null;
  const out = { ...p, ...extra, hook_event_name: name };
  if (out.tool_name) { out.tool_name = claudeTool(out.tool_name); out.tool_input = claudeInput(out.tool_name, out.tool_input); }
  return out;
}

const CLAUDE_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact']);
const claudeLike = (p, renames = {}) => {
  const n = p.hook_event_name;
  return reshape(p, n in renames ? renames[n] : CLAUDE_EVENTS.has(n) ? n : null);
};

const ADAPTERS = {
  'claude-code': p => p,
  // Same event names and fields as Claude Code.
  codex: p => claudeLike(p, { Interrupt: 'Stop' }),
  qwen: p => claudeLike(p),
  factory: p => claudeLike(p),
  gemini: p => {
    const name = { BeforeAgent: 'UserPromptSubmit', AfterAgent: 'Stop', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse',
      PreCompress: 'PreCompact', SessionStart: 'SessionStart', SessionEnd: 'SessionEnd', Notification: 'Notification' }[p.hook_event_name];
    const out = reshape(p, name);                                  // BeforeModel/AfterModel are too chatty to show
    if (out && name === 'Notification' && p.notification_type === 'ToolPermission') out.notification_type = 'permission_prompt';
    return out;
  },
  cursor: p => {
    const name = { sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', beforeSubmitPrompt: 'UserPromptSubmit', preToolUse: 'PreToolUse',
      postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUseFailure', subagentStart: 'SubagentStart', subagentStop: 'SubagentStop',
      preCompact: 'PreCompact', stop: 'Stop' }[p.hook_event_name];
    const sub = name && name.startsWith('Subagent');
    return reshape(p, name, {
      session_id: (sub && p.parent_conversation_id) || p.conversation_id || p.session_id,
      cwd: p.cwd || (p.workspace_roots || [])[0] || '',
      ...(p.subagent_id ? { agent_id: p.subagent_id, agent_type: p.subagent_type || 'subagent' } : {}),
    });
  },
  // Copilot CLI payloads don't name the event, so hook.sh passes it as the second argument.
  copilot: (p, event) => {
    const n = p.hook_event_name || p.hookEventName || event;
    const name = { sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', userPromptSubmitted: 'UserPromptSubmit', preToolUse: 'PreToolUse',
      postToolUse: 'PostToolUse', postToolUseFailure: 'PostToolUseFailure', agentStop: 'Stop', subagentStart: 'SubagentStart',
      subagentStop: 'SubagentStop', preCompact: 'PreCompact', notification: 'Notification', permissionRequest: 'PermissionRequest' }[lcFirst(n)];
    return reshape(p, name, { session_id: p.sessionId || p.session_id, tool_name: p.toolName || p.tool_name, tool_input: p.toolArgs ?? p.tool_input });
  },
  goose: p => {
    const n = p.hook_event_name || p.event;
    return reshape(p, CLAUDE_EVENTS.has(n) ? n : null, { cwd: p.cwd || p.working_dir, prompt: p.prompt ?? p.message });
  },
  kiro: p => {                                                    // exact trigger strings unverified
    const name = { promptsubmit: 'UserPromptSubmit', agentstop: 'Stop', sessionstart: 'SessionStart', agentspawn: 'SessionStart',
      pretooluse: 'PreToolUse', posttooluse: 'PostToolUse' }[String(p.hook_event_name || '').toLowerCase()];
    return reshape(p, name);
  },
  windsurf: p => {                                                // tool_info sub-fields unverified
    const t = p.tool_info || {};
    const [name, tool] = {
      pre_user_prompt: ['UserPromptSubmit'], post_cascade_response: ['Stop'],
      pre_run_command: ['PreToolUse', 'Bash'], post_run_command: ['PostToolUse', 'Bash'],
      pre_read_code: ['PreToolUse', 'Read'], post_read_code: ['PostToolUse', 'Read'],
      pre_write_code: ['PreToolUse', 'Edit'], post_write_code: ['PostToolUse', 'Edit'],
      pre_mcp_tool_use: ['PreToolUse', `mcp__${t.mcp_server_name}__${t.mcp_tool_name}`], post_mcp_tool_use: ['PostToolUse', `mcp__${t.mcp_server_name}__${t.mcp_tool_name}`],
    }[p.agent_action_name] || [];
    return reshape(p, name, { session_id: p.trajectory_id, cwd: t.cwd || '', prompt: t.user_prompt, tool_name: tool,
      tool_input: tool ? { command: t.command_line, file_path: t.file_path } : undefined });
  },
  cline: p => {                                                   // payload nesting unverified: accept both flat and per-hook objects
    const d = p[lcFirst(p.hookName)] || p;
    const name = { TaskStart: 'SessionStart', TaskResume: 'SessionStart', TaskCancel: 'Stop', TaskComplete: 'Stop',
      UserPromptSubmit: 'UserPromptSubmit', PreToolUse: 'PreToolUse', PostToolUse: 'PostToolUse' }[p.hookName];
    return reshape(p, name, { session_id: p.taskId, cwd: (p.workspaceRoots || [])[0] || '', prompt: d.prompt,
      tool_name: d.toolName, tool_input: d.parameters, source: p.hookName === 'TaskResume' ? 'resume' : undefined });
  },
  // OpenCode and Amp use in-process plugins (adapters/opencode, adapters/amp) that already send Claude-shaped events.
  opencode: p => claudeLike(p),
  amp: p => claudeLike(p),
};

/**
 * @param {string} agent  which tool sent it (hook.sh's first argument); unknown tools are treated as Claude-shaped
 * @param {object} payload raw hook payload
 * @param {string} [event] event name, for tools whose payload doesn't carry one
 * @returns a Claude-shaped payload with a namespaced session id, or null to ignore
 */
export function normalize(agent, payload, event) {
  const out = (ADAPTERS[agent] || claudeLike)(payload || {}, event);
  if (!out || !out.session_id) return null;
  if (agent !== 'claude-code') out.session_id = `${agent}:${out.session_id}`;   // no collisions between tools
  return out;
}
