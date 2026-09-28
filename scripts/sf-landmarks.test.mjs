import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as THREE from 'three';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = (start, end) => html.slice(html.indexOf(start), html.indexOf(end));
function setup() {
  const skyline = new THREE.Group();
  const context = vm.createContext({ THREE, Float32Array, GROUND_Y: -150, skyline,
    cityMats: Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial()),
    canvasTex: () => ({ x: { fillRect() {} }, t: new THREE.Texture() }) });
  vm.runInContext(source('function mergeCityGeometry', 'function batchGenericCity'), context);
  vm.runInContext(source('const cityUV =', "const CITIES ="), context);
  return { context, skyline, run: code => vm.runInContext(code, context) };
}

test('landmarks render in r128 with finite geometry, outward walls and bounded atlas UVs', () => {
  const { skyline, run } = setup();
  run('buildSFLandmarks()');
  assert.equal(skyline.children.length, 2);
  let vertices = 0;
  for (const mesh of skyline.children) {
    assert.equal(mesh.geometry.index, null);
    assert.equal(mesh.geometry.groups.length, 0);
    for (const attribute of Object.values(mesh.geometry.attributes)) assert.ok(attribute.array.every(Number.isFinite));
    assert.ok(mesh.geometry.attributes.uv.array.every(v => v >= 0 && v <= 1));
    vertices += mesh.geometry.attributes.position.count;
  }
  assert.equal(skyline.children[1].geometry.attributes.color.count, skyline.children[1].geometry.attributes.position.count);
  assert.ok(skyline.children[1].geometry.attributes.color.array.some(v => v < .5));
  assert.ok(vertices < 50000, `${vertices} vertices exceeds landmark budget`);
  const firstNormal = new THREE.Vector3().fromBufferAttribute(skyline.children[0].geometry.attributes.normal, 0);
  assert.ok(firstNormal.dot(new THREE.Vector3(1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0), -.66)) > .8);
  for (const landmark of run('SF_LANDMARKS')) {
    const [x,z] = run(`cityPoint(${JSON.stringify(landmark.center)}, SF_VIEW_CENTER)`);
    let top = -Infinity;
    for (const mesh of skyline.children) {
      const p = mesh.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) if (Math.hypot(p.getX(i)-x,p.getZ(i)-z) < 65) top = Math.max(top,p.getY(i)+150);
    }
    assert.ok(Math.abs(top - landmark.height) < 1, `${landmark.name}: ${top}`);
  }
});

test('SF replaces the two baked landmarks, keeps source data intact and uses eight skyline batches', () => {
  const { context, skyline, run } = setup();
  const data = JSON.parse(readFileSync(new URL('../web/cities/sf.json', import.meta.url)));
  const before = JSON.stringify(data); context.data = data;
  assert.equal(run('data.buildings.filter(b => SF_LANDMARKS.some(l => footprintNear(b.rings[0], cityPoint(l.center, data.center), 0))).length'), 2);
  run('buildRealCity(data)');
  assert.equal(skyline.children.length, 8); // + ground + office = ten draw calls
  assert.equal(JSON.stringify(data), before);
});

test('office clearance checks enclosing polygons and edges, including repeated closing vertices', () => {
  const { run } = setup();
  assert.equal(run('footprintNear([[-50,-50],[50,-50],[50,50],[-50,50],[-50,-50]], [0,0], 25)'), true);
  assert.equal(run('footprintNear([[24,-50],[40,-50],[40,50],[24,50]], [0,0], 25)'), true);
  assert.equal(run('footprintNear([[30,-50],[40,-50],[40,50],[30,50]], [0,0], 25)'), false);
});


test('Golden Gate keeps its NW bearing, finite colored geometry and suspended cable silhouette', () => {
  const { run } = setup();
  const parts = run('buildSFBridge()');
  const box = new THREE.Box3();
  for (const g of parts) {
    g.computeBoundingBox(); box.union(g.boundingBox);
    for (const attribute of Object.values(g.attributes)) assert.ok(attribute.array.every(Number.isFinite));
    assert.equal(g.attributes.color.count, g.attributes.position.count);
  }
  const towers = new THREE.Box3(); parts.slice(0,20).forEach(g => towers.union(g.boundingBox));
  const center = towers.getCenter(new THREE.Vector3());
  assert.ok(center.x < 0 && center.z < 0);
  assert.ok(Math.abs(Math.hypot(center.x,center.z) - 1500) < 1);
  assert.ok(Math.abs(box.max.y - (-150 + 230)) < .1);
  assert.ok(parts.length > 200);
});
