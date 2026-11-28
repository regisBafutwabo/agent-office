/* ---------- skyline ---------- */
const skyTex = canvasTex(8, 512);
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 16), new THREE.MeshBasicMaterial({ map: skyTex.t, side: THREE.BackSide, fog: false, depthWrite: false }));
skyDome.renderOrder = -1; scene.add(skyDome);
scene.fog = new THREE.Fog('#D6E1E7', 120, 420);
function drawSky(T) {
  const x = skyTex.x, g = x.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, T.skyTop); g.addColorStop(.47, T.skyMid); g.addColorStop(.5, T.haze); g.addColorStop(1, T.skyLow);
  x.fillStyle = g; x.fillRect(0, 0, 8, 512); skyTex.t.needsUpdate = true;
}
// facade: 8 windows x 4 storeys per 12x12 tile; a second map says which windows are lit at night
const facade = canvasTex(256, 256), litMap = canvasTex(256, 256);
{ const f = facade.x, l = litMap.x; f.fillStyle = '#DCE1E3'; f.fillRect(0, 0, 256, 256); l.fillStyle = '#000'; l.fillRect(0, 0, 256, 256);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) { const X = c * 32 + 5, Y = r * 64 + 10;
    f.fillStyle = `rgb(${88 + Math.random() * 20},${108 + Math.random() * 20},${128 + Math.random() * 18})`; f.fillRect(X, Y, 22, 46);
    f.fillStyle = 'rgba(255,255,255,.18)'; f.fillRect(X, Y, 22, 10);
    if (Math.random() < .42) { l.fillStyle = pick(['#FFD58A','#FFE7B8','#FFC870','#DDEBFF']); l.fillRect(X, Y, 22, 46); } }
  [facade, litMap].forEach(T => { T.t.wrapS = T.t.wrapT = THREE.RepeatWrapping; }); }
const CITY_TINTS = ['#9FB0BC','#8C9CA8','#B8B4AC','#7E8E99','#A9B3B8','#C2BEB5'];
const cityMats = CITY_TINTS.map(c => new THREE.MeshLambertMaterial({ color: c, map: facade.t, emissiveMap: litMap.t, emissive: new THREE.Color('#FFFFFF'), emissiveIntensity: 0 }));
const beaconMat = new THREE.MeshBasicMaterial({ color: '#FF3B30' });
// the office is a high floor of its own tower; the rest of the city sits well below and further out
const GROUND_Y = -150;
function facadeBox(w, h, d, mat) {
  const geo = new THREE.BoxGeometry(w, h, d), uv = geo.attributes.uv, tile = 12;
  [[d, h], [d, h], null, null, [w, h], [w, h]].forEach((f, fi) => { for (let k = 0; k < 4; k++) { const i = fi * 4 + k;
    if (f) uv.setXY(i, uv.getX(i) * f[0] / tile, uv.getY(i) * f[1] / tile); else uv.setXY(i, .01, .99); } });
  return new THREE.Mesh(geo, mat);
}
const city = new THREE.Group(); scene.add(city);
const skyline = new THREE.Group(); city.add(skyline);
{
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), new THREE.MeshLambertMaterial({ color: '#8E989C' })); ground.rotation.x = -Math.PI / 2; ground.position.y = GROUND_Y; city.add(ground);
  const own = facadeBox(28.6, -1.1 - GROUND_Y, 18.6, cityMats[3]); own.position.set(0, (GROUND_Y - 1.1) / 2, 0); city.add(own);
}
function buildGenericCity() {
  const city = skyline;
  const placed = [];
  for (let n = 0; n < 1400 && placed.length < 260; n++) {
    const ang = rand(0, Math.PI * 2), dist = rand(60, 340), x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const w = rand(12, 28), d = rand(12, 28);
    if (placed.some(p => Math.abs(p.x - x) < (p.w + w) / 2 + 4 && Math.abs(p.z - z) < (p.d + d) / 2 + 4)) continue;
    const top = dist < 130 ? rand(-95, -18) : dist < 220 ? rand(-70, 8) : rand(-45, 55);
    const h = top - GROUND_Y;
    const b = facadeBox(w, h, d, pick(cityMats)); b.position.set(x, GROUND_Y + h / 2, z); city.add(b);
    placed.push({ x, z, w, d });
    if (Math.random() < .5) { const ac = new THREE.Mesh(new THREE.BoxGeometry(rand(2, 5), 1.6, rand(2, 5)), cityMats[2]); ac.position.set(x + rand(-w / 4, w / 4), top + .8, z + rand(-d / 4, d / 4)); city.add(ac); }
    if (top > 0 && Math.random() < .6) { const m = new THREE.Mesh(new THREE.CylinderGeometry(.25, .25, 12, 6), cityMats[0]); m.position.set(x, top + 6, z); city.add(m);
      const bl = new THREE.Mesh(new THREE.SphereGeometry(.7, 8, 6), beaconMat); bl.position.set(x, top + 12.2, z); city.add(bl); }
  } }
buildGenericCity(); batchGenericCity();

// Non-indexed triangles with one material per batch; no geometry groups (and no extra draw calls).
function mergeCityGeometry(parts) {
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const size = parts[0].attributes[name].itemSize, length = parts.reduce((n, g) => n + g.attributes[name].array.length, 0);
    const array = new Float32Array(length); let offset = 0;
    for (const g of parts) { array.set(g.attributes[name].array, offset); offset += g.attributes[name].array.length; }
    merged.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  if (parts.some(g => g.attributes.color)) {
    const colors = new Float32Array(merged.attributes.position.count * 3); let offset = 0;
    for (const g of parts) {
      const length = g.attributes.position.count * 3;
      if (g.attributes.color) colors.set(g.attributes.color.array, offset); else colors.fill(1, offset, offset + length);
      offset += length;
    }
    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  parts.forEach(g => g.dispose()); merged.computeBoundingSphere(); return merged;
}
function batchGenericCity() {
  const batches = new Map();
  skyline.children.forEach(o => {
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone(); o.updateMatrix(); geo.applyMatrix4(o.matrix);
    if (!batches.has(o.material)) batches.set(o.material, []); batches.get(o.material).push(geo);
  });
  clearCity(); batches.forEach((parts, mat) => skyline.add(new THREE.Mesh(mergeCityGeometry(parts), mat)));
}
const cityUV = {
  generateTopUV: () => [0, 0, 0].map(() => new THREE.Vector2(.01, .99)),
  generateSideWallUV: (g, v, a, b, c, d) => {
    const dx = v[b * 3] - v[a * 3], dy = v[b * 3 + 1] - v[a * 3 + 1], length = Math.hypot(dx, dy) || 1;
    return [a, b, c, d].map(i => new THREE.Vector2(((v[i * 3] - v[a * 3]) * dx + (v[i * 3 + 1] - v[a * 3 + 1]) * dy) / length / 12, v[i * 3 + 2] / 12));
  }
};
// Hand-built interpretations, not survey meshes. Coordinates/heights and references: cities/README.md.
const SF_VIEW_CENTER = [37.7843, -122.3995];
const SF_LANDMARKS = [
  { name: 'Salesforce Tower', center: [37.7897, -122.3972], height: 326.1 },
  { name: 'Transamerica Pyramid', center: [37.795169, -122.402602], height: 260 },
  { name: '181 Fremont', center: [37.789788, -122.395356], height: 250.1 }
];
function cityPoint(center, origin) {
  return [(center[1] - origin[1]) * Math.PI / 180 * 6371000 * Math.cos(origin[0] * Math.PI / 180),
    (origin[0] - center[0]) * Math.PI / 180 * 6371000];
}
function footprintNear(ring, point, radius) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i], [x, z] = point;
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
    const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - ax - t * dx, z - az - t * dz) < radius) return true;
  }
  return inside;
}
// Three original facade drawings share one atlas and one draw call. No downloaded imagery.
const landmarkFacade = canvasTex(768, 1024), landmarkLights = canvasTex(768, 1024);
{
  const f = landmarkFacade.x, l = landmarkLights.x;
  l.fillStyle = '#000'; l.fillRect(0, 0, 768, 1024);
  ['#7496A6', '#DED9CB', '#7095A4'].forEach((base, tile) => {
    const X = tile * 256; f.fillStyle = base; f.fillRect(X, 0, 256, 1024);
    const floors = [70, 64, 56];
    for (let row = 0; row < floors[tile]; row++) {
      const y = row * 1024 / floors[tile], height = 1024 / floors[tile];
      for (let col = 0; col < 16; col++) {
        const x = X + col * 16;
        const crown = tile === 0 && row < 9, spire = tile === 1 && row < 16;
        if (spire) continue;
        f.fillStyle = tile === 1 ? '#68757B' : ['#719CB0','#7EA9BC','#8DB6C6','#9FC1CE'][Math.min(3, Math.floor(col / 4))];
        f.fillRect(x + (tile === 1 ? 4 : 1), y + 2, tile === 1 ? 8 : 14, height - 4);
        f.fillStyle = crown ? '#BECFD7' : 'rgba(232,245,248,.45)'; f.fillRect(x, y, 1.5, height);
        if (crown || (row * 13 + col * 7 + tile * 11) % 17 < 5) {
          l.fillStyle = crown ? '#B1D7F5' : (row + col) % 3 ? '#F1D8A7' : '#BFD8E2';
          l.fillRect(x + 3, y + 3, 10, height - 5);
        }
      }
    }
  });
}
const landmarkMat = new THREE.MeshLambertMaterial({ map: landmarkFacade.t, emissiveMap: landmarkLights.t, emissive: '#FFFFFF', emissiveIntensity: 0 });
const landmarkTrimMat = new THREE.MeshLambertMaterial({ color: '#FFFFFF', vertexColors: true });
// Rings are clockwise in the ground plane. Each quarter uses one complete facade tile.
function landmarkLoft(rings, tile, height) {
  const positions = [], uvs = [], n = rings[0].length;
  const vertex = (p, u, y) => { positions.push(...p); uvs.push((tile + .008 + u * .984) / 3, Math.max(.001, Math.min(.999, y / height))); };
  for (let r = 0; r < rings.length - 1; r++) for (let j = 0; j < n; j++) {
    const k = (j + 1) % n, a = rings[r][j], b = rings[r][k], c = rings[r + 1][k], d = rings[r + 1][j];
    const u = j % (n / 4) / (n / 4), v = u + 4 / n;
    [[a,u],[d,u],[c,v],[a,u],[c,v],[b,v]].forEach(([p,s]) => vertex(p, s, p[1]));
  }
  const roof = rings[rings.length - 1], center = roof.reduce((a,p) => a.map((v,i) => v + p[i] / n), [0,0,0]);
  for (let j = 0; j < n; j++) [center, roof[(j + 1) % n], roof[j]].forEach(p => vertex(p, .5, height));
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.computeVertexNormals(); return g;
}
// A scenic reconstruction: actual NW bearing, compressed distance and span for readability.
const SF_BRIDGE = { center: [37.8199, -122.4783], distance: 3600, span: 1280, tower: 227, deck: 80, angle: 1.75 };
function buildSFBridge() {
  const parts = [], orange = '#BC492D';
  const colorize = (g, color) => {
    const c = new THREE.Color(color), colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i+1] = c.g; colors[i+2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3)); parts.push(g);
  };
  const beam = (a,b,width,depth=width,color=orange) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
    const g = new THREE.BoxGeometry(width, delta.length(), depth).toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), delta.clone().normalize())));
    g.translate(...start.add(end).multiplyScalar(.5).toArray()); colorize(g,color);
  };
  const half = SF_BRIDGE.span / 2, deck = SF_BRIDGE.deck, top = SF_BRIDGE.tower, end = half + 205;
  // Two Art Deco towers, open portals and stepped crossbeams.
  for (const x of [-half,half]) {
    for (const z of [-18,18]) {
      beam([x,0,z],[x,top,z],9,10);
      beam([x,top-14,z],[x,top+3,z],7,8);
    }
    for (const y of [deck-12,deck+25,deck+69,deck+107,top-4]) beam([x,y,-18],[x,y,18],7,7);
    beam([x,3,-25],[x,3,25],22,12,'#A7AAA0');
  }
  const road = new THREE.BoxGeometry(end*2,5,34).toNonIndexed(); road.translate(0,deck,0); colorize(road,'#596469');
  for (const z of [-19,19]) {
    beam([-end,deck-5,z],[end,deck-5,z],4,4);
    beam([-end,deck+3,z],[end,deck+3,z],1.3);
    // The parabolic main cable meets the tower tops and descends to the anchorages.
    const cableY = x => Math.abs(x) <= half ? deck + 16 + (top - deck - 16) * (x / half) ** 2
      : top + (deck + 5 - top) * (Math.abs(x) - half) / (end - half);
    const xs = Array.from({length:65},(_,i) => -half + SF_BRIDGE.span*i/64);
    xs.unshift(-end); xs.push(end);
    for (let i=0;i<xs.length-1;i++) beam([xs[i],cableY(xs[i]),z],[xs[i+1],cableY(xs[i+1]),z],2.2);
    for (let i=1;i<64;i+=2) { const x=-half+SF_BRIDGE.span*i/64; beam([x,deck,z],[x,cableY(x),z],.9); }
    for (let x=-end;x<end-20;x+=32) {
      beam([x,deck-12,z],[Math.min(x+32,end),deck-5,z],1.1);
      beam([x,deck-5,z],[Math.min(x+32,end),deck-12,z],1.1);
    }
  }
  const [dx,dz] = cityPoint(SF_BRIDGE.center,SF_VIEW_CENTER), distance = Math.hypot(dx,dz);
  parts.forEach(g => { g.rotateY(SF_BRIDGE.angle); g.translate(dx/distance*SF_BRIDGE.distance, GROUND_Y, dz/distance*SF_BRIDGE.distance); });
  return parts;
}

// Continuous illustrative coast and terrain, independent of the real OSM building database.
function buildSFBackdrop() {
  const parts = [];
  const colorize = (g, color) => {
    const c = new THREE.Color(color), a = new Float32Array(g.attributes.position.count * 3);
    for (let i=0;i<a.length;i+=3) { a[i]=c.r; a[i+1]=c.g; a[i+2]=c.b; }
    g.setAttribute('color',new THREE.BufferAttribute(a,3)); parts.push(g);
  };
  const sea = new THREE.PlaneGeometry(24000,24000).toNonIndexed(); sea.rotateX(-Math.PI/2); sea.translate(0,GROUND_Y-2,0); colorize(sea,'#719DAA');
  const coast = [[-12000,12000],[12000,12000],[12000,2200],[3200,2100],[2850,1700],[2700,900],
    [2550,0],[2500,-1900],[2000,-2750],[1000,-3250],[-700,-3350],[-1750,-3100],[-2300,-2700],
    [-2550,-1850],[-2850,-1400],[-3700,-950],[-4800,-350],[-6500,700],[-12000,2200]];
  const land = new THREE.ShapeGeometry(new THREE.Shape(coast.map(([x,z]) => new THREE.Vector2(x,-z))));
  const landGeo = land.toNonIndexed(); land.dispose(); landGeo.rotateX(-Math.PI/2); landGeo.translate(0,GROUND_Y,0); colorize(landGeo,'#979E93');
  // Height fields with submerged edges replace the old vertical, single-sided shore cards.
  const terrain = (nx,nz,point,color) => {
    const p=[],uv=[],colors=[],base=new THREE.Color(color);
    const vertex = (i,j) => {
      const v=point(i/nx,j/nz); p.push(...v); uv.push(i/nx,j/nz);
      const shade=.88+.12*Math.sin(i*.7+j*.4); colors.push(base.r*shade,base.g*shade,base.b*shade);
    };
    for(let i=0;i<nx;i++) for(let j=0;j<nz;j++) [[i,j],[i,j+1],[i+1,j+1],[i,j],[i+1,j+1],[i+1,j]].forEach(([x,z])=>vertex(x,z));
    const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(p,3)); g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
    g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3)); g.computeVertexNormals(); parts.push(g);
  };
  const [bx,bz]=cityPoint(SF_BRIDGE.center,SF_VIEW_CENTER), length=Math.hypot(bx,bz), cx=bx/length*SF_BRIDGE.distance, cz=bz/length*SF_BRIDGE.distance;
  const c=Math.cos(SF_BRIDGE.angle),s=Math.sin(SF_BRIDGE.angle), end=SF_BRIDGE.span/2+205;
  terrain(42,44,(u,v)=>{
    const z=(v-.5)*12000, shore=end-40+Math.abs(z)*.14+90*Math.sin(z/900), x=shore+u*10000;
    const rise=1-Math.exp(-u*10000/650), ridge=450+300*Math.sin(u*7+v*4)**2+180*Math.cos(v*9)**2;
    return [cx+x*c+z*s,GROUND_Y-4+rise*ridge,cz-x*s+z*c];
  },'#5F756B');
  // Western / southern ridges sit beyond the enlarged city sample, with a gentle foot slope.
  terrain(36,40,(u,v)=>{
    const x=-9800+u*7500,z=-900+v*12000;
    const rise=(1-Math.exp(-(1-u)*7500/550))*Math.min(1,v*12);
    const h=rise*(100+150*Math.sin(u*7+v*10)**2+80*Math.cos(v*12)**2);
    return [x,GROUND_Y+h,z];
  },'#8A947E');
  return parts;
}

function buildSFLandmarks() {
  const bodies = [], trims = [];
  SF_LANDMARKS.forEach((landmark, index) => {
    const localBody = [], localTrim = [];
    const beam = (a, b, width = .6) => {
      const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
      const g = new THREE.CylinderGeometry(width, width, delta.length(), 4).toNonIndexed();
      g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), delta.clone().normalize())));
      g.translate(...start.add(end).multiplyScalar(.5).toArray()); localTrim.push(g);
    };
    if (index === 0) {
      const profiles = [[0,27],[24,28],[100,27.7],[200,25.5],[260,22.5],[289,19],[308,14],[320,8],[326.1,.6]];
      const rings = profiles.map(([y,r]) => Array.from({length:64}, (_,j) => {
        const a = j / 64 * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        return [Math.sign(c) * Math.abs(c) ** .65 * r, y, Math.sign(s) * Math.abs(s) ** .65 * r];
      }));
      localBody.push(landmarkLoft(rings, index, landmark.height));
      for (let j = 0; j < 64; j += 2) for (let r = 4; r < rings.length - 1; r++) beam(rings[r][j], rings[r + 1][j], .23);
      for (const r of [4,5,6,7]) for (let j = 0; j < 64; j++) beam(rings[r][j], rings[r][(j+1)%64], .18);
    } else if (index === 1) {
      const ring = (y,r) => [[r,y,r],[-r,y,r],[-r,y,-r],[r,y,-r]];
      localBody.push(landmarkLoft([[13,25],[174,9.5],[210,5.5],[260,.15]].map(([y,r]) => ring(y,r)), index, landmark.height));
      // Open concrete base with its characteristic V braces, and the two elevator wings.
      for (let side = 0; side < 4; side++) {
        const lower = ring(0,25), upper = ring(13,25), a = upper[side], b = upper[(side+1)%4];
        for (let k = 0; k < 3; k++) {
          const t = (k + .5) / 3, foot = lower[side].map((v,i) => v * (1-t) + lower[(side+1)%4][i] * t);
          beam(foot, a.map((v,i) => v * (1-k/3) + b[i] * k/3), .95);
          beam(foot, a.map((v,i) => v * (1-(k+1)/3) + b[i] * (k+1)/3), .95);
        }
      }
      [-1,1].forEach(s => { const g = new THREE.BoxGeometry(7,80,7).toNonIndexed(); g.translate(s*12,155,0); localTrim.push(g); });
    } else {
      const ring = (y,w,d,shift=0) => [[w+shift,y,d],[-w+shift,y,d],[-w+shift,y,-d],[w+shift,y,-d]];
      const rings = [ring(0,15,21), ring(70,14,20,1), ring(140,12.5,18,2), ring(209,11,16,3)];
      const roof = ring(229,10.5,15.5,3); roof[0][1] = roof[3][1] = 218; rings.push(roof);
      localBody.push(landmarkLoft(rings, index, 229));
      for (let r = 0; r < rings.length-1; r++) for (let j = 0; j < 4; j++) {
        beam(rings[r][j], rings[r+1][j], .65);
        beam(rings[r][j], rings[r+1][(j+1)%4], .75);
        beam(rings[r][(j+1)%4], rings[r+1][j], .75);
      }
      beam([-7.5,229,-15.5],[-7.5,250.1,-15.5],.5);
    }
    const [x,z] = cityPoint(landmark.center, SF_VIEW_CENTER);
    for (const [parts,target] of [[localBody,bodies],[localTrim,trims]]) parts.forEach(g => {
      g.rotateY(-.66); g.translate(x, GROUND_Y, z); target.push(g);
    });
  });
  trims.push(...buildSFBridge(), ...buildSFBackdrop());
  [[bodies,landmarkMat],[trims,landmarkTrimMat]].forEach(([parts,material]) => skyline.add(new THREE.Mesh(mergeCityGeometry(parts), material)));
}
// Gangnam is a photo-guided interpretation over the unchanged OSM snapshot.
const GANGNAM_VIEW_CENTER = [37.4992, 127.0338];
const GANGNAM_LANDMARKS = [
  { name: 'Gangnam Finance Center', center: [37.50001544, 127.03653603], height: 204, kind: 'gfc' },
  { name: 'GS Tower', center: [37.50223677, 127.03769228], height: 167, kind: 'gs' },
  { name: 'Centerfield North', center: [37.50355877, 127.04159179], height: 159, kind: 'centerfield' },
  { name: 'Centerfield South', center: [37.50290226, 127.04134241], height: 159, kind: 'centerfield' },
  { name: 'GT Tower', center: [37.49806, 127.02594], height: 130.1, kind: 'gt' }
];
const gangnamFacade = canvasTex(768, 1024), gangnamLights = canvasTex(768, 1024);
{
  const f = gangnamFacade.x, l = gangnamLights.x;
  l.fillStyle = '#000'; l.fillRect(0, 0, 768, 1024);
  ['#74949D', '#C3CAC7', '#899DA4'].forEach((base, tile) => {
    const X = tile * 256; f.fillStyle = base; f.fillRect(X, 0, 256, 1024);
    for (let row = 0; row < 44; row++) {
      const y = 8 + row * 23;
      for (let col = 0; col < 16; col++) {
        const x = X + col * 16;
        f.fillStyle = ['#355865', '#537984', '#48717F'][tile];
        f.fillRect(x + 2, y + 2, 12, 18);
        if ((row * 7 + col * 11) % 23 < 7) {
          l.fillStyle = row % 3 ? '#FFE8BF' : '#CBDDE7'; l.fillRect(x + 2, y + 2, 12, 18);
        }
      }
      f.fillStyle = tile === 0 ? '#C2CBC9' : '#7F969C'; f.fillRect(X, y, 256, tile === 0 ? 4 : 1);
    }
    if (tile === 1) for (let x = 0; x < 256; x += 8) {
      f.fillStyle = x % 32 === 0 ? '#F0ECE1' : '#CED6D2'; f.fillRect(X + x, 8, 2, 1016);
    }
  });
}
const gangnamLandmarkMat = new THREE.MeshLambertMaterial({ map: gangnamFacade.t, emissiveMap: gangnamLights.t, emissive: '#FFFFFF', emissiveIntensity: 0 });
// Repeating neighborhood facades: office ribbon windows, pale masonry, brick shops.
const gangnamNeighborhood = [0,1,2,3].map(style => {
  const tex = canvasTex(256,256), lights = canvasTex(256,256), f = tex.x, l = lights.x;
  f.fillStyle = ['#BAC8C9','#D5D0C4','#B59B8A','#BACDD3'][style]; f.fillRect(0,0,256,256);
  l.fillStyle = '#000'; l.fillRect(0,0,256,256);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 8; c++) {
    const x = c*32+4, y = r*64+12, w = style === 0 ? 28 : 19;
    f.fillStyle = ['#557F8A','#68777A','#526D70','#7198AD'][style]; f.fillRect(x,y,w,37);
    if ((r*7+c*11+style)%9<3) { l.fillStyle = '#FFE6B5'; l.fillRect(x,y,w,37); }
    if (style === 0) { f.fillStyle = '#E4E7DC'; f.fillRect(c*32,r*64+53,32,5); }
  }
  if (style===3) for(let x=0;x<256;x+=16) { f.fillStyle='#D4E0DF'; f.fillRect(x,0,2,256); }
  [tex,lights].forEach(t => { t.t.wrapS = t.t.wrapT = THREE.RepeatWrapping; });
  return { tex, lights };
});
const gangnamMats = cityMats.map((c,i) => new THREE.MeshLambertMaterial({ color: '#FFFFFF', vertexColors: true,
  map: gangnamNeighborhood[[0,1,2,3,1,0][i]].tex.t, emissiveMap: gangnamNeighborhood[[0,1,2,3,1,0][i]].lights.t, emissive: '#FFFFFF', emissiveIntensity: 0 }));
// Stable depth ordering for pavement, asphalt and paint at rooftop viewing distances.
const gangnamStreetMats = [1,2,3].map(layer => new THREE.MeshLambertMaterial({
  color:'#FFFFFF', vertexColors:true, polygonOffset:true, polygonOffsetFactor:-layer, polygonOffsetUnits:-4*layer
}));
function gangnamColor(g, color) {
  const c = new THREE.Color(color), colors = new Float32Array(g.attributes.position.count*3);
  for (let i=0;i<colors.length;i+=3) { colors[i]=c.r; colors[i+1]=c.g; colors[i+2]=c.b; }
  g.setAttribute('color',new THREE.BufferAttribute(colors,3)); return g;
}
// Art direction only: the older bake doesn't retain provenance for individual 15 m entries.
// Keep other heights (and explicitly sourced 15 m heights) intact; never write estimates to the data.
function gangnamProfile(b, center) {
  const r=b.rings[0], n=r.length, point=r.reduce((s,p)=>[s[0]+p[0]/n,s[1]+p[1]/n],[0,0]);
  let area=0, perimeter=0;
  for(let i=0,j=n-1;i<n;j=i++) {
    area+=r[j][0]*r[i][1]-r[i][0]*r[j][1]; perimeter+=Math.hypot(r[i][0]-r[j][0],r[i][1]-r[j][1]);
  }
  area=Math.abs(area)/2;
  const origin=cityPoint(center,[37.5006,127.0364]), x=point[0]+origin[0], z=point[1]+origin[1];
  const seed=Math.abs(Math.sin(Math.round(x)*12.9898+Math.round(z)*78.233)*43758.5453)%1;
  const teheran=Math.abs(z+x*230/610)/Math.hypot(1,230/610);
  const nonhyeon=Math.abs(x-z*210/590)/Math.hypot(1,210/590);
  let height=b.h;
  if(b.h===15 && (!b.heightSource || b.heightSource==='default')) {
    const thickness=2*area/(perimeter||1);
    if(teheran<180 && area>350 && thickness>8) height=132+seed*77;
    else if(Math.min(teheran,nonhyeon)<200 && area>280 && thickness>8) height=65+seed*65;
    else if(area>500) height=35+seed*43;
    else height=12+seed*23;
    // Small/slender footprints should never become needles.
    height=Math.min(height,Math.max(18,thickness*18));
    height=Math.round(height/3.5)*3.5;
  }
  return {height, point, seed, estimated:height!==b.h};
}

// Scenic background only, not map records. Keep all of it outside the real snapshot.
function buildGangnamBackdrop(data) {
  const batches=gangnamMats.map(()=>[]), offset=cityPoint(data.center,GANGNAM_VIEW_CENTER);
  const radius=data.radius||600, extent=2400;
  const noise=(x,z,s=0)=>Math.abs(Math.sin(x*12.9898+z*78.233+s*31.7)*43758.5453)%1;
  const landmarks=GANGNAM_LANDMARKS.map(l=>cityPoint(l.center,data.center));
  for(let x=-extent;x<=extent;x+=120) for(let z=-extent;z<=extent;z+=120) {
    if(Math.hypot(x,z)>extent || (Math.abs(x)<radius+100 && Math.abs(z)<radius+100)) continue;
    const along=Math.abs(z+x*230/610)/Math.hypot(1,230/610);
    const across=Math.abs(x-z*210/590)/Math.hypot(1,210/590);
    if(along<45||across<38||landmarks.some(p=>Math.hypot(x-p[0],z-p[1])<100)) continue;
    for(let k=0;k<2;k++) {
      const seed=noise(x,z,k), px=x+(k?29:-29), pz=z+(noise(x,z,k+4)-.5)*35;
      const office=along<200, apartment=!office&&seed>.88;
      const w=apartment?54:23+seed*22, d=apartment?19:22+noise(x,z,k+8)*23;
      const h=office?85+seed*100:apartment?95+seed*50:18+seed*65;
      const g=new THREE.BoxGeometry(w,h,d), uv=g.attributes.uv;
      [[d,h],[d,h],null,null,[w,h],[w,h]].forEach((face,fi)=>{
        for(let v=0;v<4;v++) { const i=fi*4+v; uv.setXY(i,face?uv.getX(i)*face[0]/12:.01,face?uv.getY(i)*face[1]/12:.99); }
      });
      const geometry=g.toNonIndexed(); g.dispose();
      geometry.rotateY(.36); geometry.translate(px+offset[0],GROUND_Y+h/2,pz+offset[1]);
      gangnamColor(geometry,office?'#A9BEC6':apartment?'#DFDFD2':'#C5C7BC');
      batches[office?[0,3,4][Math.floor(seed*3)]:Math.floor(seed*6)].push(geometry);
    }
  }
  return batches;
}
function buildGangnamHills() {
  const parts=[], sections=96, rings=[2850,3200,3650];
  const height=(a,r)=>r===0?0:r===2?30:105+85*Math.sin(a*3+.4)**2+65*Math.cos(a*7)**2;
  for(let r=0;r<2;r++) for(let i=0;i<sections;i++) {
    const a=i/sections*Math.PI*2, b=(i+1)/sections*Math.PI*2;
    const point=(angle,index)=>[Math.cos(angle)*rings[index],GROUND_Y+height(angle,index),Math.sin(angle)*rings[index]];
    const p=point(a,r),q=point(b,r),s=point(a,r+1),t=point(b,r+1);
    const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute([...p,...q,...s,...q,...t,...s],3));
    g.setAttribute('uv',new THREE.Float32BufferAttribute(new Array(12).fill(0),2)); g.computeVertexNormals();
    parts.push(gangnamColor(g,'#839A8D'));
  }
  return parts;
}

function buildGangnam(data) {
  const bodies = [], trim = [], streets = [[],[],[]], offset = cityPoint(data.center, GANGNAM_VIEW_CENTER);
  const box = (w,h,d,x,y,z,color) => { const g = new THREE.BoxGeometry(w,h,d).toNonIndexed(); g.translate(x,y,z); return gangnamColor(g,color); };
  // Clockwise perimeter with clipped corners; dimensions are visual approximations.
  const ring = (y,w,d,c=3) => [[w,y,d-c],[w-c,y,d],[-w+c,y,d],[-w,y,d-c],[-w,y,-d+c],[-w+c,y,-d],[w-c,y,-d],[w,y,-d+c]];
  for (const landmark of GANGNAM_LANDMARKS) {
    const local = [], detail = [], h = landmark.height;
    if (landmark.kind === 'gfc') {
      local.push(landmarkLoft([ring(0,38,27,7),ring(12,38,27,7),ring(12,33,24,6),ring(169,33,24,6),ring(180,29,21,5),ring(193,23,17,4),ring(h,17,12,3)],0,h));
      for (const [y,w,d] of [[12,38,27],[169,33,24],[180,29,21],[193,23,17]]) detail.push(box(w*2+1,1.3,d*2+1,0,y,0,'#D1D3C8'));
      for (const x of [-29,29]) detail.push(box(2.6,156,3,x,90,23,'#D9D7C9'),box(2.6,156,3,x,90,-23,'#D9D7C9'));
    } else if (landmark.kind === 'centerfield') {
      local.push(landmarkLoft([ring(0,25,29),ring(14,25,29),ring(14,22,26),ring(119,22,26),ring(139,20,24),ring(h,18,22)],1,h));
      for (let x=-20;x<=20;x+=4) for (const side of [-1,1]) detail.push(box(.45,124,.8,x,76,side*26,'#D5D9CD'));
      for (const [y,w,d] of [[14,25,29],[119,22,26],[139,20,24],[h,18,22]]) detail.push(box(w*2,1,d*2,0,y,0,'#E0DFD3'));
    } else if (landmark.kind === 'gs') {
      local.push(landmarkLoft([ring(0,34,26,2),ring(18,34,26,2),ring(18,25,24,2),ring(150,25,24,2),ring(157,23,22,2),ring(h,20,19,2)],1,h));
      for (let y=22;y<150;y+=4.6) detail.push(box(51,.6,49,0,y,0,'#CBD1CB'));
      detail.push(box(16,9,14,0,161,0,'#BBC5C3'));
    } else {
      const rings = Array.from({length:33},(_,j) => {
        const y=j*h/32, shift=5*Math.sin(y/h*Math.PI*2-.5), swell=2.5*Math.cos(y/h*Math.PI*3);
        return ring(y,23+swell,22,7).map(([x,y,z]) => [x+shift,y,z]);
      });
      local.push(landmarkLoft(rings,2,h));
      for (let j=2;j<32;j+=2) {
        const y=j*h/32, shift=5*Math.sin(y/h*Math.PI*2-.5), swell=2.5*Math.cos(y/h*Math.PI*3);
        // Thin ribbon outlines follow the undulating body.
        detail.push(landmarkLoft([ring(y,23+swell,22,7),ring(y+.45,23+swell,22,7)].map(r=>r.map(([x,y,z])=>[x+shift,y,z])),2,h));
      }
    }
    const p = cityPoint(landmark.center,data.center);
    for (const [parts,target] of [[local,bodies],[detail,trim]]) for (const g of parts) {
      g.rotateY(.36); g.translate(p[0]+offset[0],GROUND_Y,p[1]+offset[1]); target.push(g);
    }
  }
  // Draw the two main avenues schematically through their mapped intersection.
  // Street furniture and markings are authored scenery, not extra OSM records.
  const avenue = (a,b,width,lanes) => {
    const dx=b[0]-a[0], dz=b[1]-a[1], length=Math.hypot(dx,dz), angle=-Math.atan2(dz,dx);
    const parts = [], layers = [[],[],[]];
    const surface = (layer,w,d,x,z,color) => {
      const g=new THREE.PlaneGeometry(w,d).toNonIndexed(); g.rotateX(-Math.PI/2); g.translate(x,.4,z);
      layers[layer].push(gangnamColor(g,color));
    };
    surface(0,length,width+10,0,0,'#B8B6A9');
    surface(1,length,width,0,0,'#596268');
    for (let lane=1;lane<lanes;lane++) {
      const z=-width/2+width*lane/lanes;
      for (let x=-length/2+6;x<length/2-6;x+=14) if (Math.abs(x)>40 && Math.abs(x)<900) surface(2,6,.4,x,z,lane===lanes/2?'#EBC873':'#D8DBCF');
    }
    for (const x of [-33,33]) for (let z=-width/2+1;z<width/2-1;z+=2.4) surface(2,4.5,1.1,x,z,'#E2E3D9');
    for (let x=-length/2+14;x<length/2-14;x+=26) for (const side of [-1,1]) {
      // Leave the central intersection open.
      if (Math.abs(x)<35 || Math.abs(x)>900) continue;
      const z=side*(width/2+3.5);
      parts.push(box(.65,5,.65,x,2.5,z,'#6C6759'));
      const crown = new THREE.IcosahedronGeometry(3.4,0); crown.scale(1,1.4,1); crown.translate(x,7,z); parts.push(gangnamColor(crown,'#63846A'));
    }
    const place = (g,target) => { g.rotateY(angle); g.translate((a[0]+b[0])/2+offset[0],GROUND_Y,(a[1]+b[1])/2+offset[1]); target.push(g); };
    parts.forEach(g=>place(g,trim));
    layers.forEach((parts,i)=>parts.forEach(g=>place(g,streets[i])));
  };
  const streetOrigin = cityPoint([37.5006,127.0364],data.center);
  const streetPoint = p => p.map((v,i)=>v+streetOrigin[i]);
  avenue(streetPoint([-2196,828]),streetPoint([2196,-828]),38,8);
  avenue(streetPoint([-756,-2124]),streetPoint([756,2124]),30,6);
  // Mechanical details follow the same artistic profile as the roof beneath them.
  data.buildings.forEach((b,i)=>{
    const profile=gangnamProfile(b,data.center);
    if (i%5 || profile.height>90 || GANGNAM_LANDMARKS.some(l=>footprintNear(b.rings[0],cityPoint(l.center,data.center),0))) return;
    const r=b.rings[0], x=r.reduce((s,p)=>s+p[0],0)/r.length, z=r.reduce((s,p)=>s+p[1],0)/r.length;
    if (footprintNear(r,offset.map(v=>-v),25) || !footprintNear(r,[x,z],0)) return;
    // Only place small rooftop units on roofs wide enough to contain them.
    if (![[x-2,z-2],[x+2,z-2],[x+2,z+2],[x-2,z+2]].every(p=>footprintNear(r,p,0))) return;
    trim.push(box(3,1.4,2,x+offset[0],GROUND_Y+profile.height+.7,z+offset[1],'#B7BCB1'));
  });
  trim.push(...buildGangnamHills());
  const ground = new THREE.PlaneGeometry(10000,10000).toNonIndexed(); ground.rotateX(-Math.PI/2); ground.translate(0,GROUND_Y-.1,0); trim.push(gangnamColor(ground,'#ABB1AA'));
  [[bodies,gangnamLandmarkMat],[trim,landmarkTrimMat],...streets.map((parts,i)=>[parts,gangnamStreetMats[i]])].forEach(([parts,mat])=>skyline.add(new THREE.Mesh(mergeCityGeometry(parts),mat)));
}

function setCityAtmosphere(id) {
  const sf = id === 'sf', gangnam = id === 'gangnam'; scene.fog.near = sf ? 800 : gangnam ? 650 : 120; scene.fog.far = sf ? 6000 : gangnam ? 3800 : 420;
  camera.fov = 40; camera.far = sf ? 7000 : gangnam ? 4200 : 900; camera.updateProjectionMatrix(); skyDome.scale.setScalar(sf ? 10 : gangnam ? 9 : 1);
  city.children[1].visible = id === 'generic';
  $('#city-credit').textContent = gangnam ? 'Artistic skyline · estimated heights · © OpenStreetMap contributors' : sf ? 'Stylized landmarks · © OpenStreetMap contributors' : '© OpenStreetMap contributors';
}

function buildRealCity(data) {
  if (!data.buildings?.length) throw new Error('Empty city');
  const materials = data.id === 'gangnam' ? gangnamMats : cityMats, batches = materials.map(() => []);
  const offset = data.id === 'sf' ? cityPoint(data.center, SF_VIEW_CENTER) : data.id === 'gangnam' ? cityPoint(data.center, GANGNAM_VIEW_CENTER) : [0,0];
  try {
    data.buildings.forEach((b, i) => {
      if (!Number.isFinite(b.h) || b.h <= 0 || !b.rings?.length || b.rings.some(r => r.length < 3 || r.some(p => p.length !== 2 || !p.every(Number.isFinite)))) throw new Error('Invalid building');
      if (data.id === 'sf' && (footprintNear(b.rings[0], offset.map(v => -v), 25) ||
        SF_LANDMARKS.some(l => footprintNear(b.rings[0], cityPoint(l.center, data.center), 0)))) return;
      if (data.id === 'gangnam' && (footprintNear(b.rings[0], offset.map(v => -v), 25) ||
        GANGNAM_LANDMARKS.some(l => footprintNear(b.rings[0], cityPoint(l.center, data.center), 0)))) return;
      const profile = data.id === 'gangnam' ? gangnamProfile(b,data.center) : {height:b.h};
      const tiers = profile.estimated && profile.height>80 && profile.seed>.35 ? (profile.seed>.72 ? [[0,.78,1],[.78,.94,.86],[.94,1,.7]] : [[0,.88,1],[.88,1,.8]]) : [[0,1,1]];
      const materialIndex = data.id === 'gangnam' && profile.height>75 ? [0,3,4][i%3] : i%materials.length;
      for(const [bottom,top,scale] of tiers) {
        const paths = b.rings.map(r => r.map(([x,z]) => {
          if(scale!==1) { x=profile.point[0]+(x-profile.point[0])*scale; z=profile.point[1]+(z-profile.point[1])*scale; }
          return new THREE.Vector2(x+offset[0],-z-offset[1]);
        }));
        const shape = new THREE.Shape(paths[0]); shape.holes = paths.slice(1).map(p => new THREE.Path(p));
        const geo = new THREE.ExtrudeGeometry(shape, { depth:profile.height*(top-bottom), bevelEnabled:false, steps:1, UVGenerator:cityUV });
        geo.rotateX(-Math.PI/2); geo.translate(0,GROUND_Y+profile.height*bottom,0);
        if(data.id==='gangnam') {
          const tint = profile.height>75 ? ['#B1C9CE','#C5D1D1','#94B3BE'][i%3] : ['#EBE1CC','#CFD7CE','#E3CFBD'][i%3];
          gangnamColor(geo,tint);
          const colors=geo.attributes.color, roof=new THREE.Color(profile.height>75?'#ABB9BC':['#719686','#99A89B','#BCBFB1'][i%3]);
          for(let v=0;v<colors.count;v++) if(geo.attributes.normal.getY(v)>.5) colors.setXYZ(v,roof.r,roof.g,roof.b);
        }
        batches[materialIndex].push(geo);
      }
    });
    if (data.id === 'gangnam') buildGangnamBackdrop(data).forEach((parts,i)=>batches[i].push(...parts));
    batches.forEach((parts, i) => { if (parts.length) skyline.add(new THREE.Mesh(mergeCityGeometry(parts), materials[i])); });
    if (data.id === 'sf') buildSFLandmarks();
    if (data.id === 'gangnam') buildGangnam(data);
  } catch (err) { batches.flat().forEach(g => g.dispose()); throw err; }
}
const CITIES = { gangnam: 'Seoul', sf: 'San Francisco', generic: 'Generic city' };
let cityKey = 'generic', cityRequest = 0, cityController;
function clearCity() { skyline.traverse(o => { if (o.geometry) o.geometry.dispose(); }); skyline.clear(); }
async function setCity(id) {
  if (!Object.hasOwn(CITIES, id)) return false;
  const request = ++cityRequest; if (cityController) cityController.abort();
  document.querySelectorAll('[data-city]').forEach(b => b.setAttribute('aria-busy', b.dataset.city === id && id !== cityKey));
  const controller = cityController = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    let data;
    if (id !== 'generic') {
      const response = await fetch(`/cities/${id}.json`, { signal: controller.signal });
      if (!response.ok) throw new Error('City unavailable'); data = await response.json();
      if (data.id !== id) throw new Error('Wrong city');
    }
    if (request !== cityRequest) return false;
    clearCity(); if (data) buildRealCity(data); else { buildGenericCity(); batchGenericCity(); }
    setCityAtmosphere(id); refreshSkyLife(id); cityKey = id; uiPrefs.city = id; saveUi(); $('#city-credit').hidden = id === 'generic';
    $('#city-picker').close(); $('#city-status').hidden = true; buildCityChoices(); return true;
  } catch (err) {
    try { if (/^https?:$/.test(location.protocol)) officeAuth.fetch('/api/log', { method: 'POST', body: JSON.stringify({ kind: 'city', id, message: String(err && err.stack || err) }), keepalive: true }).catch(() => {}); } catch (_) {}
    if (request !== cityRequest) return false;
    clearCity(); buildGenericCity(); batchGenericCity(); cityKey = 'generic'; setCityAtmosphere('generic'); refreshSkyLife('generic'); $('#city-credit').hidden = true; buildCityChoices();
    const message = location.protocol === 'file:' ? 'Open the office through its local server to load real cities.' : 'Couldn’t load that city. Showing Generic city.'; toast(message);
    $('#city-status').textContent = message; $('#city-status').hidden = false; return false;
  } finally { clearTimeout(timeout); }
}

/* ---------- living sky: drifting clouds, blinking roof lights, a passing helicopter ---------- */
// Built once and shared. A frame turns one mesh, sets a few colors and, while it flies, moves the helicopter:
// no allocations and at most four extra draw calls. With reduced motion it all holds still.
// Coarse roof heights, mapped once per city, so the helicopter climbs over towers and lights go on the tallest.
const HGRID = { cell: 15, n: 100 };
['top', 'x', 'z'].forEach(k => { HGRID[k] = new Float32Array(HGRID.n * HGRID.n); });
function hCell(x, z) {
  const i = Math.floor(x / HGRID.cell + HGRID.n / 2), j = Math.floor(z / HGRID.cell + HGRID.n / 2);
  return i < 0 || j < 0 || i >= HGRID.n || j >= HGRID.n ? -1 : j * HGRID.n + i;
}
function mapRoofs() {
  HGRID.top.fill(GROUND_Y);
  skyline.children.forEach(o => { if (!o.isMesh) return; const a = o.geometry.attributes.position.array;
    for (let k = 0; k < a.length; k += 3) { const c = hCell(a[k], a[k + 2]);
      if (c >= 0 && a[k + 1] > HGRID.top[c]) { HGRID.top[c] = a[k + 1]; HGRID.x[c] = a[k]; HGRID.z[c] = a[k + 2]; } } });
}
// The highest roof in and around the cell, so a rotor never clips the tower next door.
function roofNear(x, z) {
  let h = GROUND_Y;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const c = hCell(x + di * HGRID.cell, z + dj * HGRID.cell); if (c >= 0 && HGRID.top[c] > h) h = HGRID.top[c]; }
  return h;
}
const glowDot = canvasTex(32, 32);
{ const g = glowDot.x.createRadialGradient(16, 16, 0, 16, 16, 16); g.addColorStop(0, '#FFFFFF'); g.addColorStop(.35, 'rgba(255,255,255,.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  glowDot.x.fillStyle = g; glowDot.x.fillRect(0, 0, 32, 32); }
// Real cities have no modelled masts: a few pixels of light on the tallest roofs, the same size near or far.
const beaconDotMat = new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, map: glowDot.t, transparent: true, depthWrite: false, fog: false });
const beaconBase = new THREE.Color('#C8453C');
function lightTallRoofs() {
  const order = [];
  for (let c = 0; c < HGRID.top.length; c++) if (HGRID.top[c] > GROUND_Y + 90) order.push(c);
  order.sort((a, b) => HGRID.top[b] - HGRID.top[a]);
  const pts = [];
  for (const c of order) {
    if (pts.length >= 40 * 3) break;
    let near = false; for (let k = 0; k < pts.length && !near; k += 3) near = Math.hypot(pts[k] - HGRID.x[c], pts[k + 2] - HGRID.z[c]) < 60;
    if (!near) pts.push(HGRID.x[c], HGRID.top[c] + 1.5, HGRID.z[c]);
  }
  if (!pts.length) return;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  skyline.add(new THREE.Points(g, beaconDotMat));
}
// One soft cloud drawing, flipped and stretched into wisps that hang just over the nearby roofs, below the office:
// the camera looks down, so higher or farther clouds would sit above the top of the screen.
const cloudTex = canvasTex(256, 128);
for (let k = 0; k < 9; k++) {
  const cx = 40 + k * 22 + rand(-6, 6), cy = 64 + rand(-14, 14), r = rand(24, 44) * (1 - Math.abs(k - 4) / 7);
  const g = cloudTex.x.createRadialGradient(cx, cy, 0, cx, cy, r); g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(.5, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  cloudTex.x.fillStyle = g; cloudTex.x.fillRect(cx - r, cy - r, r * 2, r * 2);
}
const cloudMat = new THREE.MeshBasicMaterial({ map: cloudTex.t, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: .8 });
const clouds = (() => {
  const pos = [], uv = [], index = [];
  for (let k = 0; k < 16; k++) {
    const a = (k + Math.random() * .6) / 16 * Math.PI * 2, w = rand(30, 60), r = rand(w / 2 + 22, 110), d = w * rand(.35, .55), y = rand(-20, -8);
    const t = rand(0, Math.PI), c = Math.cos(t), s = Math.sin(t), cx = Math.cos(a) * r, cz = Math.sin(a) * r, flip = Math.random() < .5, base = pos.length / 3;
    for (const [u, v] of [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]]) {
      const lx = u * w, lz = v * d; pos.push(cx + lx * c - lz * s, y, cz + lx * s + lz * c); uv.push(flip ? .5 - u : u + .5, v + .5);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(index);
  const m = new THREE.Mesh(g, cloudMat); m.renderOrder = -1;   // under the office glass, which is transparent too
  city.add(m); return m;
})();
cloudTex.t.anisotropy = 1;   // soft wisps look the same without it, and it is costly on slanted see-through surfaces
// A computer with no graphics card draws every pixel on the CPU, and these big see-through wisps cost it the most.
// There the clouds still drift but are not drawn; the lights and the helicopter are only a few pixels.
const softwareGL = (() => {
  try { const gl = renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
    return /swiftshader|llvmpipe|software/i.test(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : ''); } catch (_) { return false; }
})();
clouds.visible = !softwareGL;
const heli = new THREE.Group(); heli.rotation.order = 'YXZ'; heli.scale.setScalar(1.6); heli.visible = false; city.add(heli);
const heliRotor = new THREE.Mesh(mergeCityGeometry([new THREE.BoxGeometry(9.5, .06, .3).toNonIndexed(), new THREE.BoxGeometry(.3, .06, 9.5).toNonIndexed()]),
  new THREE.MeshBasicMaterial({ color: '#1E2328', transparent: true, opacity: .6, depthWrite: false }));
const heliLightMat = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, map: glowDot.t, vertexColors: true, transparent: true, depthWrite: false, fog: false });
{
  const parts = [], paint = (geo, color, x, y, z) => { geo = geo.toNonIndexed(); geo.translate(x, y, z); gangnamColor(geo, color); parts.push(geo); };
  paint(new THREE.BoxGeometry(2.2, 1.9, 4.2), '#D9543C', 0, 0, .4);      // cabin
  paint(new THREE.BoxGeometry(2, 1, 1.2), '#2B3640', 0, .25, 2.4);       // windscreen
  paint(new THREE.BoxGeometry(.45, .45, 5), '#D9543C', 0, .35, -4.2);    // tail boom
  paint(new THREE.BoxGeometry(.18, 1.5, 1), '#D9543C', 0, .9, -6.6);     // fin
  paint(new THREE.BoxGeometry(.3, .5, .3), '#3A3F45', 0, 1.2, .4);       // mast
  for (const x of [-1.05, 1.05]) paint(new THREE.BoxGeometry(.12, .12, 4.6), '#3A3F45', x, -1.35, .3);   // skids
  heli.add(new THREE.Mesh(mergeCityGeometry(parts), new THREE.MeshLambertMaterial({ color: '#FFFFFF', vertexColors: true })));
  heliRotor.position.set(0, 1.5, .4); heli.add(heliRotor);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, .4, 0, 1.7, -6.9], 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute([1, .23, .19, 1, 1, 1], 3)); heli.add(new THREE.Points(g, heliLightMat));
}
// A flight is a straight line across the view, behind the office; heights are sampled every SKY_STEP metres.
const SKY_STEP = 12, heliFlight = { on: false, wait: rand(20, 60), t: 0, len: 0, speed: 16, ox: 0, oz: 0, dx: 0, dz: 0, alt: new Float32Array(64) };
const skyCamDir = new THREE.Vector3(), skyProbe = new THREE.Vector3();
let skyT = 0;
function planHeliFlight() {
  const F = heliFlight, n = 51, half = (n - 1) * SKY_STEP / 2;
  camera.getWorldDirection(skyCamDir); const fl = Math.hypot(skyCamDir.x, skyCamDir.z) || 1, fx = skyCamDir.x / fl, fz = skyCamDir.z / fl;
  for (let tries = 0; tries < 16; tries++) {
    const ahead = rand(40, 80), turn = rand(-.45, .45), side = Math.random() < .5 ? 1 : -1, c = Math.cos(turn), s = Math.sin(turn);
    const dx = (-fz * c - fx * s) * side, dz = (fx * c - fz * s) * side, ox = fx * ahead - dx * half, oz = fz * ahead - dz * half, cruise = rand(-30, -14);
    for (let i = 0; i < n; i++) F.alt[i] = Math.max(cruise, roofNear(ox + dx * i * SKY_STEP, oz + dz * i * SKY_STEP) + 14);
    // climb before a tower and come down after it, never steeper than 1 in 2
    for (let i = 1; i < n; i++) F.alt[i] = Math.max(F.alt[i], F.alt[i - 1] - SKY_STEP / 2);
    for (let i = n - 2; i >= 0; i--) F.alt[i] = Math.max(F.alt[i], F.alt[i + 1] - SKY_STEP / 2);
    // keep only a crossing that passes through the picture, whatever way the camera looks
    skyProbe.set(ox + dx * half, F.alt[(n - 1) / 2] + city.position.y, oz + dz * half).project(camera);
    if (skyProbe.z > 1 || Math.abs(skyProbe.x) > .8 || skyProbe.y > .8 || skyProbe.y < -.6) continue;
    Object.assign(F, { on: true, t: 0, len: (n - 1) * SKY_STEP, ox, oz, dx, dz });
    heli.rotation.y = Math.atan2(dx, dz); heli.visible = true; return true;
  }
  return false;
}
function updateSkyLife(dt) {
  if (reduced) return;
  skyT += dt; clouds.rotation.y += dt * .015;
  // obstruction lights fade in and out together, about once every 1.6 s
  const k = .2 + .8 * Math.max(0, Math.sin(skyT * Math.PI * 2 / 1.6)) ** 2;
  beaconMat.color.copy(beaconBase).multiplyScalar(k); beaconDotMat.color.copy(beaconBase).multiplyScalar(k);
  const F = heliFlight;
  if (!F.on) { if ((F.wait -= dt) <= 0 && !planHeliFlight()) F.wait = rand(20, 40); return; }
  F.t += dt * F.speed;
  if (F.t >= F.len) { F.on = false; heli.visible = false; F.wait = rand(60, 150); return; }
  const f = F.t / SKY_STEP, i = Math.floor(f), rise = F.alt[i + 1] - F.alt[i];
  heli.position.set(F.ox + F.dx * F.t, F.alt[i] + rise * (f - i) + Math.sin(skyT * 1.3) * .3, F.oz + F.dz * F.t);
  heli.rotation.x = .1 - rise / SKY_STEP * .4;                       // nose down to cruise, up to climb
  heliRotor.rotation.y += dt * 40; heliLightMat.color.setScalar(.35 + .65 * (Math.sin(skyT * 7) > .6));
}
function tintSkyLife(T) {
  cloudMat.color.set(mix(mix('#FFFFFF', T.skyMid, .3), '#3B4766', T.cityDark)); cloudMat.opacity = T.dark ? .5 : .9;
  beaconBase.set(T.dark ? '#FF3B30' : '#C8453C'); beaconMat.color.copy(beaconBase); beaconDotMat.color.copy(beaconBase);
  beaconDotMat.visible = T.cityLit > 0;                              // no draw call by day
}
// After each city is built: map its roofs, light the tall ones and send any helicopter home.
function refreshSkyLife(id) {
  mapRoofs(); if (id !== 'generic') lightTallRoofs();
  heliFlight.on = false; heli.visible = false; heliFlight.wait = rand(15, 40);
}
refreshSkyLife('generic');

// floor grid
const gridMat = new THREE.LineBasicMaterial({ color:'#888', transparent:true, opacity:.22 });
const grid = (() => { const pts = []; for (let x = -14; x <= 14; x++) pts.push(x, .014, -9, x, .014, 9); for (let z = -9; z <= 9; z++) pts.push(-14, .014, z, 14, .014, z);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const l = new THREE.LineSegments(g, gridMat); l.visible = false; scene.add(l); return l; })();
