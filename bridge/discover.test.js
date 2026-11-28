import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, encode, decode, settle, archivedChats, desktopSessionsDir, FOUND_WINDOW_MS, promptTitle, cursorDone, CURSOR_QUIET_MS } from './discover.js';

const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `agent-office-discover-${name}-`));
const write = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join('')); };

test('finds Claude chats filed under their project and skips SDK helpers', () => {
  const home = tmp('claude'), shop = path.join(home, 'code', 'shop');
  fs.mkdirSync(path.join(shop, 'src'), { recursive: true });
  const folder = path.join(home, '.claude', 'projects', encode(shop));
  write(path.join(folder, 's1.jsonl'), [
    { type: 'user', cwd: path.join(shop, 'src'), entrypoint: 'cli', message: { content: 'fix the cart' } },
    { type: 'assistant', cwd: path.join(shop, 'src'), entrypoint: 'cli', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
    { type: 'ai-title', aiTitle: 'Fix cart' },
  ]);
  write(path.join(folder, 's2.jsonl'), [{ type: 'user', cwd: shop, entrypoint: 'sdk-cli', message: { content: 'observe' } }]);
  const found = scan(home);
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].id, found[0].cwd, found[0].status, found[0].title, found[0].messages[0].text], ['s1', shop, 'working', 'Fix cart', 'fix the cart']);
  assert.deepEqual(scan(home, Date.now() + FOUND_WINDOW_MS + 60_000), []);
});

test('finds Codex threads you started but not imports or subagents', () => {
  const home = tmp('codex'), day = path.join(home, '.codex', 'sessions', '2026', '10', '01');
  const meta = (id, source) => ({ type: 'session_meta', payload: { id, session_id: id, cwd: '/repo', originator: 'codex_cli_rs', thread_source: source } });
  write(path.join(day, 'rollout-a.jsonl'), [meta('t1', 'user'), { type: 'event_msg', payload: { type: 'task_started' } }, { type: 'event_msg', payload: { type: 'task_complete' } }]);
  // A real subagent names its parent; a thread T3 Code starts says "subagent" but has none, and is a chat of its own.
  write(path.join(day, 'rollout-b.jsonl'), [{ type: 'session_meta', payload: { ...meta('t2', 'subagent').payload, parent_thread_id: 't1', source: { subagent: { thread_spawn: { parent_thread_id: 't1', depth: 1 } } } } }]);
  write(path.join(day, 'rollout-d.jsonl'), [{ type: 'session_meta', payload: { ...meta('t4', 'subagent').payload, originator: 'T3 Code' } }, { type: 'event_msg', payload: { type: 'task_started' } }]);
  write(path.join(day, 'rollout-c.jsonl'), [{ type: 'session_meta', payload: { id: 't3', cwd: '/repo' } }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'external-import-turn-1' } }]);
  assert.deepEqual(scan(home).map(f => [f.id, f.status, f.ended]).sort(), [['codex:t1', 'done', true], ['codex:t4', 'thinking', false]]);
});

test('finds Cursor chats and names them after the first prompt', () => {
  const home = tmp('cursor');
  write(path.join(home, '.cursor', 'projects', 'Users-me-shop', 'agent-transcripts', 'c1', 'c1.jsonl'),
    [{ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\ngit   pull\n</user_query>' }] } }]);
  const [f] = scan(home);
  assert.deepEqual([f.id, f.status, f.title, f.cwd, f.entrypoint, f.ended], ['cursor:c1', 'thinking', 'git pull', '/Users/me/shop', null, false]);   // no such folder here, so dashes read as slashes
});

test('names Cursor chats run by T3 Code after your words, not its instructions', () => {
  const home = tmp('cursor-t3');
  write(path.join(home, '.cursor', 'projects', 'Users-me-shop', 'agent-transcripts', 'c2', 'c2.jsonl'), [
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\n<t3_code_orchestration_instructions>\nlong rules\n</t3_code_orchestration_instructions>\n<user_request>\nlogin to claude\n</user_request>\n</user_query>' }] } },
    { type: 'turn_ended' }]);
  const [f] = scan(home);
  assert.deepEqual([f.title, f.entrypoint, f.status, f.ended], ['login to claude', 't3-code', 'done', true]);
});

test('decodes folder names by walking the disk', () => {
  const home = tmp('decode');
  for (const d of ['cheiron-cmc/backend', 'cheiron', '.claude-mem/observer']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const real = p => fs.realpathSync(p);
  assert.equal(real(decode(encode(real(path.join(home, 'cheiron-cmc', 'backend'))))), real(path.join(home, 'cheiron-cmc', 'backend')));
  assert.equal(real(decode(encode(real(path.join(home, '.claude-mem', 'observer'))))), real(path.join(home, '.claude-mem', 'observer')));
  assert.equal(decode(encode(path.join(real(home), 'nope'))), null);
});

test('a quiet log mid-turn reads as waiting on you', () => {
  assert.equal(settle('working', 'Working', 0, 3 * 60 * 1000 + 1)[0], 'idle');
  assert.equal(settle('done', 'Finished', 0, 3 * 60 * 1000 + 1)[0], 'done');
});

test('skips chats archived in the Claude desktop app, even though archiving writes to their log', () => {
  const home = tmp('archived'), shop = path.join(home, 'code', 'shop');
  fs.mkdirSync(shop, { recursive: true });
  const folder = path.join(home, '.claude', 'projects', encode(shop));
  for (const id of ['kept', 'gone']) write(path.join(folder, `${id}.jsonl`), [{ type: 'user', cwd: shop, entrypoint: 'claude-desktop', message: { content: 'hi' } }]);
  const account = path.join(desktopSessionsDir(home), 'org', 'me');
  fs.mkdirSync(account, { recursive: true });
  fs.writeFileSync(path.join(account, 'local_a.json'), JSON.stringify({ sessionId: 'local_a', cliSessionId: 'gone', cwd: shop, isArchived: true, title: 'x'.repeat(9000) }));
  fs.writeFileSync(path.join(account, 'local_b.json'), JSON.stringify({ sessionId: 'local_b', cliSessionId: 'kept', cwd: shop, isArchived: false }));
  fs.writeFileSync(path.join(account, 'local_c.json'), JSON.stringify({ sessionId: 'local_c', isArchived: true }));   // never started: no CLI session
  assert.deepEqual([...archivedChats(home)], ['gone']);
  assert.deepEqual(scan(home).map(f => f.id), ['kept']);
});

test('finds the subagents a chat still has at work, and counts the chat as working while they are', () => {
  const home = tmp('subs'), shop = path.join(home, 'code', 'shop'); fs.mkdirSync(shop, { recursive: true });
  const folder = path.join(home, '.claude', 'projects', encode(shop)), subs = path.join(folder, 's1', 'subagents');
  write(path.join(folder, 's1.jsonl'), [{ type: 'assistant', cwd: shop, entrypoint: 'cli', message: { content: [{ type: 'tool_use', name: 'Agent' }] } }]);
  write(path.join(subs, 'agent-a1.jsonl'), [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }]);
  fs.writeFileSync(path.join(subs, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Wire the frontend' }));
  write(path.join(subs, 'agent-a2.jsonl'), [{ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } }]);
  const [f] = scan(home, Date.now() + 10 * 60_000);                       // a long test run: quiet for ten minutes
  assert.deepEqual(f.subs.map(x => [x.id, x.type, x.task]), [['a1', 'general-purpose', 'Wire the frontend']]);
  assert.deepEqual([f.status, f.activity], ['working', 'Waiting on a subagent']);
});

test("a task T3 Code hands to another agent is named after the task, not T3 Code's own lines", () => {
  const handed = '<user_query>\n<t3_code_orchestration_instructions>\nrules\n</t3_code_orchestration_instructions>\n\n<user_request>\n'
    + '[T3 Code: the agent in T3 thread "18f504af" sent this message, not the user.]\n\nAct as the research sub-agent for this task.\n\n'
    + 'Count the lines in web/js.\n</user_request>\n</user_query>';
  assert.equal(promptTitle(handed), 'Count the lines in web/js.');
  assert.equal(promptTitle('Act as the reviewer for this task, but say what you would change'), 'Act as the reviewer for this task, but say what you would change');   // your words stay
  assert.equal(promptTitle('plain prompt'), 'plain prompt');
  assert.equal(promptTitle(''), null);
});

test('a Cursor chat without turn_ended is done once it answered and went quiet', () => {
  const answer = { role: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } };
  const working = { role: 'assistant', message: { content: [{ type: 'text', text: 'Reading files' }, { type: 'tool_use' }] } };
  assert.equal(cursorDone({ type: 'turn_ended' }, 0, 0), true);
  assert.equal(cursorDone(answer, 0, CURSOR_QUIET_MS), true);
  assert.equal(cursorDone(answer, 0, CURSOR_QUIET_MS - 1), false);      // may still be writing
  assert.equal(cursorDone(working, 0, CURSOR_QUIET_MS * 10), false);    // a tool call is still running
  assert.equal(cursorDone({ role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }, 0, CURSOR_QUIET_MS), false);
  assert.equal(cursorDone(undefined, 0, CURSOR_QUIET_MS), false);
});
