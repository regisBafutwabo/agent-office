import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { editOf, parseNumstat, parseNameStatus, insideRoot, changes, fileDiff } from './changes.js';
import { Store } from './store.js';

test('an edit keeps only the lines that changed, cut to fit a card', () => {
  const e = editOf('Edit', { old_string: 'a\nb\nc', new_string: 'a\nB\nc' });
  assert.deepEqual(e, { del: ['b'], add: ['B'], more: 0 });
  assert.deepEqual(editOf('Write', { content: 'one\ntwo\n' }).add, ['one', 'two']);
  const long = editOf('Write', { content: Array.from({ length: 10 }, (_, i) => 'x'.repeat(i ? 3 : 400)).join('\n') });
  assert.equal(long.add.length, 6); assert.equal(long.more, 4); assert.equal(long.add[0].length, 160);
  assert.equal(editOf('Bash', { command: 'ls' }), null);
  assert.equal(editOf('Edit', { file_path: 'a.txt' }), null);
});

test('reads git numstat and name-status output, binary files included', () => {
  assert.deepEqual([...parseNumstat('3\t1\tsrc/a b.js\0-\t-\tlogo.png\0')], [['src/a b.js', { add: 3, del: 1 }], ['logo.png', { add: null, del: null }]]);
  assert.deepEqual([...parseNameStatus('M\0src/a b.js\0A\0new.js\0D\0old.js\0')], [['src/a b.js', 'modified'], ['new.js', 'added'], ['old.js', 'deleted']]);
});

test('a path from the page cannot leave the checkout', () => {
  assert.equal(insideRoot('/repo', '../etc/passwd'), null);
  assert.equal(insideRoot('/repo', '/etc/passwd'), null);
  assert.equal(insideRoot('/repo', ''), null);
  assert.equal(insideRoot('/repo', 'src/a.js'), '/repo/src/a.js');
});

test('lists committed, uncommitted and untracked work since the base branch, and one file\'s diff', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-changes-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  try {
    git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n'); fs.writeFileSync(path.join(dir, 'gone.txt'), 'x\n');
    git('add', '.'); git('commit', '-q', '-m', 'base'); git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n'); git('add', 'b.txt'); git('commit', '-q', '-m', 'add b');   // committed on the branch
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');                                              // not committed
    fs.rmSync(path.join(dir, 'gone.txt'));
    fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'c.txt'), 'u1\nu2');             // untracked
    const c = await changes(path.join(dir, 'sub'));
    assert.equal(c.ok, true); assert.equal(c.root, dir); assert.equal(c.branch, 'feature'); assert.equal(c.base, 'main'); assert.equal(c.prefix, 'sub/');
    const by = Object.fromEntries(c.files.map(f => [f.path, [f.status, f.add, f.del]]));
    assert.deepEqual(by, { 'a.txt': ['modified', 2, 1], 'b.txt': ['added', 1, 0], 'gone.txt': ['deleted', 0, 1], 'sub/c.txt': ['untracked', 2, 0] });
    assert.match((await fileDiff(dir, 'a.txt')).text, /^-two$/m);
    assert.match((await fileDiff(dir, 'sub/c.txt')).text, /^\+u2$/m);
    assert.equal((await fileDiff(dir, '../x')).ok, false);
    assert.equal((await changes(os.tmpdir())).ok, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('edited lines ride on a finished edit, and not at all once code is hidden', () => {
  const st = new Store(), base = { session_id: 's1', cwd: '/Users/me/code/shop' };
  const post = { ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/Users/me/code/shop/a.js', old_string: 'x = 1', new_string: 'x = 2' } };
  assert.deepEqual(st.ingest(post).edit, { del: ['x = 1'], add: ['x = 2'], more: 0 });
  assert.equal(st.ingest({ ...post, hook_event_name: 'PreToolUse' }).edit, undefined);
  assert.equal(st.ingest({ ...post, hook_event_name: 'PostToolUseFailure' }).edit, undefined);
  st.showCode = false;
  assert.equal(st.ingest(post).edit, undefined);
});
