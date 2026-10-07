import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answering, models } from './ollama.js';
import { Store } from './store.js';

const ps = { models: [
  { name: 'qwen3.5:9b', expires_at: '2026-10-07T12:26:04+09:00' },
  { name: 'llama3.2:3b', expires_at: '2026-10-07T12:21:00+09:00' },
] };
const BUSY = 'srv  update_slots: all slots are idle\nslot launch_slot_: id  0 | task 0 | processing task, is_child = 0\nslot print_timing: id  0 | task 0 | n_gen = 100\n';
const DONE = BUSY + 'slot      release: id  0 | task 0 | stop processing: n_tokens = 612\nsrv  update_slots: all slots are idle\n[GIN] 2026/10/07 - 12:21:11 | 200 | 418µs | 127.0.0.1 | GET "/api/ps"\n';

test('reads from the log whether a prompt is being answered', () => {
  assert.equal(answering(BUSY), true);
  assert.equal(answering(DONE), false);
  assert.equal(answering(''), false);   // older Ollama versions don't log these lines
});

test('each loaded model is an agent; the one used last is the one answering', () => {
  const found = models(ps, BUSY, '/Users/me', 1);
  assert.deepEqual(found.map(f => [f.id, f.status, f.title, f.project, f.cwd]), [
    ['ollama:qwen3.5:9b', 'working', 'qwen3.5:9b', 'Ollama', '/Users/me/.ollama'],
    ['ollama:llama3.2:3b', 'idle', 'llama3.2:3b', 'Ollama', '/Users/me/.ollama'],
  ]);
  assert.deepEqual(models(ps, DONE, '/Users/me', 1).map(f => f.status), ['idle', 'idle']);
  assert.deepEqual(models({}, BUSY, '/Users/me', 1), []);
});

test('a model leaves as soon as Ollama unloads it, and can come back', () => {
  const store = new Store(() => null), now = Date.now();
  for (const f of models(ps, DONE, '/Users/me', now)) store.adopt(f);
  assert.equal(store.sessions.get('ollama:qwen3.5:9b').project, 'Ollama');
  assert.deepEqual(store.retire('ollama', ['ollama:qwen3.5:9b']), ['ollama:llama3.2:3b']);
  assert.deepEqual([...store.sessions.keys()], ['ollama:qwen3.5:9b']);
  assert.equal(store.adopt(models(ps, DONE, '/Users/me', now)[1]).message, 'Already running');
});
