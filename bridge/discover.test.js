import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, encode, decode, settle, FOUND_WINDOW_MS } from './discover.js';

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
  write(path.join(day, 'rollout-b.jsonl'), [meta('t2', 'subagent')]);
  write(path.join(day, 'rollout-c.jsonl'), [{ type: 'session_meta', payload: { id: 't3', cwd: '/repo' } }, { type: 'event_msg', payload: { type: 'task_started', turn_id: 'external-import-turn-1' } }]);
  assert.deepEqual(scan(home).map(f => [f.id, f.status]), [['codex:t1', 'done']]);
});

test('finds Cursor chats and names them after the first prompt', () => {
  const home = tmp('cursor');
  write(path.join(home, '.cursor', 'projects', 'Users-me-shop', 'agent-transcripts', 'c1', 'c1.jsonl'),
    [{ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\ngit   pull\n</user_query>' }] } }]);
  const [f] = scan(home);
  assert.deepEqual([f.id, f.status, f.title, f.cwd], ['cursor:c1', 'thinking', 'git pull', '/Users/me/shop']);   // no such folder here, so dashes read as slashes
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
