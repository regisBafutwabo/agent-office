/* ---------- furniture builders ---------- */
const lamps = [];
function pendant(x, z, y = 2.45, big = false, light = false) {
  const g = grp(x, z); const r = big ? .34 : .24;
  cyl(.008, .008, 3.4 - y, mats.black, 0, y + (3.4 - y) / 2 + .1, 0, g, 6);
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(.05, r, r * 1.1, 24, 1, true), mats.black); shade.position.y = y; g.add(shade);
  const b = new THREE.Mesh(new THREE.SphereGeometry(r * .45, 14, 10), mats.bulb); b.position.y = y - r * .35; g.add(b);
  if (light) { const L = new THREE.PointLight('#FFD9A0', .3, 10, 1.6); L.position.set(x, y - .4, z); scene.add(L); lamps.push(L); }
  slot('pendant', g);
}
function plantBig(x, z, s = 1, parent = scene) {
  const g = grp(x, z, rand(0, 6), parent); g.scale.setScalar(s);
  cyl(.3, .24, .55, mats.pot, 0, .275, 0, g);
  cyl(.03, .04, 1.1, mats.oak, 0, 1.0, 0, g, 6);
  for (let k = 0; k < 9; k++) { const a = k * 2.4, h = .9 + k * .12, r = .25 + (k % 3) * .08;
    const l = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(.2, .32), 0), k % 2 ? mats.leaf : mats.leaf3);
    l.position.set(Math.cos(a) * r, h, Math.sin(a) * r); l.scale.y = .7; l.castShadow = true; g.add(l); }
  slot('plantBig', g);
  if (parent === scene) block(x, z, .6 * s, .6 * s, .2);
}
function plantBush(x, z, s = 1, parent = scene) {
  const g = grp(x, z, 0, parent); g.scale.setScalar(s);
  cyl(.24, .2, .42, mats.pot2, 0, .21, 0, g);
  [[0, .66, 0, .34], [.16, .82, .06, .24], [-.14, .78, -.08, .26]].forEach(([a, b, c, r], i) => { const l = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), i % 2 ? mats.leaf2 : mats.leaf); l.position.set(a, b, c); l.castShadow = true; g.add(l); });
  slot('plantBush', g);
  if (parent === scene) block(x, z, .5 * s, .5 * s, .2);
}
function snakePlant(x, y, z, parent = scene) {
  const g = grp(x, z, 0, parent); g.position.y = y; cyl(.09, .07, .16, mats.pot, 0, .08, 0, g, 12);
  for (let k = 0; k < 5; k++) { const l = box(.04, rand(.22, .36), .015, k % 2 ? mats.leaf3 : mats.leaf, rand(-.05, .05), .3, rand(-.04, .04), g); l.rotation.z = rand(-.25, .25); l.rotation.y = rand(0, 3); }
}
// Swivel chairs' armrests: how far out each one is, its top's height, and where along it a resting hand goes.
const ARMREST = { x: .42, y: .71, z: .1 };
function taskChair(x, z, f, mat) {
  const g = grp(x, z, yawOf(f));
  for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; const s = box(.04, .03, .28, mats.black, Math.sin(a) * .12, .05, Math.cos(a) * .12, g); s.rotation.y = a; }
  cyl(.025, .025, .34, mats.black, 0, .24, 0, g, 8);
  box(.5, .08, .48, mat, 0, .46, 0, g); box(.48, .55, .06, mat, 0, .82, -.3, g);
  box(.04, .3, .04, mats.black, 0, .6, -.27, g);
  [-1, 1].forEach(s => { box(.035, .2, .035, mats.black, s * ARMREST.x, .59, -.08, g); box(.07, .035, .36, mats.black, s * ARMREST.x, ARMREST.y - .018, .02, g); });   // armrests
  return slot('taskChair', g);
}
function workbench(cx, cz, seatXs, homeChairs) {
  const g = grp(cx, cz);
  box(8.8, .05, 1.5, mats.white, 0, .745, 0, g);
  [-4.25, 0, 4.25].forEach(x => { [-.62, .62].forEach(z => box(.05, .72, .05, mats.black, x, .36, z, g)); box(.05, .05, 1.24, mats.black, x, .1, 0, g); });
  box(8.3, .26, .3, mats.oak, 0, .9, 0, g);
  for (let x = -3.9; x <= 3.9; x += .42) { const l = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(.1, .16), 0), Math.random() > .5 ? mats.leaf : mats.leaf2); l.position.set(x + rand(-.08, .08), 1.08, rand(-.05, .05)); l.castShadow = true; g.add(l); }
  block(cx, cz, 8.8, 1.5);
  const seats = [];
  [[0, 1], [0, -1]].forEach(f => seatXs.forEach(sx => {
    const x = cx + sx, z = cz - f[1] * 1.05;
    const mon = grp(x + f[0] * .85, z + f[1] * .85, yawOf([-f[0], -f[1]]));
    box(.2, .02, .14, mats.black, 0, .77, 0, mon); box(.04, .3, .04, mats.black, 0, .92, -.02, mon);
    box(.72, .43, .03, mats.bezel, 0, 1.12, 0, mon);
    const screen = new THREE.MeshBasicMaterial({ color:'#1E262B' });
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(.66, .37), screen); sp.position.set(0, 1.12, .017); mon.add(sp);
    box(.44, .02, .14, mats.bezel, x + f[0] * .45, .78, z + f[1] * .45);
    if (Math.random() > .5) {   // a mug: round, with a handle
      cyl(.045, .04, .1, mats.mug, x + .45, .84, z + f[1] * .5, scene, 14);
      part(new THREE.TorusGeometry(.028, .009, 6, 12), mats.mug, scene, x + .5, .845, z + f[1] * .5);   // the handle stands on its side
    }
    const chairMat = M('#3a4146', { roughness:.8 });
    const s = spot('desk', x, z, f, { screen, y: .16, chairMat, laptop: false, table: { y: .77, d: .3 }, keys: { y: .79, d: .45 } });
    s.chair = taskChair(x, z, f, chairMat); seats.push(s);
  }));
  return seats;
}
function sofa(cx, cz, len, f, backH = .42) {
  const g = grp(cx, cz, yawOf(f)); const n = Math.max(1, Math.round(len / 1.15)), w = len / n;
  box(len, .26, .95, mats.fabric, 0, .2, 0, g);
  for (let k = 0; k < n; k++) { const x = -len / 2 + w * (k + .5);
    box(w - .05, .14, .76, mats.fabric, x, .4, .07, g);
    box(w - .05, backH, .2, mats.fabric, x, .47 + backH / 2, -.36, g); }
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => box(.04, .08, .04, mats.black, a * (len / 2 - .08), .04, b * .4, g));
  return slot('sofa', g);
}
function armchair(x, z, f) {
  const g = grp(x, z, yawOf(f));
  box(.78, .12, .74, mats.leather, 0, .38, .02, g);
  const back = box(.78, .72, .12, mats.leather, 0, .72, -.34, g); back.rotation.x = -.22;
  [-.42, .42].forEach(ax => box(.08, .2, .68, mats.leather, ax, .52, 0, g));
  box(.84, .05, .78, mats.black, 0, .3, 0, g);
  [[-.35, -.3], [.35, -.3], [-.35, .3], [.35, .3]].forEach(([a, b]) => box(.04, .28, .04, mats.black, a, .14, b, g));
  slot('armchair', g);
  block(x, z, .9, .9, .15);
}
// squashed sphere: flat base, dipped seat at the front, slumped backrest behind, soft wrinkles
function beanbagGeo() {
  const g = new THREE.SphereGeometry(.56, 48, 32), p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i); let { x, y, z } = v;
    y *= .62;
    if (y < -.12) y = -.12 + (y + .12) * .25;
    const back = clamp(-z / .56, 0, 1);
    if (y > 0) y *= .42 + back * 1.15;
    if (y < .05) { x *= 1.1; z *= 1.1; }
    const w = Math.sin(v.x * 17 + v.y * 5) * Math.sin(v.z * 13) * .014;
    p.setXYZ(i, x * (1 + w), y + w, z * (1 + w));
  }
  g.computeVertexNormals(); return g;
}
function stoolHigh(x, z) { const g = grp(x, z); cyl(.2, .2, .06, mats.oak, 0, .74, 0, g); [0, 1, 2, 3].forEach(k => { const a = k * Math.PI / 2 + .78; const l = cyl(.016, .016, .74, mats.black, Math.cos(a) * .13, .37, Math.sin(a) * .13, g, 6); }); cyl(.14, .14, .015, mats.black, 0, .3, 0, g); slot('stoolHigh', g); }
function booth(cx, cz, felt) {
  const g = grp(cx, cz);
  box(1.45, 2.3, .08, felt, 0, 1.15, -.66, g);
  [-.685, .685].forEach(x => box(.08, 2.3, 1.4, felt, x, 1.15, 0, g));
  box(1.45, .08, 1.4, felt, 0, 2.3, 0, g);
  const gl = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.2, .025), mats.glass); gl.position.set(0, 1.12, .69); g.add(gl);
  box(1.45, .05, .05, mats.black, 0, 2.24, .69, g); box(.05, 2.2, .05, mats.black, .3, 1.12, .7, g);
  box(1.25, .04, .42, mats.oak, 0, .76, -.42, g);
  cyl(.17, .17, .05, mats.oak, 0, .47, .05, g); cyl(.03, .03, .44, mats.black, 0, .22, .05, g, 8);
  const lp = cyl(.06, .09, .1, mats.brass, .45, 1.45, -.52, g, 12); const bl = new THREE.Mesh(new THREE.SphereGeometry(.05, 10, 8), mats.bulb); bl.position.set(.45, 1.38, -.52); g.add(bl);
  block(cx, cz, 1.45, 1.4, .2);
  spot('booth', cx, cz + .05, [0, -1], { y: .18, laptop: true, table: { y: .78, d: .26 } });
}

/* ---------- zone: workbenches ---------- */
const benchX = [-10.3, -8.1, -5.9, -3.7].map(x => x + 7);
const deskSeats = [...workbench(-7, -2.6, benchX), ...workbench(-7, 2.2, benchX)];
const deskShelves = deskSeats.map(s => grp(s.x, s.z));             // what each desk remembers (see drawDesks); the meshes are shared across floors
let deskDirty = true;
function linearLamp(x, z, len, light) {
  const g = grp(x, z);
  [-len / 2 + .3, len / 2 - .3].forEach(dx => cyl(.006, .006, .9, mats.black, dx, 2.95, 0, g, 4));
  box(len, .06, .13, mats.black, 0, 2.48, 0, g); box(len - .06, .012, .09, mats.bulb, 0, 2.445, 0, g, false);
  if (light) { const L = new THREE.PointLight('#FFE2B8', .3, 11, 1.5); L.position.set(x, 2.2, z); scene.add(L); lamps.push(L); }
}
[-2.6, 2.2].forEach(z => { linearLamp(-9.2, z, 3.6, true); linearLamp(-4.8, z, 3.6, false); });
plantBig(-13.1, -0.2, 1.1); plantBig(-13.1, 4.6, .95); plantBush(-13.1, -2.4, .9);

/* ---------- zone: library ---------- */
// low shelving so the skyline stays visible above it
{ const g = grp(-8.35, -8.6);
  for (let u = 0; u < 5; u++) { const ux = -4.12 + u * 2.06;
    [-1.01, 1.01].forEach(dx => box(.05, 1.36, .45, mats.oak, ux + dx, .68, 0, g));
    box(2.06, 1.36, .03, mats.oak, ux, .68, -.21, g, false);
    for (let s = 0; s < 3; s++) { const y = .06 + s * .64; box(2.0, .04, .44, mats.oak, ux, y, 0, g);
      if (s === 2) { snakePlant(ux - .5, y + .02, 0, g); cyl(.1, .08, .26, mats.pot2, ux + .1, y + .15, 0, g, 12);
        for (let k = 0; k < 3; k++) box(.3, .05, .22, pick(BOOKS), ux + .6, y + .045 + k * .05, 0, g); continue; }
      let x = ux - .95; const end = ux + (Math.random() > .6 ? .25 : .92);
      while (x < end) { const w = rand(.06, .13), h = rand(.3, .48); const bk = box(w, h, .3, pick(BOOKS), x + w / 2, y + .02 + h / 2, .02, g); if (Math.random() < .08) bk.rotation.z = .25; x += w + .01; }
    } }
  block(-8.35, -8.6, 10.3, .5, .2);
  [-12.4, -10.3, -8.2, -6.1, -4.0].forEach(x => spot('library', x, -7.85, [0, -1]));
}

/* ---------- zone: war room ---------- */
// Two screens, sharp enough to read once the camera is up close: the floor's review board and its latest reported edit.
const term = canvasTex(2048, 768), board = canvasTex(1536, 560);
let screensDirty = true;
{ const gh = 2.6;
  const glassWall = (x, z, len, alongX) => {
    const gl = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : .03, gh, alongX ? .03 : len), mats.glass); gl.position.set(x, gh / 2, z); scene.add(gl);
    box(alongX ? len : .06, .06, alongX ? .06 : len, mats.black, x, gh, z); box(alongX ? len : .06, .04, alongX ? .06 : len, mats.black, x, .02, z);
    const n = Math.round(len / 1.1); for (let k = 0; k <= n; k++) { const t = -len / 2 + k * len / n; box(.05, gh, .05, mats.black, alongX ? x + t : x, gh / 2, alongX ? z : z + t); }
    block(x, z, alongX ? len : .06, alongX ? .06 : len, .22);
  };
  glassWall(1.05, -4.6, 5.7, true); glassWall(-1.8, -6.8, 4.4, false); glassWall(5.2, -6.8, 4.4, false);
  const MEETING_TABLE = { y: .79, d: .35 };
  box(3.4, .06, 1.2, mats.oak, 1.4, .76, -6.9); [[-1.4, 0], [1.4, 0]].forEach(([dx]) => { box(.08, .72, .9, mats.black, 1.4 + dx, .37, -6.9); });
  block(1.4, -6.9, 3.4, 1.2);
  [.3, 1.4, 2.5].forEach(x => { const a = spot('meeting', x, -7.85, [0, 1], { y: .16, table: MEETING_TABLE }); a.chair = taskChair(x, -7.85, [0, 1], mats.chair);
    const b = spot('meeting', x, -5.95, [0, -1], { y: .16, table: MEETING_TABLE }); b.chair = taskChair(x, -5.95, [0, -1], mats.chair); });
  plantBush(-1.25, -5.2, .7);
  // freestanding displays in front of the glass
  const st = grp(.8, -8.55); [-1.75, 1.75].forEach(x => { box(.06, 2.3, .06, mats.black, x, 1.15, 0, st); box(.5, .04, .5, mats.black, x, .02, 0, st); });
  box(3.6, 1.4, .06, mats.bezel, 0, 1.6, 0, st);
  const ts = new THREE.Mesh(new THREE.PlaneGeometry(3.46, 1.3), new THREE.MeshBasicMaterial({ map: term.t })); ts.position.set(0, 1.6, .035); st.add(ts); term.mesh = ts;
  const sb = grp(3.95, -8.55); [-.95, .95].forEach(x => { box(.05, 2.0, .05, mats.black, x, 1.0, 0, sb); box(.4, .04, .4, mats.black, x, .02, 0, sb); });
  box(1.96, .76, .05, mats.steel, 0, 1.6, 0, sb);
  const bs = new THREE.Mesh(new THREE.PlaneGeometry(1.86, .68), new THREE.MeshBasicMaterial({ map: board.t })); bs.position.set(0, 1.6, .03); sb.add(bs); board.mesh = bs;
}

/* ---------- zone: café ---------- */
const neon = canvasTex(512, 128);
{ const kf = box(7.7, .012, 5.3, mats.tile, 9.85, .006, -6.35, scene, false); kf.castShadow = false;
  box(5.8, .88, .66, mats.cabinet, 9.3, .44, -8.62); box(5.9, .05, .7, mats.marble, 9.3, .905, -8.6);
  [9.9, 10.5, 11.1].forEach((x, k) => cyl(.06, .06, rand(.16, .26), k % 2 ? mats.mug : mats.pot2, x, 1.03, -8.62, scene, 10));
  snakePlant(11.7, .93, -8.6);
  const em = grp(7.2, -8.6); box(.55, .5, .45, mats.steel, 0, 1.18, 0, em); box(.55, .06, .45, mats.black, 0, 1.46, 0, em); cyl(.03, .03, .1, mats.black, -.1, 1.0, .18, em, 8); cyl(.03, .03, .1, mats.black, .1, 1.0, .18, em, 8);
  box(.1, .12, .1, mats.mug, 8.1, .99, -8.5); box(.1, .12, .1, mats.mug, 8.3, .99, -8.45);
  box(1.0, 2.1, .72, mats.steel, 12.85, 1.05, -8.55); box(.03, .9, .03, mats.black, 12.42, 1.25, -8.18);
  block(9.3, -8.6, 5.9, .7, .2); block(12.85, -8.55, 1.0, .75, .2);
  box(3.8, .92, 1.0, mats.cabinet, 9.6, .46, -5.4); box(3.95, .06, 1.2, mats.marble, 9.6, .95, -5.4);
  block(9.6, -5.4, 3.95, 1.2);
  [8.3, 9.6, 10.9].forEach(x => { stoolHigh(x, -4.5); spot('stool', x, -4.5, [0, -1], { y: .46, laptop: true, table: { y: .98, d: .3 } }); pendant(x, -5.4, 2.3, false, x === 9.6); });
  [7.6, 8.9].forEach(x => spot('coffee', x, -7.75, [0, -1]));
  // two back-to-back faces so the sign reads correctly from either side
  [0, Math.PI].forEach(r => { const nm = new THREE.Mesh(new THREE.PlaneGeometry(2.8, .7), new THREE.MeshBasicMaterial({ map: neon.t, transparent: true })); nm.position.set(9.6, 2.75, -5.4); nm.rotation.y = r; scene.add(nm); });
  [-1.2, 1.2].forEach(dx => cyl(.005, .005, .4, mats.black, 9.6 + dx, 3.25, -5.4, scene, 4));
  plantBig(6.3, -8.3, .9);
}
function drawNeon() {
  const x = neon.x; x.clearRect(0, 0, 512, 128); x.textAlign = 'center'; x.font = '700 76px "Bricolage Grotesque", sans-serif';
  x.shadowColor = '#FF7A59'; x.shadowBlur = sceneT.dark ? 26 : 10; x.fillStyle = sceneT.dark ? '#FFD2C2' : '#E4573A';
  x.fillText('agent office', 256, 90); x.fillText('agent office', 256, 90); neon.t.needsUpdate = true;
}

/* ---------- zone: lifts ---------- */
// a hollow lift car against the glass; doors slide open when someone is close
const lift = { open: 0 };
{ const X = 13.2, Z = -1.8;
  box(.1, 3.4, 2.4, mats.cabinet, 14.0, 1.7, Z);                                   // back
  [-1.15, 1.15].forEach(dz => box(1.6, 3.4, .1, mats.cabinet, X, 1.7, Z + dz));     // sides
  box(1.6, .1, 2.4, mats.cabinet, X, 3.35, Z);                                     // top
  box(.1, 3.4, .65, mats.cabinet, 12.4, 1.7, Z - .875); box(.1, 3.4, .65, mats.cabinet, 12.4, 1.7, Z + .875);  // front, either side of the opening
  box(.1, 1.1, 1.1, mats.cabinet, 12.4, 2.85, Z);                                  // lintel
  box(.04, 2.34, .06, mats.steel, 12.34, 1.17, Z - .56); box(.04, 2.34, .06, mats.steel, 12.34, 1.17, Z + .56); box(.04, .06, 1.18, mats.steel, 12.34, 2.33, Z);
  lift.l = box(.04, 2.3, .56, mats.steel, 12.5, 1.15, Z - .275); lift.r = box(.04, 2.3, .56, mats.steel, 12.5, 1.15, Z + .275);
  lift.lamp = new THREE.MeshBasicMaterial({ color:'#2A3238' });
  const lp = new THREE.Mesh(new THREE.PlaneGeometry(.3, .08), lift.lamp); lp.position.set(12.34, 2.55, Z); lp.rotation.y = -Math.PI / 2; scene.add(lp);
  const inner = new THREE.PointLight('#FFF1D6', .5, 3, 2); inner.position.set(13.3, 2.8, Z); scene.add(inner);
  block(X, Z, 1.6, 2.4, .2);
  const mat = box(1.4, .015, 1.8, mats.rug2, 11.7, .008, Z, scene, false); mat.castShadow = false;
  plantBig(13.25, -3.6, .9); plantBush(13.3, -0.1, .85); }

/* ---------- zone: focus booths ---------- */
booth(0.1, 2.4, mats.felt1); booth(1.75, 2.4, mats.felt2);

/* ---------- zone: lounge ---------- */
{ const rg = box(8.2, .015, 6.2, mats.rug, 9.3, .008, 5.3, scene, false); rg.castShadow = false;
  sofa(12.95, 5.2, 5.2, [-1, 0]); block(12.95, 5.2, .95, 5.2, .15);
  sofa(11.78, 8.3, 3.3, [0, -1], .34); block(11.78, 8.3, 3.3, .95, .15);
  const cushion = { y: .47, x: -.55 };   // a cup goes on the cushion beside the hip
  [3.3, 4.5, 5.7, 6.9].forEach(z => spot('sofa', 12.8, z, [-1, 0], { y: .2, from: 'front', laptop: true, rest: cushion }));
  [10.6, 11.7].forEach(x => spot('sofa', x, 8.15, [0, -1], { y: .2, from: 'front', laptop: true, rest: cushion }));
  // cushions
  [[13.2, 3.0, '#E9D8BE'], [13.2, 7.3, '#3E5C6B']].forEach(([x, z, c]) => { const p = box(.16, .34, .34, M(c, { roughness: 1 }), x, .62, z); p.rotation.z = -.15; });
  // coffee table
  cyl(.72, .72, .05, mats.oak, 10.4, .42, 5.2, scene, 40); cyl(.05, .05, .4, mats.black, 10.4, .2, 5.2, scene, 8); cyl(.3, .3, .03, mats.black, 10.4, .02, 5.2, scene, 20);
  box(.36, .06, .26, mats.bookB, 10.2, .48, 5.0); box(.32, .05, .22, mats.bookG, 10.22, .53, 5.02); snakePlant(10.75, .445, 5.4);
  block(10.4, 5.2, 1.44, 1.44, .15);
  armchair(7.6, 3.9, [1, 0]); armchair(7.6, 6.4, [1, 0]);
  const armrest = { y: .62, x: -.42 };   // a cup goes on the left armrest
  spot('armchair', 7.62, 3.9, [1, 0], { y: .2, from: 'front', laptop: true, rest: armrest }); spot('armchair', 7.62, 6.4, [1, 0], { y: .2, from: 'front', laptop: true, rest: armrest });
  cyl(.25, .25, .5, mats.oak, 7.6, .25, 5.15, scene, 20); block(7.6, 5.15, .5, .5, .12);
  [[9.7, 3.0], [11.1, 3.0]].forEach(([x, z]) => { cyl(.32, .32, .4, mats.fabric2, x, .2, z, scene, 24); spot('pouf', x, z, [0, 1], { y: .1 }); block(x, z, .5, .5, .1); });
  // arc lamp
  { cyl(.22, .22, .05, mats.black, 13.35, .03, 1.7, scene, 20);
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(13.35, .05, 1.7), new THREE.Vector3(13.2, 4.2, 2.6), new THREE.Vector3(11.1, 2.35, 4.6));
    const arc = new THREE.Mesh(new THREE.TubeGeometry(curve, 30, .022, 6, false), mats.brass); arc.castShadow = true; scene.add(arc);
    const sh = new THREE.Mesh(new THREE.SphereGeometry(.3, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), mats.brass); sh.material.side = THREE.DoubleSide; sh.position.set(11.1, 2.25, 4.6); scene.add(sh);
    const b = new THREE.Mesh(new THREE.SphereGeometry(.1, 10, 8), mats.bulb); b.position.set(11.1, 2.18, 4.6); scene.add(b);
    const L = new THREE.PointLight('#FFD9A0', .3, 8, 1.6); L.position.set(11.1, 2.0, 4.6); scene.add(L); lamps.push(L); block(13.35, 1.7, .4, .4, .1); }
  // room divider shelf
  { const g = grp(4.3, 6.4); [-2.2, -1.1, 0, 1.1, 2.2].forEach(z => box(.4, 1.4, .04, mats.oak, 0, .7, z, g)); [.02, .7, 1.4].forEach(y => box(.4, .04, 4.44, mats.oak, 0, y, 0, g));
    [-1.65, .55].forEach(z => snakePlant(0, 1.42, z, g)); [-.55, 1.65].forEach(z => { for (let k = 0; k < 5; k++) box(.26, rand(.3, .5), .07, pick(BOOKS), 0, .9, z - .2 + k * .09, g); });
    box(.3, .3, .3, mats.pot2, 0, .87, -1.65, g); block(4.3, 6.4, .4, 4.44, .2); }
  plantBig(6.2, 8.2, 1.15); plantBig(13.2, 0.9, .8); plantBush(8.8, 8.3, .8);
}

/* ---------- zone: hot desk ---------- */
const HIGH_TABLE = { y: 1.045, d: .425 };   // top height, and how far the near edge is from a stool
{ box(3.0, .05, .95, mats.oak, 0.9, 1.02, 6.4); [-1.35, 1.35].forEach(dx => { box(.06, 1.0, .8, mats.black, .9 + dx, .5, 6.4); });
  block(.9, 6.4, 3.0, .95);
  [.2, 1.6].forEach(x => { stoolHigh(x, 5.5); spot('hightable', x, 5.5, [0, 1], { y: .46, laptop: true, table: HIGH_TABLE }); stoolHigh(x, 7.3); spot('hightable', x, 7.3, [0, -1], { y: .46, laptop: true, table: HIGH_TABLE }); });
  [.3, 1.5].forEach(x => pendant(x, 6.4, 2.4, true, x === .3));
  plantBush(-1.2, 8.2, .9); plantBush(3.0, 8.3, .8); }

/* ---------- zone: game corner ---------- */
// Arcade basketball machines: an agent on a break steps up and shoots on its own.
const HOOP_PERIOD = 1.9;                       // seconds per shot
const hoops = [];
const hoopMats = { ball: M('#E8742A', { roughness: .6 }), rim: M('#E4572E', { roughness: .4, metalness: .3 }), board: M('#F7F7F5', { roughness: .3 }),
  net: new THREE.MeshBasicMaterial({ color: '#F4F4F2', wireframe: true, transparent: true, opacity: .85 }),
  cage: new THREE.MeshBasicMaterial({ color: '#2B3035', wireframe: true, transparent: true, opacity: .35 }) };
const rampY = z => 1.125 - (z + .1) * .0998;   // height of a ball resting on the sloped ramp at local z
function hoopMachine(x, z, body) {
  const g = grp(x, z, yawOf([1, 0]));          // local +z points into the room, where the player stands
  box(1.2, .9, 2.3, body, 0, .45, -.1, g);
  const ramp = box(1.08, .05, 2.2, mats.black, 0, .98, -.1, g); ramp.rotation.x = .1;   // slopes down so balls roll back
  [-.58, .58].forEach(sx => { box(.04, .22, 2.2, body, sx, 1.1, -.1, g);
    const cage = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 1.25, 10, 6), hoopMats.cage); cage.position.set(sx, 1.8, -.15); cage.rotation.y = Math.PI / 2; g.add(cage); });
  [-.52, .52].forEach(sx => box(.07, 2.35, .07, mats.black, sx, 2.2, -1.2, g));
  box(1.1, .78, .04, hoopMats.board, 0, 2.45, -1.16, g);
  [[0, 2.44, .36, .025], [0, 2.16, .36, .025]].forEach(([bx, by, w, h]) => box(w, h, .01, hoopMats.rim, bx, by, -1.135, g, false));
  [-.17, .17].forEach(bx => box(.025, .3, .01, hoopMats.rim, bx, 2.3, -1.135, g, false));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(.19, .016, 8, 28), hoopMats.rim); rim.position.set(0, 2.12, -.88); rim.rotation.x = Math.PI / 2; g.add(rim);
  box(.05, .03, .12, hoopMats.rim, 0, 2.12, -1.1, g);
  const net = new THREE.Mesh(new THREE.CylinderGeometry(.19, .12, .3, 12, 3, true), hoopMats.net); net.position.set(0, 1.96, -.88); g.add(net);
  box(1.2, .42, .08, mats.bezel, 0, 3.1, -1.2, g);
  const scoreTex = canvasTex(256, 96);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.08, .38), new THREE.MeshBasicMaterial({ map: scoreTex.t })); board.position.set(0, 3.1, -1.155); g.add(board);
  box(1.2, .22, .3, body, 0, 3.42, -1.12, g);
  box(1.2, .12, .12, mats.black, 0, 1.08, 1.06, g);
  [-.32, .32].forEach(bx => { const b = new THREE.Mesh(new THREE.SphereGeometry(.12, 16, 12), hoopMats.ball); b.position.set(bx, rampY(.8), .8); b.castShadow = true; g.add(b); });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(.12, 16, 12), hoopMats.ball); ball.castShadow = true; ball.position.set(0, rampY(.85), .85); g.add(ball);
  block(x - .1, z, 2.3, 1.2, .15);
  hoops.push({ g, ball, net, scoreTex, t: 0, make: true, side: 1, swish: 0, player: null, floor: null });
  spot('hoops', x + 1.55, z, [-1, 0]);
}
hoopMachine(-12.0, 6.2, M('#C23B32', { roughness: .5 }));
hoopMachine(-12.0, 7.7, M('#2D5DA8', { roughness: .5 }));
{ const rg = box(3.0, .015, 2.8, mats.rug2, -6.7, .008, 7.1, scene, false); rg.castShadow = false;
  [[-7.4, 6.4, mats.beanA], [-6.0, 7.9, mats.beanB]].forEach(([x, z, m]) => { const b = new THREE.Mesh(beanbagGeo(), m); b.position.set(x, .175, z); b.rotation.y = yawOf([-1, 0]); b.castShadow = true; b.receiveShadow = true; scene.add(b); block(x, z, .95, .95, .05);
    spot('beanbag', x - .12, z, [-1, 0], { y: .14, from: 'front' }); });
  plantBig(-13.1, -6.7, 1.0); plantBush(-5.0, 8.4, .8);
}
// Arcade cabinet: turned a little toward the room so you can watch the screen while an agent on a break plays.
const ARCADE_FACE = [.8, .6];
const arcade = (() => {
  const x = -3.4, z = 7.9, g = grp(x, z, yawOf([-ARCADE_FACE[0], -ARCADE_FACE[1]]));   // local -z is the front
  box(.8, 1.8, .7, mats.cabinet, 0, .9, 0, g); box(.66, .5, .02, mats.bezel, 0, 1.35, -.36, g);
  box(.7, .08, .3, mats.black, 0, 1.02, -.42, g);
  const stick = cyl(.012, .012, .1, mats.black, -.16, 1.11, -.45, g, 6);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(.035, 10, 8), hoopMats.rim); knob.position.y = .06; stick.add(knob);
  [.06, .16, .26].forEach((bx, k) => cyl(.028, .028, .02, k === 1 ? hoopMats.ball : hoopMats.rim, bx, 1.07, -.44, g, 12));
  const tex = canvasTex(160, 120); tex.t.magFilter = THREE.NearestFilter;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(.6, .44), new THREE.MeshBasicMaterial({ map: tex.t })); screen.position.set(0, 1.35, -.372); screen.rotation.y = Math.PI; g.add(screen);
  block(x, z, .9, .9, .2);
  spot('arcade', x + ARCADE_FACE[0] * .85, z + ARCADE_FACE[1] * .85, [-ARCADE_FACE[0], -ARCADE_FACE[1]], { from: null });   // walk straight up: behind it is the window
  return { tex, stick, t: 0, frameT: 1, player: null, floor: null };
})();
// A little maze game: the hero chomps along a row of dots while a ghost gives chase; eat the power dot and the ghost runs.
// Nobody playing: the attract screen blinks INSERT COIN.
function drawArcade(m, p, scores) {
  const x = m.tex.x, W = 160, H = 120, t = m.t;
  x.fillStyle = '#05060D'; x.fillRect(0, 0, W, H);
  x.strokeStyle = '#3B4BFF'; x.lineWidth = 3; rrect(x, 6, 34, W - 12, 52, 8); x.stroke(); rrect(x, 14, 42, W - 28, 36, 5); x.stroke();
  x.font = '700 10px "IBM Plex Mono", monospace'; x.textAlign = 'left';
  if (!p) {
    x.fillStyle = '#FFD84A'; x.fillText('HI', 8, 14); x.fillStyle = '#FFFFFF'; x.fillText(String(m.best || 0).padStart(5, '0'), 26, 14);
    if (Math.floor(t * 1.6) % 2) { x.fillStyle = '#FF5D8F'; x.textAlign = 'center'; x.font = '700 13px "IBM Plex Mono", monospace'; x.fillText('INSERT COIN', W / 2, 106); }
    x.fillStyle = '#FFD84A'; x.beginPath(); const hx = 20 + ((t * 30) % (W - 40)); x.arc(hx, 60, 7, .5, Math.PI * 2 - .5); x.lineTo(hx, 60); x.fill();
    x.textAlign = 'left'; m.tex.t.needsUpdate = true; return;
  }
  const lap = 4, u = (t % lap) / lap, hx = 18 + u * (W - 36), dots = 9;
  const power = u > .55, ghostX = power ? hx + 30 - (u - .55) * 40 : hx - 26 - Math.sin(t * 3) * 3;
  for (let k = 0; k < dots; k++) { const dx = 22 + k * (W - 44) / (dots - 1); if (dx > hx) { x.fillStyle = '#FFE7B8'; x.beginPath(); x.arc(dx, 60, k === 5 ? 4 : 2, 0, 7); x.fill(); } }
  const mouth = .45 * Math.abs(Math.sin(t * 12));
  x.fillStyle = '#FFD84A'; x.beginPath(); x.arc(hx, 60, 7, mouth, Math.PI * 2 - mouth); x.lineTo(hx, 60); x.fill();
  x.fillStyle = power ? (Math.floor(t * 8) % 2 ? '#2B3BFF' : '#FFFFFF') : '#FF4F5E';
  x.beginPath(); x.arc(ghostX, 58, 7, Math.PI, 0); x.lineTo(ghostX + 7, 66); for (let k = 0; k < 3; k++) x.lineTo(ghostX + 7 - (k + .5) * 14 / 3, k % 2 ? 66 : 63); x.lineTo(ghostX - 7, 66); x.fill();
  x.fillStyle = '#FFFFFF'; x.fillRect(ghostX - 4, 56, 3, 3); x.fillRect(ghostX + 1, 56, 3, 3);
  const score = scores.arcade;
  x.fillStyle = '#FFFFFF'; x.fillText('1UP', 8, 14); x.fillText(String(score).padStart(5, '0'), 8, 26);
  x.fillStyle = '#FFD84A'; x.textAlign = 'right'; x.fillText(fitText(x, p.name.toUpperCase(), 84), W - 8, 14); x.fillStyle = '#8BE9F5'; x.fillText(`LV ${1 + Math.floor(t / (lap * 3))}`, W - 8, 26);
  x.textAlign = 'left'; m.tex.t.needsUpdate = true;
}
function updateArcade(dt) {
  const m = arcade, scores = curFloor.arcadeScores || (curFloor.arcadeScores = { arcade: 0 });
  const fs = curFloor.SPOTS.arcade[0];
  const p = agents.find(a => a.spot === fs && a.floor === curFloor && !a.path.length && !a.onRoof) || null;
  if (p !== m.player || m.floor !== curFloor) { if (p && p !== m.player) { scores.arcade = 0; m.t = 0; } m.player = p; m.floor = curFloor; m.frameT = 1; }
  const prev = m.t; m.t += dt * speed;
  if (p && Math.floor(m.t * 2) > Math.floor(prev * 2)) { scores.arcade += 10; m.best = Math.max(m.best || 0, scores.arcade); }
  m.stick.rotation.z = p ? Math.sin(m.t * 7) * .35 : 0; m.stick.rotation.x = p ? Math.cos(m.t * 5) * .2 : 0;
  m.frameT += dt; if (m.frameT > 1 / 12) { m.frameT = 0; drawArcade(m, p, scores); }   // 12 fps reads as retro and costs little
}
function drawScore(m, score, name) {
  const x = m.scoreTex.x; x.fillStyle = '#0B0D0F'; x.fillRect(0, 0, 256, 96);
  x.fillStyle = '#FF3B30'; x.font = '700 18px "IBM Plex Mono", monospace'; x.fillText('SCORE', 14, 28);
  x.font = '700 60px "IBM Plex Mono", monospace'; x.textAlign = 'right'; x.fillText(String(score).padStart(2, '0'), 244, 78); x.textAlign = 'left';
  x.fillStyle = '#FFB199'; x.font = '500 17px "IBM Plex Sans", sans-serif'; x.fillText(fitText(x, name || 'insert agent', 128), 14, 80);
  m.scoreTex.t.needsUpdate = true;
}
// One shot every HOOP_PERIOD: pick up, raise, shoot in an arc, swish (or clang off the rim), roll back down the ramp.
function updateHoops(dt) {
  const scores = curFloor.hoopScores || (curFloor.hoopScores = hoops.map(() => 0));
  hoops.forEach((m, i) => {
    const fs = curFloor.SPOTS.hoops[i];
    const p = agents.find(a => a.spot === fs && a.floor === curFloor && !a.path.length && !a.onRoof);
    if (p !== m.player || m.floor !== curFloor) { if (p && p !== m.player) { scores[i] = 0; m.t = 0; } m.player = p; m.floor = curFloor; drawScore(m, scores[i], p && p.name); }
    const B = m.ball.position;
    if (!p) { B.set(0, rampY(.85), .85); m.net.scale.y = 1; return; }
    const prevU = (m.t % HOOP_PERIOD) / HOOP_PERIOD; m.t += dt * speed; const u = (m.t % HOOP_PERIOD) / HOOP_PERIOD;
    if (u < prevU) { m.make = Math.random() < .7; m.side = Math.random() < .5 ? -1 : 1; }
    p.shootU = u;
    const hoopY = 2.12, hoopZ = -.88;
    if (u < .12) { const k = u / .12; B.set(0, rampY(.9) + (1.45 - rampY(.9)) * k, .9 + .3 * k); }
    else if (u < .38) { const k = (u - .12) / .26; B.set(0, 1.45 + .32 * k, 1.2 - .05 * k); }
    else if (u < .68) { const k = (u - .38) / .3, y0 = 1.77, z0 = 1.15; B.set(0, y0 + (hoopY + .03 - y0) * k + 3 * k * (1 - k), z0 + (hoopZ - z0) * k); }
    else if (u < .8) { const k = (u - .68) / .12;
      if (m.make) B.set(0, hoopY - (hoopY - rampY(hoopZ)) * k, hoopZ);
      else { const zz = hoopZ + .35 * k; B.set(m.side * .28 * k, hoopY + .3 * Math.sin(Math.PI * k) - (hoopY - rampY(zz)) * k, zz); } }
    else { const k = (u - .8) / .2, sx = m.make ? 0 : m.side * .28, sz = m.make ? hoopZ : hoopZ + .35, zz = sz + (.9 - sz) * k; B.set(sx * (1 - k), rampY(zz), zz); }
    if (prevU < .68 && u >= .68 && m.make) { scores[i]++; drawScore(m, scores[i], p.name); m.swish = 1; }
    m.swish = Math.max(0, m.swish - dt * 3); m.net.scale.y = 1 + .4 * m.swish;
  });
}
