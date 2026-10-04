import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, summarizeTool, entrypointLabel } from './store.js';
import { chatLink } from './focus.js';

const base = { session_id: 's1', cwd: '/Users/me/code/shop', permission_mode: 'default' };

test('a Codex thread replaces its imported Claude ghost in either arrival order', () => {
  for (const claudeFirst of [true, false]) {
    const st = new Store(), p = { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the UI' };
    if (claudeFirst) st.ingest(p);
    const e = st.ingest({ ...p, session_id: 'codex:s1' }, 'codex-tui', null, 'codex');
    assert.equal(e.replacesSessionId, claudeFirst ? 's1' : undefined);
    assert.equal(st.ingest({ ...p, hook_event_name: 'Stop' }), null);
    assert.deepEqual(st.snapshot().sessions.map(s => [s.id, s.agent, s.status]), [['codex:s1', 'codex', 'thinking']]);
    assert.ok(st.snapshot().recent.every(e => e.sessionId !== 's1'));
    st.ingest({ ...p, session_id: 'codex:s1', hook_event_name: 'SessionEnd' }, null, null, 'codex');
    assert.equal(st.ingest(p), null);
    assert.equal(st.snapshot().sessions.length, 0);
  }
});

test('Codex discovery removes the imported ghost but keeps independent Claude sessions in the same project', () => {
  const st = new Store(), p = { ...base, hook_event_name: 'SessionStart' };
  st.ingest(p); st.ingest({ ...p, session_id: 'real-claude' }, 'cli');
  const f = { id: 'codex:s1', agent: 'codex', cwd: base.cwd, entrypoint: 'codex-tui', at: Date.now(), status: 'working', activity: 'Working', title: null, messages: [] };
  assert.equal(st.adopt(f).replacesSessionId, 's1');
  assert.equal(st.adopt({ ...f, id: 's1', agent: 'claude-code' }), null);
  assert.deepEqual(st.snapshot().sessions.map(s => s.id).sort(), ['codex:s1', 'real-claude']);
});

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

test('a tool event that lands after its SubagentStop does not bring the subagent back', () => {
  const st = new Store(), sub = { ...base, agent_id: 'x1', agent_type: 'default' };
  st.ingest({ ...sub, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  st.ingest({ ...sub, hook_event_name: 'SubagentStop' });
  assert.equal(st.ingest({ ...sub, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), null);
  assert.equal(st.snapshot().sessions[0].subagents.length, 0);
  st.ingest({ ...sub, hook_event_name: 'SubagentStart' });                     // resumed for real
  assert.equal(st.snapshot().sessions[0].subagents.length, 1);
});

test('names subagents after the task they were given', () => {
  const st = new Store();
  const launch = (t, d) => st.ingest({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: t, description: d } });
  launch('Explore', 'Find cart code'); launch('Plan', 'Plan checkout');
  assert.equal(st.ingest({ ...base, hook_event_name: 'SubagentStart', agent_id: 'p1', agent_type: 'Plan' }).agentTask, 'Plan checkout');
  st.ingest({ ...base, hook_event_name: 'SubagentStart', agent_id: 'x1', agent_type: 'Explore' });
  st.ingest({ ...base, hook_event_name: 'SubagentStart', agent_id: 'x2', agent_type: 'Explore' });
  const subs = st.snapshot().sessions[0].subagents;
  assert.equal(subs[1].task, 'Find cart code'); assert.equal(subs[2].task, null);
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

test('skips background helpers that run in no project folder', () => {
  const st = new Store(() => null);
  assert.equal(st.ingest({ hook_event_name: 'SessionStart', session_id: 'codex:h1', cwd: '/' }, null, null, 'codex'), null);
  assert.equal(st.adopt({ agent: 'codex', id: 'codex:h2', cwd: '/', at: Date.now(), status: 'done', activity: 'Finished', title: null, messages: [] }), null);
  assert.equal(st.sessions.size, 0);
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

const found = (id, status, at = Date.now()) => ({ agent: 'claude-code', id, cwd: '/Users/me/code/shop', entrypoint: 'claude-desktop', at, status, activity: 'Working', title: 'Fix cart', messages: [] });

test('adopts chats found in logs until a hook takes over', () => {
  const st = new Store(() => null);
  const e = st.adopt(found('s1', 'working'));
  assert.deepEqual([e.type, e.message, e.session.title, e.session.project, e.session.entrypoint], ['SessionFound', 'Already running', 'Fix cart', 'shop', 'desktop']);
  assert.equal(st.adopt(found('s1', 'working')), null);                   // nothing changed
  assert.equal(st.adopt(found('s1', 'done')).message, null);              // a refresh, not a new arrival
  st.ingest({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'next' });
  assert.equal(st.adopt(found('s1', 'done')), null);                      // hooks win from now on
  const s = st.sessions.get('s1');
  assert.deepEqual([st.sessions.size, s.status, s.title], [1, 'thinking', 'Fix cart']);
});

test('ended chats stay gone and unheard ones leave when their log goes quiet', () => {
  const st = new Store(() => null);
  st.adopt(found('s1', 'done'));
  st.ingest({ ...base, hook_event_name: 'SessionEnd' });
  assert.equal(st.adopt(found('s1', 'done')), null);
  st.adopt(found('s2', 'done', Date.now() - 31 * 60 * 1000));
  st.prune();
  assert.equal(st.sessions.size, 0);
});
