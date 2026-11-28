/* ---------- floor labels ---------- */
function floorLabel(text, sub, x, z, w = 3.2) {
  const L = canvasTex(512, 104);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 104 / 512), new THREE.MeshBasicMaterial({ map: L.t, transparent: true, depthWrite: false }));
  mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, .022, z); scene.add(mesh);
  const o = { draw() { const c = L.x; c.clearRect(0, 0, 512, 104);
    c.fillStyle = sceneT.dark ? 'rgba(226,234,237,.72)' : 'rgba(21,33,42,.55)'; c.textAlign = 'center';
    c.font = '700 40px "Bricolage Grotesque", sans-serif'; c.fillText(text, 256, 46);
    if (sub) { c.font = '500 25px "IBM Plex Mono", monospace'; c.fillText(sub, 256, 88); }
    L.t.needsUpdate = true; } };
  return o;
}
const floorLabels = [
  floorLabel('Workbenches', 'home desks', -7, 4.75), floorLabel('Library', 'Explore subagents read here', -8.3, -6.3, 3.4),
  floorLabel('War room', 'Plan subagents', 1.4, -5.15, 2.6), floorLabel('Café', 'counter seats work too', 9.6, -3.45, 3),
  floorLabel('Lounge', 'bring a laptop', 9.4, 1.6, 2.8), floorLabel('Focus booths', 'deep work', .95, 3.75, 2.6),
  floorLabel('Hot desk', 'drop-in stools', .9, 8.35, 2.4), floorLabel('Game corner', 'breaks', -7.5, 5.55, 2.6),
  floorLabel('Lifts', 'subagents arrive here', 11.2, .05, 2.4),
];

/* ---------- rooftop trips ---------- */
const ROOF_ACTIVITY = { roofsofa: 'Chilling on the roof', roofchair: 'Chilling on the roof', barstool: 'At the rooftop bar',
  firepit: 'By the fire pit', lounger: 'On a sun lounger', rail: 'Taking in the view', dance: 'Dancing to the DJ' };
// Free terrace spots; the dance floor only opens after dark. At the party 7 in 10 picks hit the dance floor
// (while it has room), 2 in 10 the bar or fire pit, and the last 1 in 10 anywhere else.
const PARTY_SPOTS = new Set(['barstool', 'firepit']);
// A dance floor extension opens only once every dance spot before it is taken.
const danceOpen = s => !s.ext || ROOF_SPOTS.every(o => o.type !== 'dance' || (o.ext || 0) >= s.ext || o.by);
const roofFree = () => ROOF_SPOTS.filter(s => !s.by && (!s.night || isParty()) && danceOpen(s));
function pickRoof() {
  const f = roofFree(); if (!f.length) return null;
  if (!isParty()) return pick(f);
  const dance = f.filter(s => s.type === 'dance'), rest = f.filter(s => s.type !== 'dance'),
    fun = rest.filter(s => PARTY_SPOTS.has(s.type)), r = Math.random();
  return pick(dance.length && r < .7 ? dance : fun.length && r < .9 ? fun : rest.length ? rest : dance);
}
function roofWalkTo(a, s) {
  if (a.spot === s) return Promise.resolve();
  const from = a.spot;
  if (from && from !== ROOF_LIFT && from.by === a.id) from.by = null;
  if (s !== ROOF_LIFT) s.by = a.id;
  const start = from ? approach(from) : { x: a.g.position.x, z: a.g.position.z }, end = approach(s);
  blocked = blockedRoof; const pts = (from ? [new THREE.Vector2(start.x, start.z)] : []).concat(route(start.x, start.z, end.x, end.z)); blocked = blockedInterior;
  if (end.x !== s.x || end.z !== s.z) pts.push(new THREE.Vector2(s.x, s.z));
  a.path = pts; a.spot = null; a.dest = s; a.where = 'Rooftop'; uiDirty = true;
  return new Promise(r => { a.arrive = () => { a.spot = s; a.dest = null; a.arrivedAt = performance.now(); a.where = s === ROOF_LIFT ? 'Rooftop' : `Rooftop · ${PLACE[s.type]}`; uiDirty = true; detailDirty = true; r(); }; });
}
// Take the lift from the agent's own floor up to a free spot on the terrace.
async function goRoof(a) {
  if (a.onRoof || a.kind !== 'main') return false;
  const s = pickRoof(); if (!s) return false; s.by = a.id;
  setState(a, 'idle', 'Heading up to the roof');
  await walkTo(a, DOOR); a.leaving = true; await wait(.6);
  if (a.review) { a.leaving = false; s.by = null; return false; }   // a subagent reported back meanwhile: the review walk wins
  roofGroup.add(a.g); a.onRoof = true; a.spot = ROOF_LIFT; a.leaving = false; a.appear = 0;
  a.g.position.set(ROOF_LIFT.x, ROOF_Y, ROOF_LIFT.z); a.yaw = a.yawT = -Math.PI / 2;
  await roofWalkTo(a, s);
  a.pose = poseFor(a); setState(a, 'idle', ROOF_ACTIVITY[s.type]);
  return true;
}
// Back down to the agent's floor, arriving through the lift.
async function leaveRoof(a) {
  if (!a.onRoof) return;
  await roofWalkTo(a, ROOF_LIFT); a.leaving = true; await wait(a.sprint ? .35 : .6);   // called back: an express lift
  scene.add(a.g); a.onRoof = false; a.spot = DOOR; a.leaving = false; a.appear = 0;
  a.g.position.set(DOOR.x, 0, DOOR.z); a.yaw = a.yawT = -Math.PI / 2;
}
const roofAgents = () => agents.filter(a => a.onRoof);
function goRoofView() {
  flight = null;
  if (view === 'plan') setView('3d');
  viewMode = 'roof'; goal.phi = .95; goal.theta = .5; goal.radius = defaultRadius() * 1.1; goal.target.x = 0; goal.target.z = 0;
  renderLift();
}
const tmpV3 = new THREE.Vector3();
const worldPos = a => a.g.getWorldPosition(tmpV3);

/* ---------- app logos ---------- */
// Real icons of the apps installed on this Mac, served by the local office (/api/app-icon/<bundle id>.png).
// Tools with no app installed, and the claude.ai preview, get a lettered badge instead.
const TOOL_ICON = { 'claude-code': 'com.anthropic.claudefordesktop', codex: 'com.openai.codex', cursor: 'com.todesktop.230313mzl4w4u92',
  windsurf: 'com.exafunction.windsurf', copilot: 'com.microsoft.VSCode', cline: 'com.microsoft.VSCode', ollama: 'com.electron.ollama' };
const TOOL_LETTER = { 'claude-code': 'C', codex: 'X', cursor: 'Cu', gemini: 'G', copilot: 'Co', factory: 'F', qwen: 'Q', goose: 'Go',
  kiro: 'K', windsurf: 'W', cline: 'Cl', opencode: 'O', amp: 'A', ollama: 'Ol', antigravity: 'Ag' };
const LOCAL_OFFICE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(location.host);
const iconState = {}, iconImg = {};
function iconFor(bundle) {
  if (!bundle || !LOCAL_OFFICE) return null;
  if (!iconState[bundle]) {
    iconState[bundle] = 'loading';
    const img = new Image();
    img.onload = () => { iconState[bundle] = 'ok'; iconImg[bundle] = img; uiDirty = true; detailDirty = true; buildCustomize(); floors.forEach(f => drawSign(f, true)); };
    img.onerror = () => { iconState[bundle] = 'missing'; };
    img.src = `/api/app-icon/${encodeURIComponent(bundle)}.png`;
  }
  return iconState[bundle] === 'ok' ? iconImg[bundle] : null;
}
const toolOf = a => a.agentName || (a.parent && a.parent.agentName) || 'claude-code';   // a subagent handed over by T3 Code has a tool of its own
// The tool's own logo (Claude, Codex, Cursor…), else the app it runs in (Terminal, iTerm…). T3 Code runs many tools, so
// its logo says nothing about which one: a tool with no app of its own (Antigravity there) keeps its letter badge.
const agentIcon = a => { const host = (a.parent || a).hostApp; return iconFor(TOOL_ICON[toolOf(a)]) || (host !== 'com.t3tools.t3code' ? iconFor(host) : null); };
function appBadge(a, cls = 'app-ico') {
  const img = agentIcon(a);
  return img ? `<img class="${cls}" src="${img.src}" alt="">` : `<span class="${cls} mono">${esc(TOOL_LETTER[toolOf(a)] || '?')}</span>`;
}
// A floor shows its number; each agent's own badge shows which tool it runs in.
function floorBadge(f, waiting) { return `<span class="fl-num${waiting ? ' wait' : ''}">${floorNum(f)}</span>`; }
// A floor's news: someone there needs you, or finished while you were looking at another floor.
// "Done" stays until you visit the floor, open that agent, or give it a new task.
const unseenOf = f => (f.unseen || (f.unseen = new Set()));
function floorNews(f) {
  if (floorAgents(f).some(a => a.state === 'waiting')) return '<span class="pill s-waiting">Needs you</span>';
  return unseenOf(f).size ? '<span class="pill s-done">Done</span>' : '';
}
function seeAgent(a) { if (a && a.floor && unseenOf(a.floor).delete(a.id)) uiDirty = true; }

/* ---------- floors: one project per floor ---------- */
// The floor you're on is the furnished interior at y = 0. Every other floor is a glass shell
// in `building`, which slides up and down so the current floor always sits at y = 0.
const FLOOR_H = 4.6, FLOOR_BASE = 18;
const floors = []; let curFloor = null, floorSeq = 0;
let yOff = 0, yOffTarget = 0, viewMode = 'floor';
const onFloor = () => viewMode === 'floor' || viewMode === 'screen';
const floorNum = f => FLOOR_BASE + f.i;
const floorAgents = f => agents.filter(a => a.floor === f);
// Each floor gets its own copy of the seats so occupancy is per floor; the meshes (screens, chairs) are shared.
function cloneSpots() {
  const S = {}, map = new Map();
  for (const [type, list] of Object.entries(SPOTS)) S[type] = list.map(s => { const c = { ...s, by: null, owner: null }; map.set(s, c); return c; });
  return { S, desks: deskSeats.map(s => map.get(s)) };
}
// glass band for floors you're not inside: one texture tile per 1.8 x 3.4 bay, lit windows via the emissive map
const bayTex = canvasTex(64, 128), bayLit = canvasTex(64, 128);
{ const x = bayTex.x, g = x.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#BCD2E0'); g.addColorStop(1, '#7593A8'); x.fillStyle = g; x.fillRect(0, 0, 64, 128);
  x.fillStyle = 'rgba(255,255,255,.16)'; x.beginPath(); x.moveTo(22, 0); x.lineTo(36, 0); x.lineTo(12, 128); x.lineTo(-2, 128); x.fill();
  x.fillStyle = '#23272A'; x.fillRect(0, 0, 3, 128); x.fillRect(0, 0, 64, 3); x.fillRect(0, 118, 64, 10);
  const l = bayLit.x; l.fillStyle = '#000'; l.fillRect(0, 0, 64, 128); l.fillStyle = '#fff'; l.fillRect(3, 3, 61, 115);
  [bayTex, bayLit].forEach(T => { T.t.wrapS = T.t.wrapT = THREE.RepeatWrapping; }); }
function bayBox(w, h, d, mat) {
  const geo = new THREE.BoxGeometry(w, h, d), uv = geo.attributes.uv;
  [[d, h], [d, h], null, null, [w, h], [w, h]].forEach((f, fi) => { for (let k = 0; k < 4; k++) { const i = fi * 4 + k;
    if (f) uv.setXY(i, uv.getX(i) * f[0] / 1.8, uv.getY(i) * f[1] / 3.4); else uv.setXY(i, .02, .02); } });
  return new THREE.Mesh(geo, mat);
}
function makeFloor(key, name, placeholder = false) {
  const { S, desks } = cloneSpots();
  const f = { key, name, placeholder, i: floors.length, created: floorSeq++, SPOTS: S, deskSeats: desks, signSig: '',
    mGlass: new THREE.MeshLambertMaterial({ map: bayTex.t, emissiveMap: bayLit.t, emissive: new THREE.Color('#FFD9A0'), emissiveIntensity: 0 }),
    mSlab: M('#B9BAB4', { roughness: .9 }), sign: canvasTex(512, 128) };
  f.mSign = new THREE.MeshBasicMaterial({ map: f.sign.t, transparent: true, depthWrite: false });
  f.group = new THREE.Group(); f.shellParts = new THREE.Group(); f.group.add(f.shellParts);
  box(28.8, .9, 18.8, f.mSlab, 0, -.65, 0, f.shellParts, false);
  const glass = bayBox(28.4, 3.4, 18.4, f.mGlass); glass.position.y = 1.7; glass.userData.floor = f; f.shellParts.add(glass); f.pick = glass;
  [[-8.6, 9.27, 0], [14.27, -4.8, Math.PI / 2]].forEach(([x, z, r]) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 1.6), f.mSign); m.position.set(x, 2.45, z); m.rotation.y = r; f.group.add(m); });
  f.group.traverse(o => { if (o.isMesh) o.castShadow = false; });
  f.mGlass.color.set(sceneT.dark ? '#56657A' : '#FFFFFF');
  building.add(f.group); floors.push(f); drawSign(f, true);
  return f;
}
function drawSign(f, force) {
  const ag = floorAgents(f), waiting = ag.some(a => a.state === 'waiting');
  const lead = ag.find(a => a.kind === 'main'), logo = lead && agentIcon(lead);
  const done = !waiting && unseenOf(f).size > 0;
  const sig = `${f.name}|${floorNum(f)}|${ag.map(a => a.color + a.state + a.kind).join()}|${logo ? logo.src : ''}|${done}`;
  if (!force && sig === f.signSig) return; f.signSig = sig;
  const x = f.sign.x; x.clearRect(0, 0, 512, 128);
  x.fillStyle = 'rgba(16,22,26,.9)'; rrect(x, 4, 8, 504, 112, 22); x.fill();
  x.fillStyle = waiting ? '#F2A22C' : '#F2F5F6'; rrect(x, 16, 20, 92, 88, 16); x.fill();
  if (logo) { x.save(); rrect(x, 22, 26, 80, 76, 14); x.clip(); x.drawImage(logo, 22, 24, 80, 80); x.restore(); }
  else { x.fillStyle = '#15212A'; x.font = '700 50px "Bricolage Grotesque", sans-serif'; x.textAlign = 'center'; x.fillText(String(floorNum(f)), 62, 82); }
  x.textAlign = 'left'; x.fillStyle = '#F2F5F6'; x.font = '700 40px "Bricolage Grotesque", sans-serif'; x.fillText(fitText(x, f.name, 370), 126, 62);
  ag.slice(0, 11).forEach((a, k) => { x.fillStyle = a.color; x.beginPath(); x.arc(138 + k * 26, 95, a.kind === 'sub' ? 7 : 10, 0, 7); x.fill(); });
  x.font = '600 24px "IBM Plex Sans", sans-serif';
  if (waiting) { x.fillStyle = '#F2A22C'; x.textAlign = 'right'; x.fillText('needs you', 494, 102); x.textAlign = 'left'; }
  else if (done) { x.fillStyle = '#52C96F'; x.textAlign = 'right'; x.fillText('done ✓', 494, 102); x.textAlign = 'left'; }
  else if (!ag.length) { x.fillStyle = '#8C9DA5'; x.fillText('quiet', 126, 102); }
  f.sign.t.needsUpdate = true;
}
function setFade(m, op) { m.opacity = op; const solid = op > .99; if (m.transparent === solid) { m.transparent = !solid; m.depthWrite = solid; m.needsUpdate = true; } }
function rebuildTower() {
  floors.forEach(f => { f.group.position.y = f.i * FLOOR_H; f.shellParts.visible = f !== curFloor; drawSign(f, true); });
  roofGroup.position.y = (floors.length - 1) * FLOOR_H;
  shellT = -1;
}
function refreshFloorVisuals() {
  curFloor.deskSeats.forEach(s => { s.chairMat.color.set(s.owner ? s.owner.color : sceneT.chair); s.screen.color.set(sceneT.screenOff); });
  agents.forEach(a => { if (a.floor === curFloor) updateScreen(a); });
  screensDirty = true; deskDirty = true;
  for (const s of Object.values(SPOTS).flat()) if (s.chair) s.chair.rotation.y = yawOf(s.face);   // not how the last floor's sitters left them
}
function goToFloor(i) {
  const f = floors[i]; if (!f) return;
  flight = null;
  if (unseenOf(f).size) { unseenOf(f).clear(); uiDirty = true; }
  if (f !== curFloor) {
    curFloor = f; yOffTarget = -f.i * FLOOR_H; rebuildTower(); refreshFloorVisuals();
    if (selected && selected.floor !== f) select(null);
  }
  viewMode = 'floor';
  if (view === '3d') { goal.phi = .9; goal.theta = .36; goal.radius = defaultRadius(); goal.target.set(0, 0, -.3); } else goal.target.set(0, 0, 0);
  renderLift(); uiDirty = true;
}
const buildingRadius = () => clamp(defaultRadius() * 1.75 + floors.length * 3.4, 50, 150);
/* Flying to a floor, like a helicopter: rise out beside the tower (its glass closes over this floor), travel up
   or down past the other floors, then dive into the new floor, straight to the agent when there is one. Whatever
   the click asked for (say, opening that agent's card) happens once the camera has arrived. The camera follows a
   scripted path of eased, overlapping legs instead of chasing a goal, so the whole trip is one continuous move. */
let flight = null;
const ease = t => { t = clamp(t, 0, 1); return t < .5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2; };
const lerpN = (a, b, t) => a + (b - a) * t;
const HELI_TARGET = new THREE.Vector3(0, .6, 0), FLOOR_TARGET = new THREE.Vector3(0, 0, -.3);
const camPose = () => ({ theta: cam.theta, phi: cam.phi, radius: cam.radius, target: cam.target.clone() });
function setCamPose(from, to, e) {
  cam.theta = lerpN(from.theta, to.theta, e); cam.phi = lerpN(from.phi, to.phi, e); cam.radius = lerpN(from.radius, to.radius, e);
  cam.target.lerpVectors(from.target, to.target, e);
}
function flyToFloor(i, then, agent) {
  const f = floors[i]; if (!f) return;
  if (unseenOf(f).size) { unseenOf(f).clear(); uiDirty = true; }   // you're going to look, so it's seen
  if (reduced || view !== '3d' || renderer.xr.isPresenting || (f === curFloor && onFloor() && !flight)) { goToFloor(i); if (then) then(); return; }
  const same = f === curFloor, dist = Math.abs(f.i - curFloor.i);
  const F = flight = { f, then, agent, t: 0, from: camPose(), same, swapped: same, y0: yOff, y1: -f.i * FLOOR_H,
    heli: { theta: cam.theta + .35, phi: 1.16, radius: Math.max(defaultRadius() * 2.3, 62), target: HELI_TARGET },
    rise: same ? 0 : .9, travel: same ? 0 : clamp(.7 + dist * .16, .8, 1.8), dive: 1.1 };
  F.travelAt = F.rise * .7;                                         // the glass is closed by then
  F.diveAt = F.travelAt + F.travel * .8;                            // start diving as the tower slows down
  F.end = F.diveAt + F.dive;
  if (same) yOffTarget = F.y1;
  if (selected && selected.floor !== f) select(null);
  viewMode = 'flying'; renderLift();
}
// Where the dive ends: close to the agent (tracking them if they walk), or the floor's usual view.
function diveGoal(F) {
  if (F.agent && F.agent.floor === F.f && !F.agent.gone) { const p = worldPos(F.agent); return { theta: .36, phi: .9, radius: 14, target: new THREE.Vector3(p.x, 0, p.z) }; }
  return { theta: .36, phi: .9, radius: defaultRadius(), target: FLOOR_TARGET };
}
// Run `then` once the camera has settled on where it's heading (used for the roof).
function land(then) { flight = { landing: true, t: 0, then }; }
function stepFlight(dt) {
  const F = flight; if (!F) return;
  F.t += dt;
  if (F.landing) {
    const settled = Math.abs(cam.radius - goal.radius) < .25 && Math.abs(cam.phi - goal.phi) < .02 && cam.target.distanceTo(goal.target) < .15;
    if (settled || F.t > 1.2) { flight = null; if (F.then) F.then(); }
    return;
  }
  if (F.rise && F.t < F.diveAt) setCamPose(F.from, F.heli, ease(F.t / F.rise));                 // 1. rise out beside the tower
  /* 2. Behind the glass, switch floors, then travel. The furnished interior always sits at y = 0, so rather than
     sliding the tower past it (every floor in between would pass right through it), the tower jumps at once so the
     new floor lines up with the interior, and the camera (and sky) jump by the same amount so nothing seems to move.
     Then the camera glides back down to the new floor. */
  if (!F.swapped && F.t >= F.travelAt) {
    F.swapped = true; F.y0 = yOff; yOff = yOffTarget = F.y1; curFloor = F.f; rebuildTower(); refreshFloorVisuals(); renderLift(); uiDirty = true;
  }
  const camY0 = F.camY || 0;
  F.camY = !F.same && F.t >= F.travelAt ? (F.y1 - F.y0) * (1 - smooth((F.t - F.travelAt) / F.travel)) : 0;
  if (F.t >= F.diveAt) {                                                                           // 3. dive in, toward the agent
    if (!F.diveFrom) { F.diveFrom = camPose(); F.diveFrom.target.y -= camY0; }
    setCamPose(F.diveFrom, diveGoal(F), ease((F.t - F.diveAt) / F.dive));
  }
  cam.target.y += F.camY; skyDome.position.y = F.camY;
  goal.theta = cam.theta; goal.phi = cam.phi; goal.radius = cam.radius; goal.target.copy(cam.target);   // no catch-up once we land
  if (F.t >= F.end) {
    flight = null; yOff = yOffTarget = F.y1; viewMode = 'floor'; renderLift(); uiDirty = true;
    if (F.then) F.then();
  }
}

function goBuilding() {
  flight = null;
  if (view === 'plan') setView('3d');
  viewMode = 'building'; goal.phi = 1.2; goal.theta = .55; goal.radius = buildingRadius(); goal.target.x = 0; goal.target.z = 0;
  renderLift();
}
function floorGlow() {
  const pulse = .5 + .5 * Math.sin(performance.now() / 260);
  for (const f of floors) {
    if (f === curFloor) continue;
    let busy = 0, waiting = false;
    for (const a of agents) if (a.floor === f) { if (a.state === 'waiting') waiting = true; if (a.busy) busy++; }
    f.mGlass.emissive.set(waiting ? '#FFA62B' : '#FFD9A0');
    f.mGlass.emissiveIntensity = waiting ? .25 + .6 * pulse : busy ? (sceneT.dark ? .75 : .2) : (sceneT.dark ? .1 : 0);
  }
}
function floorAt(cx, cy) {
  const r = canvas.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const list = floors.filter(f => f === curFloor || f.i < curFloor.i || shellT > .01).map(f => f.pick);
  const h = ray.intersectObjects(list, false);
  return h.length ? h[0].object.userData.floor : null;
}
const floorOrderKey = 'agent-office:floors';
function loadFloorOrder() { try { return JSON.parse(localStorage.getItem(floorOrderKey)) || []; } catch (_) { return []; } }
function saveFloorOrder() { try { localStorage.setItem(floorOrderKey, JSON.stringify(floors.filter(f => !f.placeholder).map(f => f.key))); } catch (_) {} }
// Find or add the floor for a project. New projects get a new floor on top; order is remembered between visits.
function ensureFloor(key, name, remember) {
  let f = floors.find(x => x.key === key); if (f) return f;
  if (floors.length === 1 && floors[0].placeholder) { f = floors[0]; f.key = key; f.name = name; f.placeholder = false; }
  else f = makeFloor(key, name);
  if (remember) {
    const saved = loadFloorOrder(), rank = x => { const r = saved.indexOf(x.key); return r < 0 ? 1e6 + x.created : r; };
    floors.sort((p, q) => rank(p) - rank(q)); floors.forEach((x, i) => x.i = i); saveFloorOrder();
  }
  yOffTarget = yOff = -curFloor.i * FLOOR_H; rebuildTower(); renderLift(); uiDirty = true;
  return f;
}
const ROOF_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="10" r="4"/><path d="M12 2v2M4.9 4.9l1.4 1.4M2 12h2M20 12h2M17.7 6.3l1.4-1.4M3 20h18"/></svg>';
const BUILDING_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="2" width="14" height="20" rx="1.5"/><path d="M9 6h2M13 6h2M9 10h2M13 10h2M9 14h2M13 14h2M10 22v-4h4v4"/></svg>';
// On a phone the floors are one scrolling row: keep the current one in view.
function liftToCurrent() {
  const el = $('#lift-list'), on = el && el.querySelector('.on');
  if (on && isMobile()) el.scrollLeft = on.offsetLeft - el.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
}
function renderLift() {
  const el = $('#lift-list'); if (!el) return;
  const rows = floors.slice().reverse().map(f => {
    const ag = floorAgents(f), w = ag.some(a => a.state === 'waiting');
    return `<button class="lift-btn${f === curFloor && onFloor() ? ' on' : ''}" data-floor="${f.i}" aria-label="Floor ${floorNum(f)}, ${esc(f.name)}">
      ${floorBadge(f, w)}<span class="fl-name">${esc(f.name)}</span>
      ${floorNews(f) || `<span class="fl-count">${ag.filter(a => a.kind === 'main').length || ''}</span>`}</button>`;
  }).join('');
  const up = roofAgents();
  const html = `<button class="lift-btn bld${viewMode === 'building' ? ' on' : ''}" data-floor="building"><span class="fl-num">${BUILDING_ICON}</span><span class="fl-name">Whole building</span></button>`
    + `<button class="lift-btn roof${viewMode === 'roof' ? ' on' : ''}" data-floor="roof"><span class="fl-num${isParty() ? ' party' : ''}">${ROOF_ICON}</span><span class="fl-name">${isParty() ? 'Rooftop party' : 'Rooftop terrace'}</span><span class="fl-count">${up.length || ''}</span></button>` + rows;
  if (html !== el._html) { el.innerHTML = html; el._html = html; liftToCurrent(); }
  const cur = viewMode === 'building' ? `<span class="fl-num">${BUILDING_ICON}</span>Whole building`
    : viewMode === 'roof' ? `<span class="fl-num${isParty() ? ' party' : ''}">${ROOF_ICON}</span>Rooftop` : `${floorBadge(curFloor, false)}${esc(curFloor.name)}`;
  const ce = $('#lift-current'); if (ce._html !== cur) { ce.innerHTML = cur; ce._html = cur; }
  updateMusicBtn();
}

/* ---------- theme ---------- */
const extraPlants = new THREE.Group(); scene.add(extraPlants);
[[-2.0, 4.6], [5.4, 0.3], [-13.1, 2.2], [3.6, -3.8], [6.0, -3.6], [13.3, -5.2], [-2.3, -5.2], [5.6, 2.2]].forEach(([x, z], i) => (i % 2 ? plantBush : plantBig)(x, z, .75, extraPlants));
let sceneKey = 'loft';
let sceneT = SCENES[sceneKey];
/* Auto theme: follows the viewer's clock. Night until 5, dawn to daylight by 8, daylight until 17, then
   golden hour and night by 20. Between keyframes the two scenes blend, and by day the sun crosses the sky. */
const AUTO_KEYS = [[0, 'night'], [5, 'night'], [6.5, 'golden'], [8, 'loft'], [17, 'loft'], [18.5, 'golden'], [20, 'night'], [24, 'night']];
const SUN_POS = new THREE.Vector3(10, 20, 12), MOON_POS = new THREE.Vector3(-8, 22, 14);
function blendScene(A, B, t) {
  const o = {};
  for (const k in A) { const a = A[k], b = B[k];
    o[k] = typeof a === 'number' ? a + (b - a) * t : /^#[0-9a-f]{6}$/i.test(a) ? mix(a, b, t) : t < .5 ? a : b; }
  return o;
}
function clockHours() {                                             // ?time=18:45 previews the office at that hour
  const m = /^(\d{1,2}):(\d{2})$/.exec(new URLSearchParams(location.search).get('time') || '');
  if (m) return (+m[1] % 24) + Math.min(59, +m[2]) / 60;
  const d = new Date(); return d.getHours() + d.getMinutes() / 60;
}
function autoScene(h) {
  let i = 0; while (h >= AUTO_KEYS[i + 1][0]) i++;
  const [h0, k0] = AUTO_KEYS[i], [h1, k1] = AUTO_KEYS[i + 1];
  const u = k0 === k1 ? 0 : (h - h0) / (h1 - h0), t = u * u * (3 - 2 * u);   // eased, so dawn and dusk feel gradual
  const night = k0 === 'night' && k1 === 'night' ? 1 : k1 === 'night' ? t : k0 === 'night' ? 1 - t : 0;
  return { T: Object.assign(blendScene(SCENES[k0], SCENES[k1], t), { label: 'Auto' }), night, sig: `${k0}>${k1}:${t.toFixed(2)}` };
}
// By day the sun rises on the left and sets on the right; at night the light comes from a fixed moon.
function placeSun(h, night) {
  const a = Math.PI * clamp((h - 6) / 12, 0, 1);
  sun.position.set(-18 * Math.cos(a), 8 + 16 * Math.sin(a), 12).lerp(MOON_POS, night);
}
let autoSig = '';
setInterval(() => {                                                 // re-check once a minute
  if (sceneKey !== 'auto') return;
  const h = clockHours(), r = autoScene(h);
  if (r.sig !== autoSig) applyScene('auto'); else placeSun(h, r.night);
}, 60000);
function applyScene(key) {
  sceneKey = key;
  if (key === 'auto') { const h = clockHours(), r = autoScene(h); sceneT = r.T; autoSig = r.sig; placeSun(h, r.night); nightT = r.night; }
  else { sceneT = SCENES[key]; sun.position.copy(SUN_POS); nightT = sceneT.dark ? 1 : 0; }
  const T = sceneT;
  scene.background = new THREE.Color(T.haze); drawSky(T); scene.fog.color.set(T.haze);
  landmarkMat.color.set(mix('#FFFFFF', '#26354C', T.cityDark)); landmarkMat.emissiveIntensity = T.cityLit;
  gangnamLandmarkMat.color.set(mix('#FFFFFF', '#26354C', T.cityDark)); gangnamLandmarkMat.emissiveIntensity = T.cityLit;
  gangnamStreetMats.forEach(m => m.color.set(mix('#FFFFFF', '#596C83', T.cityDark)));
  gangnamMats.forEach(m => { m.color.set(mix('#FFFFFF', '#26354C', T.cityDark)); m.emissiveIntensity = T.cityLit; });
  landmarkTrimMat.color.set(mix('#FFFFFF', '#596C83', T.cityDark));
  cityMats.forEach((m, i) => { m.color.set(mix(CITY_TINTS[i], '#1E2636', T.cityDark)); m.emissiveIntensity = T.cityLit; });
  beaconMat.color.set(T.dark ? '#FF3B30' : '#C8453C'); mats.window.color.set(T.skyMid); fadeGlass.color.set(T.skyMid); fadeFrame.color.set(T.black); shellT = -1;
  ['floor','wall','oak','white','black','fabric','fabric2','leather','felt1','felt2','rug','rug2','cabinet','tile','chair'].forEach(k => mats[k].color.set(T[k]));
  mats.glass.color.set(T.glass);
  hemi.color.set(T.sky); hemi.groundColor.set(T.ground); hemi.intensity = T.hemi; sun.intensity = T.sun; sun.color.set(T.sunColor);
  lamps.forEach(l => l.intensity = T.lamps);
  mats.bulb.color.set(T.dark ? '#FFE2A8' : '#FFF3DC');
  gridMat.color.set(T.grid);
  extraPlants.visible = key === 'greenhouse';
  curFloor.deskSeats.forEach(s => { if (!s.owner) s.chairMat.color.set(T.chair); if (!s.by) s.screen.color.set(T.screenOff); });
  floors.forEach(f => { f.mGlass.color.set(T.dark ? '#56657A' : '#FFFFFF'); });
  agents.forEach(a => { a.labelDirty = true; updateScreen(a); });
  floorLabels.forEach(l => l.draw()); drawNeon();
  $('#themes').querySelectorAll('.theme-card').forEach(b => b.setAttribute('aria-pressed', b.dataset.key === key));
  renderLift();
}
