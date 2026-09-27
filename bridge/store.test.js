import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, summarizeTool, entrypointLabel } from './store.js';

const base = { session_id: 's1', cwd: '/Users/me/code/shop', permission_mode: 'default' };

test('labels where the session runs', () => {
  assert.equal(entrypointLabel('claude-desktop'), 'desktop');
  assert.equal(entrypointLabel('cli'), 'terminal');
  assert.equal(entrypointLabel(undefined), 'unknown');
});

test('summarizes tool calls relative to the project', () => {
  assert.equal(summarizeTool('Read', { file_path: '/Users/me/code/shop/src/a.ts' }, '/Users/me/code/shop'), 'src/a.ts');
  assert.equal(summarizeTool('Bash', { command: 'npm   test' }), 'npm test');
  assert.equal(summarizeTool('mcp__github__create_issue', {}), 'github · create_issue');
});

test('tracks a session through a prompt, a tool call and a stop', () => {
  const st = new Store();
  st.ingest({ ...base, hook_event_name: 'SessionStart', source: 'startup' }, 'cli');
  st.ingest({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix the cart' });
  const pre = st.ingest({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/Users/me/code/shop/cart.ts' } });
  assert.equal(pre.summary, 'cart.ts');
  let s = st.snapshot().sessions[0];
  assert.equal(s.project, 'shop'); assert.equal(s.entrypoint, 'terminal'); assert.equal(s.status, 'working');
  st.ingest({ ...base, hook_event_name: 'Stop' });
  assert.equal(st.snapshot().sessions[0].status, 'done');
});

test('routes subagent tool calls to the subagent and removes it when it stops', () => {
  const st = new Store();
  st.ingest({ ...base, hook_event_name: 'SubagentStart', agent_id: 'x1', agent_type: 'Explore' });
  st.ingest({ ...base, hook_event_name: 'PreToolUse', agent_id: 'x1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'cart' } });
  let s = st.snapshot().sessions[0];
  assert.equal(s.subagents[0].status, 'working'); assert.equal(s.status, 'idle');
  st.ingest({ ...base, hook_event_name: 'SubagentStop', agent_id: 'x1', agent_type: 'Explore' });
  assert.equal(st.snapshot().sessions[0].subagents.length, 0);
});

test('permission prompts mark the session as waiting and SessionEnd forgets it', () => {
  const st = new Store();
  st.ingest({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(st.snapshot().sessions[0].status, 'waiting');
  st.ingest({ ...base, hook_event_name: 'SessionEnd', reason: 'exit' });
  assert.equal(st.snapshot().sessions.length, 0);
});

test('skips helper agents that only report SubagentStop', () => {
  const st = new Store();
  const e = st.ingest({ ...base, hook_event_name: 'SubagentStop', agent_id: 'helper', last_assistant_message: 'make it public' });
  assert.equal(e, null);
  assert.equal(st.snapshot().recent.length, 0);
});

test('files the session under the project folder, not the current folder', () => {
  const st = new Store();
  st.ingest({ ...base, cwd: '/Users/me/code/shop/src/cart', hook_event_name: 'SessionStart' }, 'cli', '/Users/me/code/shop');
  assert.equal(st.snapshot().sessions[0].project, 'shop');
});

test('remembers where the session runs, ignoring bad tty values', () => {
  const st = new Store();
  st.ingest({ ...base, hook_event_name: 'SessionStart' }, 'cli', undefined, 'claude-code', { app: 'com.apple.Terminal', term: 'Apple_Terminal', tty: 'ttys004' });
  st.ingest({ ...base, hook_event_name: 'Stop' }, 'cli', undefined, 'claude-code', { tty: '"; rm -rf ~' });
  const s = st.snapshot().sessions[0];
  assert.deepEqual([s.app, s.term, s.tty], ['com.apple.Terminal', 'Apple_Terminal', 'ttys004']);
});

test('ignores payloads without a session or event name', () => {
  assert.equal(new Store().ingest({ hook_event_name: 'Stop' }), null);
});
