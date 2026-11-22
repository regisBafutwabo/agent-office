/* ---------- navigation grid (A*) ---------- */
const NAV = { x0:-14, z0:-9, cs:.25, W:112, H:72 };
const W = NAV.W, H = NAV.H;
const blockedInterior = new Uint8Array(W * H), blockedRoof = new Uint8Array(W * H);
let blocked = blockedInterior;             // grid the path finder currently uses
const ci = x => Math.floor((x - NAV.x0) / NAV.cs), cj = z => Math.floor((z - NAV.z0) / NAV.cs);
const wx = i => NAV.x0 + (i + .5) * NAV.cs, wz = j => NAV.z0 + (j + .5) * NAV.cs;
const isFree = (i, j) => i >= 0 && j >= 0 && i < W && j < H && !blocked[j * W + i];
function block(x, z, w, d, pad = .28) {
  for (let j = Math.max(0, cj(z - d / 2 - pad)); j <= Math.min(H - 1, cj(z + d / 2 + pad)); j++)
    for (let i = Math.max(0, ci(x - w / 2 - pad)); i <= Math.min(W - 1, ci(x + w / 2 + pad)); i++) {
      const X = wx(i), Z = wz(j);
      if (Math.abs(X - x) <= w / 2 + pad && Math.abs(Z - z) <= d / 2 + pad) blocked[j * W + i] = 1;
    }
}
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const X = wx(i), Z = wz(j); if (X < -13.6 || Z < -8.6 || X > 13.75 || Z > 8.8) blocked[j * W + i] = 1; }
function nearestFree(x, z) {
  const i0 = clamp(ci(x), 0, W - 1), j0 = clamp(cj(z), 0, H - 1);
  if (isFree(i0, j0)) return j0 * W + i0;
  for (let r = 1; r < 24; r++) { let best = -1, bd = 1e9;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r || !isFree(i0 + di, j0 + dj)) continue;
      const d = di * di + dj * dj; if (d < bd) { bd = d; best = (j0 + dj) * W + i0 + di; } }
    if (best >= 0) return best; }
  return j0 * W + i0;
}
const NB = [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.414],[1,-1,1.414],[-1,1,1.414],[-1,-1,1.414]];
function astar(s, g) {
  const N = W * H, gs = new Float32Array(N).fill(1e9), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const hi = [], hf = [];
  const push = (n, f) => { hi.push(n); hf.push(f); let k = hi.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (hf[p] <= hf[k]) break; [hi[p], hi[k]] = [hi[k], hi[p]]; [hf[p], hf[k]] = [hf[k], hf[p]]; k = p; } };
  const pop = () => { const top = hi[0], li = hi.pop(), lf = hf.pop();
    if (hi.length) { hi[0] = li; hf[0] = lf; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k;
      if (l < hi.length && hf[l] < hf[m]) m = l; if (r < hi.length && hf[r] < hf[m]) m = r; if (m === k) break;
      [hi[m], hi[k]] = [hi[k], hi[m]]; [hf[m], hf[k]] = [hf[k], hf[m]]; k = m; } }
    return top; };
  const gi = g % W, gj = (g / W) | 0;
  const h = n => { const dx = Math.abs(n % W - gi), dy = Math.abs(((n / W) | 0) - gj); return dx + dy - .586 * Math.min(dx, dy); };
  gs[s] = 0; push(s, h(s));
  while (hi.length) {
    const cur = pop(); if (cur === g) break; if (closed[cur]) continue; closed[cur] = 1;
    const i = cur % W, j = (cur / W) | 0;
    for (const [di, dj, c] of NB) {
      const ni = i + di, nj = j + dj; if (!isFree(ni, nj)) continue;
      if (di && dj && (!isFree(i + di, j) || !isFree(i, j + dj))) continue;
      const n = nj * W + ni, ng = gs[cur] + c; if (ng < gs[n]) { gs[n] = ng; came[n] = cur; push(n, ng + h(n)); }
    }
  }
  if (s !== g && came[g] < 0) return null;
  const out = [g]; let c = g; while (c !== s) { c = came[c]; out.push(c); } return out.reverse();
}
function los(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.ceil(d / (NAV.cs * .5));
  for (let k = 1; k < n; k++) { const t = k / n; if (!isFree(ci(a.x + (b.x - a.x) * t), cj(a.y + (b.y - a.y) * t))) return false; }
  return true;
}
function route(fx, fz, tx, tz) {
  const s = nearestFree(fx, fz), g = nearestFree(tx, tz), cells = astar(s, g);
  const V = (x, z) => new THREE.Vector2(x, z);
  if (!cells) return [V(tx, tz)];
  const pts = [V(fx, fz), ...cells.map(n => V(wx(n % W), wz((n / W) | 0))), V(tx, tz)];
  const out = []; let k = 0;
  while (k < pts.length - 1) { let m = pts.length - 1; while (m > k + 1 && !los(pts[k], pts[m])) m--; out.push(pts[m]); k = m; }
  return out;
}

/* ---------- spots (places agents can be) ---------- */
const SPOTS = {};
// A seat's `table` ({ y: top height, d: near edge ahead of the seat }) is where a laptop goes instead of the lap,
// and where a coffee is set down to type. A desk's `keys` ({ y: top, d: centre ahead of the seat }) is its keyboard.
// A seat's `rest` ({ y, x: to the left }) is a spot for the cup on the seat itself.
function spot(type, x, z, face, o = {}) { const s = Object.assign({ type, x, z, face, by: null, from: 'back', y: 0 }, o); (SPOTS[type] = SPOTS[type] || []).push(s); return s; }
function approach(s) {
  if (s.ax !== undefined) return { x: s.ax, z: s.az };
  if (s.from === 'front') return { x: s.x + s.face[0] * .8, z: s.z + s.face[1] * .8 };
  if (s.from === 'back') return { x: s.x - s.face[0] * .72, z: s.z - s.face[1] * .72 };
  return { x: s.x, z: s.z };
}
// inside the lift car; agents always leave and enter straight through the lift doors
const DOOR = { x: 13.3, z: -1.8, face: [-1, 0], from: null, ax: 11.6, az: -1.8 };
// Over the shoulder of whoever sits at a seat, looking at their screen: where a main agent stands to review a subagent's work.
// Seats can sit closer together than that (meeting chairs, sofas), so pick the spot farthest from any other seat.
function besideSpot(s) {
  const f = s.face || [0, 1], p = [-f[1], f[0]];
  const at = (k, back = .35) => ({ x: s.x - f[0] * back + k * p[0] * .8, z: s.z - f[1] * back + k * p[1] * .8 });
  const seats = Object.values(SPOTS).flat();
  const room = o => !isFree(ci(o.x), cj(o.z)) ? -1 : Math.min(9, ...seats.filter(t => t.x !== s.x || t.z !== s.z).map(t => Math.hypot(t.x - o.x, t.z - o.z)));
  let o = at(1), best = room(o);
  for (const q of [at(-1), at(.5), at(-.5), at(.5, .8), at(-.5, .8), at(0, 1)]) { if (best >= .8) break; const r = room(q); if (r > best) { o = q; best = r; } }
  const dx = s.x + f[0] * .85 - o.x, dz = s.z + f[1] * .85 - o.z, d = Math.hypot(dx, dz) || 1;
  return { x: o.x, z: o.z, face: [dx / d, dz / d], from: null, y: 0 };
}

/* ---------- textures ---------- */
function plankTexture() {
  const T = canvasTex(512, 512), x = T.x; x.fillStyle = '#f4f4f4'; x.fillRect(0, 0, 512, 512);
  for (let r = 0; r < 8; r++) { let px = -Math.random() * 300;
    while (px < 512) { const len = rand(170, 340), v = Math.floor(rand(226, 252));
      x.fillStyle = `rgb(${v},${v},${v})`; x.fillRect(px, r * 64, len, 64);
      x.strokeStyle = 'rgba(0,0,0,.05)'; x.lineWidth = 1;
      for (let g = 0; g < 4; g++) { const gy = r * 64 + rand(6, 58); x.beginPath(); x.moveTo(px, gy); x.bezierCurveTo(px + len * .3, gy + rand(-4, 4), px + len * .7, gy + rand(-4, 4), px + len, gy); x.stroke(); }
      x.fillStyle = 'rgba(0,0,0,.16)'; x.fillRect(px, r * 64, 2, 64); px += len; }
    x.fillStyle = 'rgba(0,0,0,.18)'; x.fillRect(0, r * 64, 512, 2); }
  T.t.wrapS = T.t.wrapT = THREE.RepeatWrapping; T.t.repeat.set(7, 4.5); return T.t;
}
mats.floor.map = plankTexture();

/* ---------- room shell ---------- */
// one storey of a tower: plank floor on a concrete slab
box(28.4, .2, 18.4, mats.floor, 0, -.1, 0, scene, false);
box(28.8, .9, 18.8, mats.slab, 0, -.65, 0, scene, false);
// floor-to-ceiling glass on the back and left sides, looking over the city
function curtainWall(x, z, len, alongX, glassMat = mats.window, frameMat = mats.black, parent = scene) {
  const Hh = 3.4;
  const gl = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : .03, Hh - .1, alongX ? .03 : len), glassMat); gl.position.set(x, Hh / 2, z); parent.add(gl);
  box(alongX ? len : .1, .08, alongX ? .1 : len, frameMat, x, .04, z, parent);
  box(alongX ? len : .14, .14, alongX ? .14 : len, frameMat, x, Hh, z, parent);
  const n = Math.max(1, Math.round(len / 1.8)); for (let k = 0; k <= n; k++) { const t = -len / 2 + k * len / n; box(.07, Hh, .07, frameMat, alongX ? x + t : x, Hh / 2, alongX ? z : z + t, parent); }
}
curtainWall(0, -9.1, 28.4, true); curtainWall(-14.1, 0, 18.4, false);

// exterior shell: front + right glass and a roof that fade in when you zoom out,
// so from far away it reads as a real building you can still see into
const building = new THREE.Group(); scene.add(building);      // every floor except the one you're on, plus the roof
const roofGroup = new THREE.Group(); building.add(roofGroup);
const shell = new THREE.Group(); scene.add(shell);
const fadeGlass = new THREE.MeshBasicMaterial({ color:'#DDEFF7', transparent:true, opacity:0, depthWrite:false });
const fadeFrame = M('#23272A', { roughness:.45, metalness:.3, transparent:true, opacity:0 });
const roofMat = M('#A9ABA6', { roughness:.9, transparent:true, opacity:0 });
const roofDark = M('#6E7479', { roughness:.6, metalness:.3, transparent:true, opacity:0 });
const shellMats = [fadeFrame, roofMat, roofDark];
curtainWall(0, 9.1, 28.4, true, fadeGlass, fadeFrame, shell);
curtainWall(14.1, 0, 18.4, false, fadeGlass, fadeFrame, shell);
// ---------- rooftop terrace: where idle agents from every floor hang out ----------
// It lives in roofGroup (on top of the highest floor) and has its own walkable grid.
const ROOF_Y = 3.9;                                            // deck height inside roofGroup
const ROOF_SPOTS = [], roofLights = [];
const PARTY = { group: new THREE.Group(), booth: new THREE.Group(), fade: [], tiles: [], beams: [], decks: [] };   // after-dark extras, filled in below
function roofSpot(type, x, z, face, o = {}) { const s = Object.assign({ type, x, z, face, by: null, from: 'back', y: 0, roof: true }, o); ROOF_SPOTS.push(s); return s; }
const ROOF_LIFT = { x: 13.1, z: -1.8, face: [-1, 0], from: null, ax: 11.6, az: -1.8, roof: true };
function RM(c, o = {}) { const m = M(c, Object.assign({ transparent: true, opacity: 0 }, o)); shellMats.push(m); return m; }
const rDeck = RM('#A77B55', { map: mats.floor.map, roughness: .8 }), rCushion = RM('#ECE6DA', { roughness: 1 }), rAccent = RM('#C9744F', { roughness: 1 }),
  rSage = RM('#7E9A84', { roughness: 1 }), rMetal = RM('#2B3035', { roughness: .45, metalness: .4 }), rPlanter = RM('#3B4045', { roughness: .8 }),
  rLeaf = RM('#4E8A4E'), rLeaf2 = RM('#6FAA62'), rStone = RM('#8C8A84', { roughness: 1 }), rCanvas = RM('#F2EEE6', { roughness: 1, side: THREE.DoubleSide }),
  rWood = RM('#8A6443', { roughness: .7 }), rTop = RM('#EFEDE8', { roughness: .3 }), rDoor = RM('#15191C', { roughness: .4 });
const rBulb = new THREE.MeshBasicMaterial({ color: '#FFE2A8', transparent: true, opacity: 0 }); shellMats.push(rBulb);
const rEmber = new THREE.MeshBasicMaterial({ color: '#FF7A2E', transparent: true, opacity: 0 }); shellMats.push(rEmber);
const rGlass = new THREE.MeshBasicMaterial({ color: '#DDEFF7', transparent: true, opacity: 0, depthWrite: false });
const rLine = new THREE.LineBasicMaterial({ color: '#2B3035', transparent: true, opacity: 0 });
{ const R = roofGroup, Y = ROOF_Y;
  blocked = blockedRoof;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { const X = wx(i), Z = wz(j); if (Math.abs(X) > 13.7 || Math.abs(Z) > 8.75) blocked[j * W + i] = 1; }
  box(28.8, .35, 18.8, roofMat, 0, 3.64, 0, R);
  box(27.9, .08, 17.9, rDeck, 0, Y - .04, 0, R, false);
  // glass balustrade with a steel top rail
  [[0, 9.25, 28.6, true], [0, -9.25, 28.6, true], [14.25, 0, 18.5, false], [-14.25, 0, 18.5, false]].forEach(([x, z, len, ax]) => {
    const g = new THREE.Mesh(new THREE.BoxGeometry(ax ? len : .03, 1.05, ax ? .03 : len), rGlass); g.position.set(x, Y + .55, z); R.add(g);
    box(ax ? len : .07, .06, ax ? .07 : len, rMetal, x, Y + 1.1, z, R);
    const n = Math.round(len / 2.4); for (let k = 0; k <= n; k++) { const t = -len / 2 + k * len / n; box(.05, 1.1, .05, rMetal, ax ? x + t : x, Y + .55, ax ? z : z + t, R); } });
  // lift house: agents come up from their own floor and step out here
  box(1.8, 2.7, 2.6, roofMat, 13.2, Y + 1.35, -1.8, R); block(13.2, -1.8, 1.8, 2.6, .2);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.2), rDoor); door.position.set(12.29, Y + 1.1, -1.8); door.rotation.y = -Math.PI / 2; R.add(door);
  box(.06, 2.3, .06, rMetal, 12.28, Y + 1.15, -2.38, R); box(.06, 2.3, .06, rMetal, 12.28, Y + 1.15, -1.22, R); box(.06, .06, 1.22, rMetal, 12.28, Y + 2.28, -1.8, R);
  // stair core + antenna, plant room along the north edge
  box(3.2, 2.5, 2.6, roofMat, -9.5, Y + 1.25, -5.5, R); block(-9.5, -5.5, 3.2, 2.6, .2);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, 4, 6), rMetal); mast.position.set(-9.5, Y + 4.5, -5.5); R.add(mast);
  [[-4.6, -7.9], [-2.2, -7.9]].forEach(([x, z]) => { box(2.0, 1.1, 1.4, roofDark, x, Y + .55, z, R);
    const fan = new THREE.Mesh(new THREE.CylinderGeometry(.45, .45, .06, 20), rMetal); fan.position.set(x, Y + 1.13, z); R.add(fan); block(x, z, 2.0, 1.4, .2); });
  for (let k = 0; k < 4; k++) { const pnl = box(1.7, .06, 1.1, roofDark, 1.2 + k * 1.9, Y + .45, -8.1, R); pnl.rotation.x = -.35; box(.06, .4, .06, rMetal, 1.2 + k * 1.9, Y + .2, -7.8, R); }
  block(4.05, -8.1, 7.6, 1.1, .2);
  // bar under a pergola
  box(5.6, 1.0, .7, rWood, 4.5, Y + .5, -5.4, R); box(5.8, .06, .8, rTop, 4.5, Y + 1.03, -5.4, R);
  for (let k = 0; k < 8; k++) cyl(.05, .05, .26, [rAccent, rSage, rTop][k % 3], 2.2 + k * .62, Y + 1.19, -5.55, R, 8);
  [[1.4, -6.3], [7.6, -6.3], [1.4, -3.3], [7.6, -3.3]].forEach(([x, z]) => { box(.12, 2.7, .12, rWood, x, Y + 1.35, z, R); block(x, z, .12, .12, .2); });
  [-6.3, -3.3].forEach(z => box(6.4, .12, .14, rWood, 4.5, Y + 2.7, z, R));
  for (let k = 0; k < 7; k++) box(.1, .08, 3.2, rWood, 1.6 + k, Y + 2.8, -4.8, R);
  block(4.5, -5.4, 5.8, .8);
  [2.4, 3.8, 5.2, 6.6].forEach(x => { cyl(.2, .2, .06, rWood, x, Y + .74, -4.45, R); cyl(.02, .02, .72, rMetal, x, Y + .37, -4.45, R, 6); cyl(.16, .16, .02, rMetal, x, Y + .02, -4.45, R, 16);
    roofSpot('barstool', x, -4.45, [0, -1], { y: .46 }); });
  // string lights: a catenary of bulbs between two points
  const stringLights = (a, b, sag = .5, n = 14) => {
    const pts = []; for (let k = 0; k <= n; k++) { const t = k / n, p = new THREE.Vector3().lerpVectors(a, b, t); p.y -= Math.sin(Math.PI * t) * sag; pts.push(p); }
    R.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), rLine));
    pts.slice(1, -1).forEach(p => { const bl = new THREE.Mesh(new THREE.SphereGeometry(.06, 8, 6), rBulb); bl.position.set(p.x, p.y - .07, p.z); R.add(bl); });
  };
  const V = (x, z, h = 2.65) => new THREE.Vector3(x, Y + h, z);
  stringLights(V(1.4, -3.3), V(7.6, -3.3), .35); stringLights(V(1.4, -6.3), V(7.6, -6.3), .35);
  const posts = [[4.0, 1.4], [11.4, 1.4], [11.4, 7.8], [4.0, 7.8]];
  posts.forEach(([x, z]) => { box(.08, 2.8, .08, rMetal, x, Y + 1.4, z, R); block(x, z, .08, .08, .2); });
  stringLights(V(4.0, 1.4, 2.8), V(11.4, 7.8, 2.8), .8, 20); stringLights(V(11.4, 1.4, 2.8), V(4.0, 7.8, 2.8), .8, 20);
  stringLights(V(4.0, 1.4, 2.8), V(11.4, 1.4, 2.8), .6, 16); stringLights(V(4.0, 7.8, 2.8), V(11.4, 7.8, 2.8), .6, 16);
  stringLights(V(7.6, -3.3), V(11.4, 1.4, 2.8), .6, 12);
  // fire pit ringed with poufs
  const FP = [7.7, 4.6];
  cyl(.85, .92, .38, rStone, FP[0], Y + .19, FP[1], R, 24); cyl(.62, .62, .04, rEmber, FP[0], Y + .39, FP[1], R, 20);
  [0, 1.1, 2.2].forEach(r => { const lg = box(.9, .1, .1, rWood, FP[0], Y + .45, FP[1], R); lg.rotation.y = r; });
  block(FP[0], FP[1], 1.8, 1.8, .25);
  const fire = new THREE.PointLight('#FF9A4D', 0, 7, 1.8); fire.position.set(FP[0], Y + 1.0, FP[1]); R.add(fire); roofLights.push(fire);
  for (let k = 0; k < 6; k++) { const ang = k / 6 * Math.PI * 2 + .3, x = FP[0] + Math.cos(ang) * 2, z = FP[1] + Math.sin(ang) * 2;
    cyl(.3, .3, .4, k % 2 ? rAccent : rCushion, x, Y + .2, z, R, 20); block(x, z, .5, .5, .05);
    const f = [FP[0] - x, FP[1] - z], l = Math.hypot(f[0], f[1]); roofSpot('firepit', x, z, [f[0] / l, f[1] / l], { y: .12 }); }
  // lounge corner: outdoor sofa facing the deck, low table, two chairs, a parasol
  { const g = grp(-9.3, 7.0, Math.PI, R); g.position.y = Y;
    box(4.2, .3, .95, rWood, 0, .15, 0, g); for (let k = 0; k < 3; k++) { box(1.34, .16, .76, rCushion, -1.4 + k * 1.4, .38, .07, g); box(1.34, .42, .2, rCushion, -1.4 + k * 1.4, .66, -.36, g); }
    [[-1.2, .7], [1.3, .66]].forEach(([x, y]) => { const p = box(.34, .32, .14, rAccent, x, y, -.2, g); p.rotation.z = .12; }); }
  block(-9.3, 7.0, 4.2, .95, .15);
  [-10.6, -9.3, -8.0].forEach(x => roofSpot('roofsofa', x, 6.85, [0, -1], { y: .2, from: 'front' }));
  box(1.6, .35, .8, rWood, -9.3, Y + .18, 4.9, R); cyl(.14, .11, .2, rPlanter, -9.0, Y + .45, 4.9, R, 12); block(-9.3, 4.9, 1.6, .8, .15);
  [-10.4, -8.2].forEach(x => { const g = grp(x, 3.4, 0, R); g.position.y = Y;
    box(.76, .1, .72, rCushion, 0, .38, 0, g); const bk = box(.76, .6, .1, rCushion, 0, .66, -.33, g); bk.rotation.x = -.2;
    box(.8, .04, .76, rMetal, 0, .31, 0, g); [[-.35, -.33], [.35, -.33], [-.35, .33], [.35, .33]].forEach(([a, b]) => box(.04, .3, .04, rMetal, a, .15, b, g));
    block(x, 3.4, .8, .76, .1); roofSpot('roofchair', x, 3.4, [0, 1], { y: .2 }); });
  { cyl(.35, .35, .08, rMetal, -6.4, Y + .04, 5.4, R, 16); cyl(.03, .03, 2.5, rMetal, -6.4, Y + 1.25, 5.4, R, 6);
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.8, .5, 16, 1, true), rCanvas); canopy.position.set(-6.4, Y + 2.5, 5.4); R.add(canopy); block(-6.4, 5.4, .4, .4, .15); }
  // sun loungers facing the south view
  [-3.6, -2.0, -.4].forEach(x => { const g = grp(x, 6.9, 0, R); g.position.y = Y;
    box(.7, .22, 1.9, rWood, 0, .2, 0, g); box(.62, .08, 1.15, rCushion, 0, .35, .33, g);
    const bk = box(.62, .08, .72, rCushion, 0, .55, -.6, g); bk.rotation.x = .75;
    block(x, 6.9, .7, 1.9, .1); roofSpot('lounger', x, 6.9, [0, 1], { y: .22, ax: x + .78, az: 6.9 }); });
  // spots at the rail for taking in the view
  roofSpot('rail', 2.2, 8.5, [0, 1]); roofSpot('rail', 3.4, 8.5, [0, 1]); roofSpot('rail', 11.8, -8.45, [0, -1]);
  // planters
  const tree = (x, z, s = 1) => { box(1.1 * s, .7 * s, 1.1 * s, rPlanter, x, Y + .35 * s, z, R); block(x, z, 1.1 * s, 1.1 * s, .15);
    for (let k = 0; k < 8; k++) { const a = k * 2.3, r = .25 + (k % 3) * .12; const l = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(.28, .42) * s, 0), k % 2 ? rLeaf : rLeaf2);
      l.position.set(x + Math.cos(a) * r * s, Y + (1.1 + k * .13) * s, z + Math.sin(a) * r * s); R.add(l); } };
  tree(-13.0, 8.2); tree(13.0, 8.2, .9); tree(-13.0, -1.2, .9); tree(-5.6, 2.2, .8); tree(12.9, -7.9, .8);
  box(7.2, .5, .7, rPlanter, 8.2, Y + .25, 8.6, R); block(8.2, 8.6, 7.2, .7, .1);
  for (let k = 0; k < 14; k++) { const l = box(.05, rand(.4, .7), .05, k % 2 ? rLeaf : rLeaf2, 4.9 + k * .48, Y + .7, 8.6 + rand(-.15, .15), R); l.rotation.z = rand(-.3, .3); }
  // DJ booth with speakers, facing the dance floor. The decks sit idle by day; after dark a DJ plays (see updateParty).
  const DJ = [-1.5, -3.1];
  box(2.4, .95, .8, rMetal, DJ[0], Y + .48, DJ[1], R); box(2.5, .05, .9, rWood, DJ[0], Y + .98, DJ[1], R); block(DJ[0], DJ[1], 2.5, .9, .2);
  PARTY.decks = [-.55, .55].map(dx => { const p = cyl(.32, .32, .04, rDoor, DJ[0] + dx, Y + 1.03, DJ[1], R, 24); box(.28, .012, .04, rTop, .14, .026, 0, p, false); return p; });
  [-1, 1].forEach(s => { const x = DJ[0] + s * 1.75;
    box(.7, 1.3, .6, rDoor, x, Y + .65, DJ[1] + .05, R); block(x, DJ[1] + .05, .7, .6, .1);
    [[.95, .12], [.45, .21]].forEach(([h, r]) => { const c = cyl(r, r, .03, rStone, x, Y + h, DJ[1] + .36, R, 20); c.rotation.x = Math.PI / 2; }); });
  // the party itself only shows after dark; the DJ and the booth screen also play by day while your music is on
  const N = PARTY.group; R.add(N); N.visible = false;
  const B = PARTY.booth; R.add(B); B.visible = false;
  const glow = (c, op = 1) => { const m = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0, depthWrite: false }); PARTY.fade.push([m, op]); return m; };
  { const s = canvasTex(512, 160), m = glow('#FFFFFF'); m.map = s.t; PARTY.screen = s;   // now playing, on the front of the booth
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2.2, .69), m); p.position.set(DJ[0], Y + .5, DJ[1] + .41); B.add(p); }
  // dance floor: a grid of light tiles in front of the booth, and spots to dance on. When it fills up it grows toward
  // the loungers, two rows at a time; an extension only shows while someone dances on it (or on one past it).
  const danceRows = (j0, parent) => { for (let i = 0; i < 5; i++) for (let j = j0; j < j0 + 2; j++) {
    const m = new THREE.MeshBasicMaterial({ color: '#15191C', transparent: true, opacity: 0 }); shellMats.push(m);
    PARTY.tiles.push(box(.76, .03, .76, m, DJ[0] - 1.6 + i * .8, Y + .015, -2.1 + j * .8, parent, false)); } };
  danceRows(0, N); danceRows(2, N);
  [[-3.0, -1.5], [-1.5, -1.5], [0, -1.5], [-2.25, .1], [-.75, .1]].forEach(([x, z]) => roofSpot('dance', x, z, [0, -1], { from: null, night: true }));
  PARTY.more = [[[-3.0, 1.7], [-1.5, 1.7], [0, 1.7]], [[-2.25, 3.3], [-.75, 3.3]]].map((pts, k) => {
    const g = new THREE.Group(); g.visible = false; N.add(g); danceRows(4 + k * 2, g);
    return { g, spots: pts.map(([x, z]) => roofSpot('dance', x, z, [0, -1], { from: null, night: true, ext: k + 1 })) }; });
  // light beams sweeping over the dance floor from the speakers, plus a coloured light
  [-1, 1].forEach(s => { const yaw = new THREE.Group(); yaw.position.set(DJ[0] + s * 1.75, Y + 1.32, DJ[1] + .1); N.add(yaw);
    const pitch = new THREE.Group(); pitch.rotation.x = -1.05; yaw.add(pitch);
    const geo = new THREE.ConeGeometry(.55, 4, 16, 1, true); geo.translate(0, -2, 0);
    const m = glow('#FF4FA3', .16); pitch.add(new THREE.Mesh(geo, m)); PARTY.beams.push({ yaw, m, s }); });
  PARTY.disco = new THREE.PointLight('#FF4FA3', 0, 8, 1.6); PARTY.disco.position.set(DJ[0], Y + 2.3, -.5); N.add(PARTY.disco);
  // fire pit flames
  PARTY.flames = [['#FF6A1A', .42, .9], ['#FFA42E', .3, .7], ['#FFE27A', .16, .45]].map(([c, r, h]) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(r, h, 10, 1, true), glow(c, .85)); f.geometry.translate(0, h / 2, 0); f.position.set(FP[0], Y + .4, FP[1]); N.add(f); return f; });
  PARTY.fire = fire;
  // the bar opens: neon sign on the pergola and a warm glow along the counter
  { const s = canvasTex(256, 96); s.x.font = '700 64px "Bricolage Grotesque", sans-serif'; s.x.textAlign = 'center';
    s.x.shadowColor = '#FF4FA3'; s.x.shadowBlur = 18; s.x.fillStyle = '#FFD6EA'; s.x.fillText('BAR', 128, 70); s.x.fillText('BAR', 128, 70);
    const m = glow('#FFFFFF'); m.map = s.t; PARTY.sign = m;
    const p = new THREE.Mesh(new THREE.PlaneGeometry(1.5, .56), m); p.position.set(4.5, Y + 2.3, -3.22); N.add(p); }
  box(5.6, .05, .04, glow('#FFB45E', .9), 4.5, Y + .12, -5.03, N, false);
  // two robots on shift: the DJ behind the decks, a bartender behind the counter
  const bot = (x, z, body, eye, parent = N) => {
    const g = grp(x, z, 0, parent); g.position.y = Y;
    const pivot = new THREE.Group(); g.add(pivot);
    [-.13, .13].forEach(lx => cyl(.09, .11, .5, rMetal, lx, .25, 0, g, 10));
    part(roundedBox(.62, .66, .42, .16), body, pivot, 0, .86, 0, false);
    const head = new THREE.Group(); head.position.y = 1.44; pivot.add(head);
    part(roundedBox(.62, .5, .5, .14), body, head, 0, 0, 0, false);
    const f = canvasTex(128, 96); f.x.fillStyle = '#0E1A20'; rrect(f.x, 0, 0, 128, 96, 22); f.x.fill();
    f.x.strokeStyle = eye; f.x.lineWidth = 9; f.x.lineCap = 'round'; f.x.shadowColor = eye; f.x.shadowBlur = 10;
    [40, 88].forEach(ex => { f.x.beginPath(); f.x.arc(ex, 52, 13, Math.PI * 1.1, Math.PI * 1.9); f.x.stroke(); });
    const fm = new THREE.MeshBasicMaterial({ map: f.t, transparent: true, opacity: 0 }); shellMats.push(fm);
    part(new THREE.PlaneGeometry(.5, .36), fm, head, 0, 0, .3, false);
    const arm = s => { const p = new THREE.Group(); p.position.set(s * .39, 1.12, 0); pivot.add(p); part(new THREE.BoxGeometry(.13, .5, .13), body, p, 0, -.22, 0, false); return p; };
    return { pivot, head, armL: arm(-1), armR: arm(1) };
  };
  PARTY.dj = bot(DJ[0], DJ[1] - .75, rSage, '#8BE9F5', B);
  { const h = PARTY.dj.head; part(new THREE.TorusGeometry(.36, .05, 8, 16, Math.PI), rDoor, h, 0, .02, 0, false);
    [-1, 1].forEach(s => { const c = part(new THREE.CylinderGeometry(.13, .13, .1, 14), rAccent, h, s * .35, 0, 0, false); c.rotation.z = Math.PI / 2; }); }
  PARTY.barkeep = bot(4.5, -6.05, rCushion, '#FFC867');
  part(new THREE.BoxGeometry(.2, .1, .05), rAccent, PARTY.barkeep.head.parent, 0, 1.12, .22, false);
  part(new THREE.CylinderGeometry(.07, .06, .24, 10), rTop, PARTY.barkeep.armR, 0, -.5, .04, false);
  blocked = blockedInterior;
}
[shell, roofGroup].forEach(g => { g.traverse(o => { if (o.isMesh) o.castShadow = false; }); g.visible = false; });
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
let shellT = -1;
function updateShell() {
  const base = defaultRadius();
  const t = view === 'plan' ? 0 : viewMode === 'roof' ? 1 : smooth((cam.radius - base * 1.25) / (base * .45));
  if (Math.abs(t - shellT) < .002) return; shellT = t;
  shell.visible = roofGroup.visible = t > .01;
  for (const f of floors) {                       // floors above you fade like the roof; floors below stay solid
    const above = f.i > curFloor.i;
    if (f !== curFloor) { f.shellParts.visible = !above || t > .01; setFade(f.mGlass, above ? t : 1); setFade(f.mSlab, above ? t : 1); }
    f.mSign.opacity = f.i >= curFloor.i ? t : 1;
  }
  fadeGlass.opacity = .3 * t; rGlass.opacity = .25 * t; rLine.opacity = t; shellMats.forEach(m => m.opacity = t);
  roofLights.forEach(L => L.intensity = (sceneT.dark ? 1.6 : .35) * t);
  const solid = t > .99;
  shellMats.forEach(m => { if (m.transparent === solid) { m.transparent = !solid; m.depthWrite = solid; m.needsUpdate = true; } });
  mats.window.opacity = .1 + .18 * t;
}
