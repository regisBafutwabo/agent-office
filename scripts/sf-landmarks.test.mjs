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
    if (mesh.material.map) assert.ok(mesh.geometry.attributes.uv.array.every(v => v >= 0 && v <= 1));
    vertices += mesh.geometry.attributes.position.count;
  }
  assert.equal(skyline.children[1].geometry.attributes.color.count, skyline.children[1].geometry.attributes.position.count);
  assert.ok(skyline.children[1].geometry.attributes.color.array.some(v => v < .5));
  assert.ok(vertices < 100000, `${vertices} vertices exceeds landmark budget`);
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
  assert.equal(skyline.children.length, 8); // + office = nine draw calls; SF ground is in the colored backdrop batch
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
  assert.ok(Math.abs(Math.hypot(center.x,center.z) - 3600) < 1);
  assert.ok(Math.abs(box.max.y - (-150 + 230)) < .1);
  assert.ok(parts.length > 200);
});


test('expanded SF covers every side of the office and the backdrop has upward-facing terrain', () => {
  const {run,context}=setup();
  const data=JSON.parse(readFileSync(new URL('../web/cities/sf.json',import.meta.url)));
  assert.equal(data.radius,2200); assert.ok(data.buildings.length>10000);
  context.data=data;
  const quadrants=run(`(() => {
    const offset=cityPoint(data.center,SF_VIEW_CENTER), counts=[0,0,0,0];
    for(const b of data.buildings) {
      const r=b.rings[0], x=r.reduce((s,p)=>s+p[0],0)/r.length+offset[0], z=r.reduce((s,p)=>s+p[1],0)/r.length+offset[1];
      counts[(x<0?0:1)+(z<0?0:2)]++;
    }
    return counts;
  })()`);
  assert.ok(quadrants.every(n=>n>300),String(quadrants));
  const parts=run('buildSFBackdrop()');
  for(const g of parts) {
    for(const a of Object.values(g.attributes)) assert.ok(a.array.every(Number.isFinite));
    const normals=g.attributes.normal;
    for(let i=0;i<normals.count;i++) assert.ok(normals.getY(i)>0,'terrain must face up');
    g.dispose();
  }
});

test('Gangnam replaces four mapped landmarks, preserves source data and stays within its geometry budget', () => {
  const {context, skyline, run} = setup();
  const data = JSON.parse(readFileSync(new URL('../web/cities/gangnam.json', import.meta.url)));
  context.data = data; const before = JSON.stringify(data);
  assert.equal(run('data.buildings.filter(b => GANGNAM_LANDMARKS.some(l => footprintNear(b.rings[0],cityPoint(l.center,data.center),0))).length'),4);
  run('buildRealCity(data)');
  assert.equal(JSON.stringify(data),before);
  assert.equal(skyline.children.length,11); // plus the office: twelve city draw calls
  let triangles=0,bytes=0;
  for (const mesh of skyline.children) {
    assert.equal(mesh.geometry.groups.length,0);
    for (const attribute of Object.values(mesh.geometry.attributes)) {
      assert.ok(attribute.array.every(Number.isFinite)); bytes+=attribute.array.byteLength;
    }
    triangles+=mesh.geometry.attributes.position.count/3;
  }
  assert.ok(triangles<85000, `${triangles} Gangnam triangles`);
  assert.ok(bytes<11*1024*1024, `${bytes} Gangnam geometry bytes`);
  const body=skyline.children[6].geometry;
  assert.ok(body.attributes.uv.array.every(v=>v>=0&&v<=1));
  for(const landmark of run('GANGNAM_LANDMARKS')) {
    const [x,z]=run(`cityPoint(${JSON.stringify(landmark.center)},GANGNAM_VIEW_CENTER)`);
    let top=-Infinity;
    for(let i=0;i<body.attributes.position.count;i++) {
      const p=body.attributes.position;
      if(Math.hypot(p.getX(i)-x,p.getZ(i)-z)<40) top=Math.max(top,p.getY(i)+150);
    }
    assert.ok(Math.abs(top-landmark.height)<.1, `${landmark.name}: ${top}`);
  }
  for(const mesh of skyline.children.slice(0,6)) {
    const p=mesh.geometry.attributes.position;
    for(let i=0;i<p.count;i++) assert.ok(Math.hypot(p.getX(i),p.getZ(i))>=25);
  }
});

test('city switching restores fog, ground, camera range and landmark attribution', () => {
  const {context,run}=setup(); const credit={};
  context.scene={fog:{}}; context.camera={updateProjectionMatrix(){}};
  context.skyDome={scale:{setScalar(){}}}; context.city={children:[{},{}]}; context.$=()=>credit;
  for(const [id,far,ground] of [['sf',7000,false],['gangnam',4200,false],['generic',900,true],['gangnam',4200,false]]) {
    run(`setCityAtmosphere('${id}')`);
    assert.equal(context.camera.far,far); assert.equal(context.city.children[1].visible,ground);
    assert.equal(credit.textContent.includes('estimated heights'),id==='gangnam');
    assert.equal(credit.textContent.includes('Stylized landmarks'),id==='sf');
  }
});


test('artistic Gangnam forms a tower corridor without changing supplied heights or data', () => {
  const {context,run}=setup();
  const data=JSON.parse(readFileSync(new URL('../web/cities/gangnam.json',import.meta.url)));
  context.data=data;
  const profiles=run('data.buildings.map(b=>gangnamProfile(b,data.center))');
  assert.ok(profiles.filter(p=>p.estimated&&p.height>=90).length>=40);
  assert.ok(profiles.filter(p=>p.height<40).length>800);
  assert.ok(profiles.filter(p=>p.height>=150).length>=15);
  assert.ok(profiles.every(p=>Number.isFinite(p.height)&&p.height>0&&(!p.estimated||p.height<=210)));
  data.buildings.forEach((b,i)=>{ if(b.h!==15) assert.equal(profiles[i].height,b.h); });
  assert.deepEqual(JSON.parse(JSON.stringify(run('data.buildings.map(b=>gangnamProfile(b,data.center))'))),JSON.parse(JSON.stringify(profiles)));
  assert.equal(run('gangnamProfile({h:15,heightSource:"height",rings:[[[50,-40],[100,-40],[100,-90],[50,-90]]]},data.center).height'),15);
});


test('Gangnam streets use flat surfaces with distinct depth offsets for stable markings', () => {
  const {context,skyline,run}=setup();
  context.data=JSON.parse(readFileSync(new URL('../web/cities/gangnam.json',import.meta.url)));
  run('buildGangnam(data)');
  const layers=skyline.children.slice(-3);
  assert.equal(layers.length,3);
  layers.forEach((mesh,i)=>{
    assert.equal(mesh.material.polygonOffset,true);
    assert.equal(mesh.material.polygonOffsetFactor,-i-1);
    assert.equal(mesh.material.polygonOffsetUnits,-4*(i+1));
    const {position,normal}=mesh.geometry.attributes;
    for(let v=0;v<position.count;v++) {
      assert.ok(Math.abs(position.getY(v)+149.6)<.001);
      assert.ok(normal.getY(v)>.999);
    }
  });
});


test('Gangnam scenic background covers all directions without invading the mapped center', () => {
  const {context,run}=setup();
  context.data=JSON.parse(readFileSync(new URL('../web/cities/gangnam.json',import.meta.url)));
  const parts=run('buildGangnamBackdrop(data)'), offset=run('cityPoint(data.center,GANGNAM_VIEW_CENTER)');
  const quadrants=[0,0,0,0]; let triangles=0;
  for(const g of parts.flat()) {
    g.computeBoundingBox(); const center=g.boundingBox.getCenter(new THREE.Vector3());
    const b=g.boundingBox, x=center.x-offset[0], z=center.z-offset[1];
    assert.ok(b.max.x<offset[0]-600 || b.min.x>offset[0]+600 || b.max.z<offset[1]-600 || b.min.z>offset[1]+600);
    quadrants[(x<0?0:1)+(z<0?0:2)]++;
    triangles+=g.attributes.position.count/3;
    for(const a of Object.values(g.attributes)) assert.ok(a.array.every(Number.isFinite));
  }
  assert.ok(quadrants.every(n=>n>250),String(quadrants)); assert.ok(triangles<30000);
  for(const g of run('buildGangnamHills()')) {
    for(const a of Object.values(g.attributes)) assert.ok(a.array.every(Number.isFinite));
    for(let i=0;i<g.attributes.normal.count;i++) assert.ok(g.attributes.normal.getY(i)>0);
  }
});
