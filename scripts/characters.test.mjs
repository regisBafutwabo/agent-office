import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import THREE from 'three';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
function setup() {
  const context = vm.createContext({ THREE, M: color => new THREE.MeshStandardMaterial({ color }) });
  vm.runInContext(source('const ANIMALS =', '// A look that stays'), context);
  vm.runInContext(source('function part(', 'function roundedBox'), context);
  vm.runInContext(source('function buildAnimal(', 'function hexA'), context);
  return { context, run: code => vm.runInContext(code, context) };
}

test('all six pet heads and tails have finite geometry and expressive faces', () => {
  const { context, run } = setup();
  for (const species of run('Object.keys(ANIMALS)')) {
    context.a = { name: 'Ada', look: { species }, head: new THREE.Group(), pivot: new THREE.Group(), ears: [], state: 'working', animT: 1, blink: 0 };
    run('buildAnimal(a, ANIMALS[petSpecies(a)], M(ANIMALS[petSpecies(a)].fur))');
    assert.equal(context.a.animalEyes.length, 2);
    for (const group of [context.a.head, context.a.tail]) group.traverse(o => {
      if (o.geometry) assert.ok([...o.geometry.attributes.position.array].every(Number.isFinite), species);
    });
    run('drawAnimalFace(a)'); const working = context.a.animalEyes[0].scale.y;
    context.a.blink = .1; run('drawAnimalFace(a)');
    assert.ok(context.a.animalEyes[0].scale.y < working);
    context.a.blink = 0; context.a.state = 'waiting'; run('drawAnimalFace(a)');
    assert.ok(context.a.animalEyes[0].scale.y > working);
    context.a.state = 'error'; run('drawAnimalFace(a)');
    assert.equal(context.a.animalMouth.rotation.z, Math.PI);
  }
});

test('default pets are stable between visits and invalid species fall back to a real pet', () => {
  const { context, run } = setup();
  context.a = { name: 'Ada', cwd: '/repo', look: {} };
  const species = run('petSpecies(a)');
  context.a.name = 'Renamed'; assert.equal(run('petSpecies(a)'), species);
  context.a.look.species = 'missing'; assert.equal(run('petSpecies(a)'), species);
  context.a.look.species = 'maltese'; assert.equal(run('petSpecies(a)'), 'maltese');
  context.sub = { name: 'Explorer', look: {}, parent: context.a };
  assert.equal(run('petSpecies(sub)'), 'maltese');
});
