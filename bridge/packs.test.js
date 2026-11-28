import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPacks, packFile, packsFolder } from './packs.js';

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

test('pack files stay inside the packs folder, are models or textures, and never follow a symlink out', () => {
  const { dir, add } = tmpPacks();
  try {
    add('kenney'); fs.mkdirSync(path.join(dir, 'kenney', 'Textures'));
    for (const f of ['chair.glb', 'Textures/colormap.png', 'page.html', 'icon.svg', 'run.js', 'pack.json']) fs.writeFileSync(path.join(dir, 'kenney', f), 'x');
    const outside = path.join(path.dirname(dir), path.basename(dir) + '-outside.png'); fs.writeFileSync(outside, 'AUDIT_FIXTURE_ONLY');
    fs.symlinkSync(outside, path.join(dir, 'kenney', 'escape.png'));
    const real = fs.realpathSync(dir);
    assert.deepEqual(packFile('/packs/kenney/chair.glb', dir), { file: path.join(real, 'kenney/chair.glb'), type: 'model/gltf-binary' });
    assert.equal(packFile('/packs/kenney/Textures/colormap.png', dir).type, 'image/png');
    for (const p of ['/packs/../secret.txt', '/packs/kenney/%2e%2e/%2e%2e/etc/passwd', '/packs/pack.json', '/packs/kenney/page.html', '/packs/kenney/icon.svg',
      '/packs/kenney/run.js', '/packs/kenney/pack.json', '/packs/kenney/escape.png', '/packs/kenney/missing.glb', '/packs/kenney/%ZZ.glb', '/packs/kenney/a%00.glb'])
      assert.equal(packFile(p, dir), null, p);
    fs.rmSync(outside);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the packs folder is shown with your home as ~, and as is outside it', () => {
  assert.equal(packsFolder('/Users/ana/Library/Application Support/Agent Office/packs', '/Users/ana').dir, '~/Library/Application Support/Agent Office/packs');
  assert.equal(packsFolder('/Volumes/models/packs', '/Users/ana').dir, '/Volumes/models/packs');
  assert.equal(packsFolder('/Users/anabel/packs', '/Users/ana').dir, '/Users/anabel/packs');
});
