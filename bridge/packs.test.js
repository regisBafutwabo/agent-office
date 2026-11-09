import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPacks, packFile } from './packs.js';

function tmpPacks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const add = (id, json) => { fs.mkdirSync(path.join(dir, id)); if (json !== undefined) fs.writeFileSync(path.join(dir, id, 'pack.json'), json); };
  return { dir, add };
}

test('lists packs with a valid pack.json, sorted by name', () => {
  const { dir, add } = tmpPacks();
  add('zed', JSON.stringify({ name: 'Zed', slots: { sofa: { model: 'sofa.glb' } } }));
  add('alpha', JSON.stringify({ name: 'Alpha', license: 'CC0', slots: {} }));
  add('broken', '{ nope');
  add('empty');
  add('noslots', JSON.stringify({ name: 'No slots' }));
  assert.deepEqual(listPacks(dir).map(p => p.id), ['alpha', 'zed']);
  assert.equal(listPacks(dir)[0].license, 'CC0');
});

test('a missing packs folder lists nothing', () => {
  assert.deepEqual(listPacks(path.join(os.tmpdir(), 'no-such-packs-' + Date.now())), []);
});

test('pack files stay inside the packs folder', () => {
  const dir = '/data/packs';
  assert.equal(packFile('/packs/kenney/chair.glb', dir), '/data/packs/kenney/chair.glb');
  assert.equal(packFile('/packs/kenney/Textures/colormap.png', dir), '/data/packs/kenney/Textures/colormap.png');
  assert.equal(packFile('/packs/../secret.txt', dir), null);
  assert.equal(packFile('/packs/kenney/%2e%2e/%2e%2e/etc/passwd', dir), null);
  assert.equal(packFile('/packs/pack.json', dir), null);
});
