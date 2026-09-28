import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Change these centers when the office addresses are known. Coordinates are [latitude, longitude].
export const CITIES = { sf: [37.7897, -122.3972], gangnam: [37.5006, 127.0364] };
export const CITY_RADIUS_M = { sf: 2200, gangnam: 600 };
const METERS = Math.PI * 6371000 / 180;
export function project(lat, lon, center) {
  return [(lon - center[1]) * METERS * Math.cos(center[0] * Math.PI / 180), (center[0] - lat) * METERS];
}
export function buildingHeight(tags = {}) {
  const raw = String(tags.height || '').trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|')?$/i);
  const height = match && Number(match[1]) * (/^(ft|feet|')$/i.test(match[2]) ? .3048 : 1);
  if (height > 0) return { height, source: 'height' };
  const levels = Number(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) return { height: levels * 3.2, source: 'levels' };
  return { height: 15, source: 'default' };
}
export function nearOffice(ring, radius = 25) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, z] = ring[i], [a, b] = ring[j], dx = a - x, dz = b - z;
    const t = Math.max(0, Math.min(1, -(x * dx + z * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x + t * dx, z + t * dz) < radius) return true;
    if ((z > 0) !== (b > 0) && 0 < x + (a - x) * -z / (b - z)) inside = !inside;
  }
  return inside;
}
function rings(members) {
  const pending = members.filter(m => m.geometry?.length).map(m => m.geometry.map(p => [p.lat, p.lon]));
  const same = (a, b) => a[0] === b[0] && a[1] === b[1], result = [];
  while (pending.length) {
    const ring = pending.pop();
    while (!same(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1], i = pending.findIndex(r => same(r[0], end) || same(r[r.length - 1], end));
      if (i < 0) break;
      const next = pending.splice(i, 1)[0]; if (!same(next[0], end)) next.reverse();
      ring.push(...next.slice(1));
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) result.push(ring.slice(0, -1));
  }
  return result;
}
function contains(ring, [x, z]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [a, b] = ring[i], [c, d] = ring[j];
    if ((b > z) !== (d > z) && x < a + (c - a) * (z - b) / (d - b)) inside = !inside;
  }
  return inside;
}
export function bake(elements, center) {
  const buildings = [], coverage = { height: 0, levels: 0, default: 0, excluded: 0 };
  const relations = elements.filter(e => e.type === 'relation' && e.tags?.building && e.tags.building !== 'no');
  const members = new Set(relations.flatMap(e => e.members.filter(m => m.type === 'way').map(m => m.ref)));
  const local = ring => ring.map(([lat, lon]) => project(lat, lon, center).map(v => Math.round(v * 10) / 10));
  for (const e of elements) {
    if (!e.tags?.building || e.tags.building === 'no' || e.type === 'way' && members.has(e.id)) continue;
    const outer = e.type === 'way' ? rings([{ geometry: e.geometry }]) : rings((e.members || []).filter(m => m.role === 'outer' || !m.role));
    const holes = e.type === 'relation' ? rings(e.members.filter(m => m.role === 'inner')).map(local) : [];
    for (const ring of outer.map(local)) {
      if (nearOffice(ring)) { coverage.excluded++; continue; }
      const { height, source } = buildingHeight(e.tags); coverage[source]++;
      buildings.push({ h: Math.round(height * 10) / 10, rings: [ring, ...holes.filter(h => contains(ring, h[0]))] });
    }
  }
  return { buildings, coverage };
}
async function main() {
  const ids = process.argv.slice(2); if (!ids.length) ids.push(...Object.keys(CITIES));
  for (const id of ids) {
    const center = CITIES[id]; if (!center) throw new Error(`Unknown city: ${id}`);
    const lat = CITY_RADIUS_M[id] / METERS, lon = lat / Math.cos(center[0] * Math.PI / 180);
    const bbox = [center[0] - lat, center[1] - lon, center[0] + lat, center[1] + lon].join(',');
    const query = `[out:json][timeout:120];(way[building](${bbox});relation[building][type=multipolygon](${bbox}););out geom;`;
    const endpoint = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
    const response = await fetch(endpoint, { method: 'POST', headers: { 'User-Agent': 'agent-office-city-bake/1.0 (offline OpenStreetMap skyline export)' }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Overpass ${response.status}: ${await response.text()}`);
    const raw = await response.json(); if (raw.remark) throw new Error(raw.remark);
    const { buildings, coverage } = bake(raw.elements, center);
    if (!buildings.length) throw new Error(`No buildings returned for ${id}`);
    const data = { id, center, radius: CITY_RADIUS_M[id], source: '© OpenStreetMap contributors', license: 'ODbL-1.0', sourceDate: raw.osm3s?.timestamp_osm_base, coverage, buildings };
    const out = new URL(`../web/cities/${id}.json`, import.meta.url), json = JSON.stringify(data) + '\n';
    await mkdir(new URL('../web/cities/', import.meta.url), { recursive: true }); await writeFile(out, json);
    console.log(`${id}: ${buildings.length} buildings, ${Buffer.byteLength(json)} bytes; height tags ${(coverage.height / buildings.length * 100).toFixed(1)}% (${coverage.height}), levels fallback ${coverage.levels}, default 15 m ${coverage.default}, excluded near office ${coverage.excluded}`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(err => { console.error(err); process.exitCode = 1; });
