import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { officeSource } from './office-source.mjs';

// The scripts in web/js share one global scope. A name declared twice with const or let stops the page from
// loading, and only the slow browser tests would notice. Compiling them as one script finds it in a moment.
test('no two office scripts declare the same const or let', () => {
  assert.doesNotThrow(() => new vm.Script(officeSource, { filename: 'web/js (all scripts, in page order)' }),
    'A top-level name is declared twice in web/js. Rename one of them.');
});

// A second top-level function with the same name doesn't fail: it silently replaces the first one.
test('no two office scripts declare the same top-level function', () => {
  const web = new URL('../web/', import.meta.url), page = readFileSync(new URL('index.html', web), 'utf8');
  const seen = new Map(), twice = [];
  for (const [, file] of page.matchAll(/<script src="\/(js\/[\w-]+\.js)"><\/script>/g)) {
    for (const [, name] of readFileSync(new URL(file, web), 'utf8').matchAll(/^(?:async\s+)?function\s*\*?\s*([\w$]+)/gm)) {
      if (seen.has(name)) twice.push(`${name} (${seen.get(name)} and ${file})`); else seen.set(name, file);
    }
  }
  assert.deepEqual(twice, [], `Declared more than once: ${twice.join(', ')}`);
});
