import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, claudeTool } from './adapters.js';
import { Store } from './store.js';

test('passes Claude Code payloads through untouched', () => {
  const p = { hook_event_name: 'Stop', session_id: 's1', cwd: '/x' };
  assert.deepEqual(normalize('claude-code', p), p);
});

test('maps tool names from other agents onto Claude tools', () => {
  assert.equal(claudeTool('run_shell_command'), 'Bash');
  assert.equal(claudeTool('apply_patch'), 'Edit');
  assert.equal(claudeTool('mcp__github__create_issue'), 'mcp__github__create_issue');
});

test('Codex: Claude-style events, apply_patch becomes an Edit of the patched file', () => {
  const e = normalize('codex', { hook_event_name: 'PreToolUse', session_id: 'c1', cwd: '/repo', tool_name: 'apply_patch',
    tool_input: { input: '*** Begin Patch\n*** Update File: src/app.ts\n@@' } });
  assert.equal(e.session_id, 'codex:c1');
  assert.equal(e.tool_name, 'Edit');
  assert.equal(e.tool_input.file_path, 'src/app.ts');
  assert.equal(normalize('codex', { hook_event_name: 'Interrupt', session_id: 'c1' }).hook_event_name, 'Stop');
});

test('Gemini CLI: BeforeTool/AfterAgent and tool-permission notifications', () => {
  const pre = normalize('gemini', { hook_event_name: 'BeforeTool', session_id: 'g1', cwd: '/repo', tool_name: 'run_shell_command', tool_input: { command: 'npm test' } });
  assert.deepEqual([pre.hook_event_name, pre.tool_name, pre.tool_input.command], ['PreToolUse', 'Bash', 'npm test']);
  assert.equal(normalize('gemini', { hook_event_name: 'AfterAgent', session_id: 'g1' }).hook_event_name, 'Stop');
  assert.equal(normalize('gemini', { hook_event_name: 'Notification', session_id: 'g1', notification_type: 'ToolPermission' }).notification_type, 'permission_prompt');
  assert.equal(normalize('gemini', { hook_event_name: 'BeforeModel', session_id: 'g1' }), null);
});

test('Cursor: conversation id, workspace root and subagents', () => {
  const start = normalize('cursor', { hook_event_name: 'sessionStart', conversation_id: 'k1', workspace_roots: ['/Users/me/shop'] });
  assert.deepEqual([start.hook_event_name, start.session_id, start.cwd], ['SessionStart', 'cursor:k1', '/Users/me/shop']);
  const sub = normalize('cursor', { hook_event_name: 'subagentStart', conversation_id: 'k2', parent_conversation_id: 'k1', subagent_id: 'sa', subagent_type: 'explore' });
  assert.deepEqual([sub.session_id, sub.agent_id, sub.agent_type], ['cursor:k1', 'sa', 'explore']);
});

test('Copilot CLI: event name comes from hook.sh, camelCase fields and JSON-string args', () => {
  const e = normalize('copilot', { sessionId: 'p1', cwd: '/repo', toolName: 'bash', toolArgs: '{"command":"ls"}' }, 'preToolUse');
  assert.deepEqual([e.hook_event_name, e.session_id, e.tool_name, e.tool_input.command], ['PreToolUse', 'copilot:p1', 'Bash', 'ls']);
  assert.equal(normalize('copilot', { sessionId: 'p1' }, 'agentStop').hook_event_name, 'Stop');
});

test('a translated session lands in the store with its project and agent', () => {
  const st = new Store();
  const e = normalize('gemini', { hook_event_name: 'BeforeAgent', session_id: 'g9', cwd: '/Users/me/shop', prompt: 'fix it' });
  st.ingest(e, 'unknown', undefined, 'gemini');
  const s = st.snapshot().sessions[0];
  assert.deepEqual([s.project, s.agent, s.status, s.activity], ['shop', 'gemini', 'thinking', 'fix it']);
});
