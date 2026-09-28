import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, summarizeTool, entrypointLabel } from './store.js';
import { chatLink } from './focus.js';

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

test('opens the exact chat in the Claude and Codex apps, and only there', () => {
  const st = new Store();
  st.ingest({ ...base, hook_event_name: 'SessionStart' }, 'claude-desktop', undefined, 'claude-code', { app: 'com.anthropic.claudefordesktop', chat: 'local_ab-12' });
  const s = st.snapshot().sessions[0];
  assert.equal(chatLink(s).url, 'claude://code/continue?session=local_ab-12&source=agent_office');
  st.ingest({ ...base, session_id: 's2', hook_event_name: 'Stop' }, 'cli', undefined, 'claude-code', { chat: 'local_x&open=evil' });
  assert.equal(st.sessions.get('s2').chat, undefined);
  const id = 'codex:01a0e0d8-2f30-7311-b7ee-864db5ef85bd';
  assert.equal(chatLink({ agent: 'codex', id }).url, 'codex://threads/01a0e0d8-2f30-7311-b7ee-864db5ef85bd');
  assert.equal(chatLink({ agent: 'codex', id, term: 'Apple_Terminal' }), null);   // Codex CLI in a terminal: open the tab instead
  assert.equal(chatLink({ agent: 'codex', id: 'codex:../../x' }), null);
});

test('ignores payloads without a session or event name', () => {
  assert.equal(new Store().ingest({ hook_event_name: 'Stop' }), null);
});

test('names a session after its chat title, or its first prompt until there is one', () => {
  let title = null;
  const st = new Store(() => ({ title, messages: [] }));
  const t = { ...base, transcript_path: '/Users/me/.claude/projects/shop/s1.jsonl' };
  st.ingest({ ...t, hook_event_name: 'SessionStart' });
  assert.equal(st.snapshot().sessions[0].title, null);
  const e = st.ingest({ ...t, hook_event_name: 'UserPromptSubmit', prompt: 'fix the   cart total' });
  assert.equal(e.session.title, 'fix the cart total');
  title = 'Fix cart total rounding';
  assert.equal(st.ingest({ ...t, hook_event_name: 'Stop' }).session.title, 'Fix cart total rounding');
});

test('reads the latest custom title, falling back to the AI title', async () => {
  const { parseTranscript } = await import('./transcript.js');
  const titleFromText = text => parseTranscript(text).title;
  const ai = '{"type":"ai-title","aiTitle":"Locate storage"}', custom = n => `{"type":"custom-title","customTitle":"${n}"}`;
  assert.equal(titleFromText(`half a line"}\n${ai}\n`), 'Locate storage');
  assert.equal(titleFromText(`${custom('Old')}\n${ai}\n${custom('Checkout  bug')}\n`), 'Checkout bug');
  assert.equal(titleFromText('{"type":"user"}\n'), null);
});

test('spots merges, but not syncing with main or auto-merge', async () => {
  const { isMerge } = await import('./store.js');
  const bash = command => isMerge('Bash', { command });
  assert.ok(bash('gh pr merge 42 --squash --delete-branch'));
  assert.ok(bash('cd repo && GH_PROMPT_DISABLED=1 gh pr merge --merge'));
  assert.ok(bash('git merge --no-ff feature/cart'));
  assert.ok(bash('git -C ../shop merge --continue'));
  assert.ok(isMerge('mcp__github__merge_pull_request', {}));
  assert.ok(!bash('gh pr merge 42 --auto --squash'));
  assert.ok(!bash('git merge origin/main'));
  assert.ok(!bash('git merge main'));
  assert.ok(!bash('git merge --abort'));
  assert.ok(!bash('git merge-base HEAD main'));
  assert.ok(!bash('echo "gh pr merge"'));
  assert.ok(!isMerge('Read', { file_path: 'merge.ts' }));
});

test('marks the session merged until the next prompt', () => {
  const st = new Store(() => null);
  const e = st.ingest({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 7 --squash' } });
  assert.equal(e.merged, true); assert.equal(e.session.merged, true);
  assert.equal(st.ingest({ ...base, hook_event_name: 'Stop' }).session.activity, 'Finished · merged');
  assert.equal(st.ingest({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'next' }).session.merged, false);
  assert.equal(st.ingest({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'gh pr merge 7' } }).merged, undefined);
});

test('keeps the chat: prompts and text replies, not tools, thinking, subagents or system notes', async () => {
  const { parseTranscript } = await import('./transcript.js');
  const L = o => JSON.stringify(o);
  const text = [
    'cut in half"}',
    L({ type: 'user', message: { content: 'fix the cart' } }),
    L({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', name: 'Read' }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', content: 'file' }] } }),
    L({ type: 'user', isMeta: true, message: { content: 'meta' } }),
    L({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
    L({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent talk' }] } }),
    L({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed it.\n\n\n\n- rounding' }] } }),
  ].join('\n');
  assert.deepEqual(parseTranscript(text).messages, [{ role: 'user', text: 'fix the cart' }, { role: 'assistant', text: 'Fixed it.\n\n- rounding' }]);
});

test('sends the chat only when it changes, and shows a new prompt right away', () => {
  let messages = [{ role: 'assistant', text: 'Hi' }];
  const st = new Store(() => ({ title: null, messages }));
  const t = { ...base, transcript_path: '/Users/me/.claude/projects/shop/s1.jsonl' };
  assert.deepEqual(st.ingest({ ...t, hook_event_name: 'SessionStart' }).session.messages, [{ role: 'assistant', text: 'Hi' }]);
  assert.equal(st.ingest({ ...t, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }).session.messages, undefined);
  assert.deepEqual(st.ingest({ ...t, hook_event_name: 'UserPromptSubmit', prompt: 'next' }).session.messages.at(-1), { role: 'user', text: 'next' });
  messages = [...messages, { role: 'user', text: 'next' }, { role: 'assistant', text: 'Done' }];
  assert.equal(st.ingest({ ...t, hook_event_name: 'Stop' }).session.messages.at(-1).text, 'Done');
});
