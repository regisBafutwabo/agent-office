import assert from 'node:assert/strict';
import { officeSource } from './office-source.mjs';
import vm from 'node:vm';
import test from 'node:test';

const html = officeSource;
const context = vm.createContext({ STUCK_AFTER: 3 });
vm.runInContext(html.slice(html.indexOf('const RUN_LONG_MS'), html.indexOf('const deskKey')), context);
const run = code => vm.runInContext(code, context);
const at = (day, hour = 12) => new Date(2026, 10, day, hour).getTime();

test('only a command result gets a reaction, and finishing fast and clean gets none', () => {
  assert.equal(run(`outcomeOf({ tool: 'Edit', failed: true }, 0, 0)`), null);
  assert.equal(run(`outcomeOf({ tool: 'Bash' }, 0, 5000)`), null);
  assert.equal(run(`outcomeOf({ tool: 'Bash', failed: true }, 2, 90000).kind`), 'soot');
  assert.equal(run(`outcomeOf({ tool: 'Bash' }, 0, RUN_LONG_MS).kind`), 'parcel');
});

test('a pass after failures is a comeback, and after going in circles it is getting unstuck', () => {
  assert.equal(run(`outcomeOf({ tool: 'Bash' }, 1, 90000).kind`), 'comeback');
  assert.deepEqual({ ...run(`outcomeOf({ tool: 'Bash' }, 3, 0)`) }, { kind: 'unstuck', fails: 3 });
});

test('the same moment is remembered once, however often it is reported', () => {
  context.t = at(3);
  run(`d1 = remember(emptyDesk(), 'merge', t); d2 = remember(d1, 'merge', t); d3 = remember(d2, 'merge', t + 1)`);
  assert.equal(run('d1.merges'), 1);
  assert.equal(run('d2 === d1'), true);
  assert.equal(run('d3.merges'), 2);
  assert.equal(run(`remember(remember(emptyDesk(), 'team', t), 'team', t + 5).moments.length`), 1);
});

test('a day counts once, and the plant growing is a moment of its own', () => {
  context.days = [at(3, 9), at(3, 18), at(4), at(5)];
  run(`d = days.reduce(workedOn, emptyDesk())`);
  assert.equal(run('d.dayCount'), 3);
  assert.deepEqual([...run(`d.moments.map(m => m.kind + m.n)`)], ['grew3', 'grew1']);
  assert.equal(run('plantStage(d.dayCount)'), 2);
  assert.equal(run(`workedOn(d, days[0]) === d`), true);
});

test('old moments drop off but the counts stay', () => {
  context.t = at(3);
  run(`d = emptyDesk(); for (let i = 0; i < MOMENTS_MAX + 5; i++) d = remember(d, 'merge', t + i)`);
  assert.equal(run('d.moments.length'), run('MOMENTS_MAX'));
  assert.equal(run('d.merges'), run('MOMENTS_MAX') + 5);
});

test('a reaction bubble names the command in a few words, and how long it ran', () => {
  assert.equal(run(`cmdShort('npm test')`), 'npm test');
  assert.equal(run(`cmdShort('cd api && CI=1 uv run pytest -x tests/')`), 'uv run pytest');
  assert.equal(run(`cmdShort('/usr/local/bin/cargo build --release | tail -5')`), 'cargo build --release'.split(' --')[0]);
  assert.equal(run(`cmdShort('export A=1; make e2e')`), 'make e2e');
  assert.equal(run(`cmdShort('')`), '');
  assert.ok(run(`cmdShort('averyveryverylongcommandname another')`).length <= 24);
  assert.equal(run(`fmtDur(42000)`), '42s');
  assert.equal(run(`fmtDur(185000)`), '3m 5s');
});
