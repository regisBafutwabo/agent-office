import assert from 'node:assert/strict';
import { between } from './office-source.mjs';
import vm from 'node:vm';
import test from 'node:test';

const context = vm.createContext({ localStorage: { getItem: () => null } });
vm.runInContext(between('const CHG_POLL_MS', 'function noteWork'), context);
const row = (m, c, seen = {}, now = 1_000_000, subs) => vm.runInContext('reviewRow', context)({ name: 'Ada', color: '#fff', state: 'working', ...m }, c, seen, now, subs);
const file = (path, sig = 'v1', add = 2, del = 1) => ({ path, sig, add, del, status: 'modified' });
const checkout = files => ({ ok: true, root: '/repo', prefix: 'web/', files });

test('a checkout that has not been read yet, or could not be, says so instead of claiming there is nothing to review', () => {
  assert.equal(row({}, null).tone, 'wait');
  const failed = row({}, { ok: false, error: 'Not a git checkout' });
  assert.deepEqual([failed.tone, failed.note, failed.count], ['none', 'Not a git checkout', 0]);
});

test('only versions you have not marked reviewed count, and an edit to a reviewed file brings it back', () => {
  const c = checkout([file('web/a.js'), file('web/b.js'), file('web/c.js', 'v2')]);
  const r = row({}, c, { 'web/a.js': 'v1', 'web/c.js': 'v1' });
  assert.deepEqual([r.tone, r.count, r.total, r.add, r.del], ['todo', 2, 3, 6, 3]);
  assert.deepEqual(r.files.map(f => f.path).sort(), ['web/b.js', 'web/c.js']);
  assert.equal(row({}, c, { 'web/a.js': 'v1', 'web/b.js': 'v1', 'web/c.js': 'v2' }).tone, 'clear');
  assert.deepEqual([row({}, checkout([])).tone, row({}, checkout([])).note], ['none', 'No changes']);
});

test('files the agent reported editing come first, newest first, and a recent one is marked fresh', () => {
  const now = 1_000_000, touched = new Map([['b.js', { at: now - 5000 }], ['/repo/web/c.js', { at: now - 90_000 }]]);
  const r = row({ touched }, checkout([file('web/a.js'), file('web/c.js'), file('web/b.js')]), {}, now);
  assert.deepEqual(r.files.map(f => [f.path, f.fresh]), [['web/b.js', true], ['web/c.js', false], ['web/a.js', false]]);
});

test('each file carries who reported its edit, and the row lists the session\'s subagents', () => {
  const now = 1_000_000, ada = { name: 'Ada', color: '#fff' }, scout = { name: 'Explore', color: '#abc', state: 'working', id: 's1', kind: 'sub' };
  const touched = new Map([['a.js', { at: now - 1000, who: scout }], ['b.js', { at: now - 2000, who: ada }]]);
  const r = row({ touched }, checkout([file('web/a.js'), file('web/b.js'), file('web/c.js')]), {}, now, [scout]);
  assert.deepEqual(r.files.map(f => [f.path, f.color, f.by]), [['web/a.js', '#abc', 'Explore'], ['web/b.js', '#fff', 'Ada'], ['web/c.js', null, null]]);
  assert.deepEqual(r.subs.map(s => ({ ...s })), [{ name: 'Explore', color: '#abc', state: 'working' }]);   // copied out of the vm realm
  assert.deepEqual([row({}, null).subs.length, row({}, null, {}, now, [scout]).subs.length], [0, 1]);
});
