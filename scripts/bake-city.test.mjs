import test from 'node:test';
import assert from 'node:assert/strict';
import { project, buildingHeight, nearOffice, bake } from './bake-city.mjs';

test('projection uses meters east and south around the chosen center', () => {
  assert.deepEqual(project(37.5, 127, [37.5, 127]), [0, 0]);
  const [east, south] = project(37.501, 127.001, [37.5, 127]);
  assert.ok(Math.abs(east - 88.217) < .01);
  assert.ok(Math.abs(south + 111.195) < .01);
});
test('height tags take priority, then levels, then 15 meters', () => {
  assert.deepEqual(buildingHeight({ height: '80 m', 'building:levels': '10' }), { height: 80, source: 'height' });
  assert.equal(buildingHeight({ height: '100 ft' }).height, 30.48);
  assert.deepEqual(buildingHeight({ height: 'unknown', 'building:levels': '10' }), { height: 32, source: 'levels' });
  for (const height of ['-5', '0', '20;30', 'Infinity', '']) assert.equal(buildingHeight({ height }).height, 15);
  assert.equal(buildingHeight({ 'building:levels': '-3' }).source, 'default');
});
test('clearance checks edges and enclosing footprints, not just their vertices', () => {
  assert.equal(nearOffice([[-100, -100], [100, -100], [100, 100], [-100, 100]]), true);
  assert.equal(nearOffice([[-100, 20], [100, 20], [100, 40], [-100, 40]]), true);
  assert.equal(nearOffice([[30, 30], [40, 30], [40, 40], [30, 40]]), false);
});
test('bake joins relation segments, retains courtyards and avoids duplicate member ways', () => {
  const point = (lat, lon) => ({ lat, lon });
  const a = point(.002, .002), b = point(.002, .004), c = point(.004, .004), d = point(.004, .002);
  const inner = [point(.0025, .0025), point(.0025, .003), point(.003, .003), point(.003, .0025), point(.0025, .0025)];
  const { buildings, coverage } = bake([
    { type: 'way', id: 1, tags: { building: 'yes' }, geometry: [a, b, c, d, a] },
    { type: 'relation', tags: { building: 'yes', height: '30' }, members: [
      { type: 'way', ref: 1, role: 'outer', geometry: [a, b, c] },
      { type: 'way', ref: 2, role: 'outer', geometry: [a, d, c] },
      { type: 'way', ref: 3, role: 'inner', geometry: inner }
    ] }
  ], [0, 0]);
  assert.equal(buildings.length, 1); assert.equal(buildings[0].rings.length, 2);
  assert.equal(buildings[0].h, 30); assert.equal(coverage.height, 1);
  assert.ok(buildings[0].rings[0].flat().every(v => Math.abs(v * 10 - Math.round(v * 10)) < 1e-6));
});
