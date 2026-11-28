/* ---------- VR ---------- */
// Experimental: nobody has tried this on a real headset yet, only in an emulator (see docs/vr.md).
// Headset browsers start VR only on a secure address. The office listens on this computer alone, so a Quest reaches it
// as localhost over a USB cable (adb reverse), which counts as secure and keeps everything off the network.
let vrBusy = false;
$('#vr-btn').onclick = async () => {
  if (vrBusy || renderer.xr.isPresenting) return;
  if (!window.isSecureContext) { toast('VR opens only from a localhost address. Connect the headset with a USB cable, then open the office at localhost in its browser.'); return; }
  if (!navigator.xr) { toast('This browser cannot show VR. Open the office in the browser of your headset.'); return; }
  vrBusy = true; let session = null;
  try {
    if (!await navigator.xr.isSessionSupported('immersive-vr')) { toast('No VR headset found. Connect a Meta Quest with a USB cable, then open the office in its browser.'); return; }
    session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor');
    // Soft shadows cost too much on a headset: a Quest must draw two eyes at 72 frames a second or more.
    sun.castShadow = false;
    session.addEventListener('end', e => {
      // three.js tidies up only a session it finished starting; for a half-started one its tidy-up throws, so skip it.
      if (!renderer.xr.isPresenting) e.stopImmediatePropagation();
      renderer.xr.enabled = false; sun.castShadow = true; rig.position.set(0, 0, 0); rig.rotation.y = 0; vrReset(); layout();
    });
    await renderer.xr.setSession(session);
    // Start where the page looks: on the rooftop at its lift, or in the aisle of the floor in view.
    rig.rotation.y = 0; camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
    vrArrive(viewMode === 'roof' ? 'roof' : curFloor.i);
    if (viewMode === 'roof') rig.position.set(11.6, vrGround(), -1.8); else rig.position.set(2.5, 0, 0.5);
    vrLiftBtn.visible = true;
  } catch (_) {
    if (session) session.end().catch(() => {});   // a session that opened but failed to draw would leave the headset black
    toast('The headset did not start VR. Put the headset on, then select Enter VR again.');
  } finally { vrBusy = false; }
};

/* ---------- VR: moving with the controllers ---------- */
// Teleport and snap turns, not smooth walking or smooth turning: those make many people sick in a headset.
// Hold the trigger to aim at the floor, let go to jump there. Push a thumbstick left or right to turn 30 degrees,
// up or down to go one floor up or down.
const VR_TURN = Math.PI / 6, VR_REACH = 10;   // one snap turn; the farthest jump in metres
const vrV = new THREE.Vector3(), vrDir = new THREE.Vector3(), vrUp = new THREE.Vector3(0, 1, 0);
const vrSticks = new Map();   // input source → { x, y }: is the stick back near the middle on that axis, so the next push acts
const vrRing = new THREE.Mesh(new THREE.RingGeometry(.2, .28, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7cf0ff, transparent: true, opacity: .85, depthTest: false }));
vrRing.visible = false; vrRing.renderOrder = 10; scene.add(vrRing);
const vrPads = [0, 1].map(i => {
  const pad = renderer.xr.getController(i);
  const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x7cf0ff, transparent: true, opacity: .6 }));
  ray.visible = false; pad.add(ray);
  Object.assign(pad.userData, { ray, aiming: false, hit: null, ui: null, pressed: null });
  // Only a controller has a ray. A gaze or a screen tap points from the head and would draw a line through the eyes.
  pad.addEventListener('connected', e => { ray.visible = e.data.targetRayMode === 'tracked-pointer'; 
    // The "Needs you" panel rides on the left controller, or on the only one if it has no hand.
    if (e.data.targetRayMode === 'tracked-pointer' && e.data.handedness !== 'right') pad.add(vrPanel);
  });
  pad.addEventListener('disconnected', () => { ray.visible = false; pad.userData.aiming = false; });
  // Pointing at the lift button or the floor list, the trigger presses it, like a mouse button: it counts when
  // released on the same thing it went down on. Pointing anywhere else, it aims a jump.
  pad.addEventListener('selectstart', () => { pad.userData.aiming = true; pad.userData.pressed = pad.userData.ui; });
  pad.addEventListener('selectend', () => {
    const u = pad.userData, h = u.hit, pressed = u.pressed;
    u.aiming = false; u.hit = null; u.pressed = null;
    if (pressed) { if (pressed === u.ui) vrPress(pressed); return; }
    if (h) vrTeleport(h.x, h.z);
  });
  rig.add(pad);
  return pad;
});

// Where a ray from origin along dir meets the floor (height 0), if a person can stand there: inside the walls, not in
// furniture (the agents' walking grid already knows both), and not too far away. Else null.
function vrFloorHit(origin, dir) {
  if (dir.y > -.05) return null;   // level or up: the ray never meets the floor, or meets it far beyond reach
  const g = vrGround(), t = (g - origin.y) / dir.y, x = origin.x + dir.x * t, z = origin.z + dir.z * t;
  if (t < 0 || Math.hypot(x - origin.x, z - origin.z) > VR_REACH) return null;
  const i = ci(x), j = cj(z), grid = viewMode === 'roof' ? blockedRoof : blockedInterior;   // the rooftop has its own grid
  if (i < 0 || j < 0 || i >= NAV.W || j >= NAV.H || grid[j * NAV.W + i]) return null;
  return { x, z };
}
// Move the rig so that the head, not the middle of the play area, lands on the spot.
function vrTeleport(x, z) {
  camera.getWorldPosition(vrV);
  rig.position.x += x - vrV.x; rig.position.z += z - vrV.z;
}
// Turn the rig around the head, so the person turns on the spot and does not swing around the play area.
function vrTurn(a) {
  camera.getWorldPosition(vrV); vrV.y = 0;
  rig.position.sub(vrV).applyAxisAngle(vrUp, a).add(vrV); rig.rotation.y += a;
}
// One turn or one floor for each push of a stick. x is left-right and y is forward-back, each from -1 to 1;
// forward is negative. Only the axis pushed most counts, so a push up and a little right does not also turn.
function vrStick(source, x, y = 0) {
  let r = vrSticks.get(source); if (!r) vrSticks.set(source, r = { x: true, y: true });
  if (Math.abs(x) < .3) r.x = true;
  if (Math.abs(y) < .3) r.y = true;
  if (Math.abs(x) >= Math.abs(y)) { if (Math.abs(x) > .7 && r.x) { r.x = false; vrTurn(x > 0 ? -VR_TURN : VR_TURN); } }
  else if (Math.abs(y) > .7 && r.y) { r.y = false; vrFloor(y < 0 ? 1 : -1); }
}
function vrStep() {
  rig.updateMatrixWorld(true);
  let shown = null, hover = null;
  for (const pad of vrPads) {
    const u = pad.userData; u.hit = null;
    vrV.setFromMatrixPosition(pad.matrixWorld); vrDir.set(0, 0, -1).transformDirection(pad.matrixWorld);
    const ui = vrUiHit(vrV, vrDir);
    u.ui = ui && ui.key; if (ui && u.ray.visible) hover = ui.key;
    if (ui) { u.ray.scale.z = ui.distance; continue; }   // the ray stops on the button or the list
    if (!u.aiming) { u.ray.scale.z = 2; continue; }
    u.hit = vrFloorHit(vrV, vrDir);
    u.ray.scale.z = u.hit ? Math.hypot(u.hit.x - vrV.x, vrV.y, u.hit.z - vrV.z) : 2;
    if (u.hit) shown = u.hit;
  }
  vrRing.visible = !!shown; if (shown) vrRing.position.set(shown.x, vrGround() + .02, shown.z);
  vrLiftBtn.scale.setScalar(hover === 'lift' ? 1.12 : 1);
  if (vrMenu.visible && (hover !== vrMenu.userData.hover || performance.now() - vrMenu.userData.at > 1000)) { vrMenu.userData.hover = hover; vrDrawMenu(); }
  vrLabels();
  if (performance.now() - vrPanel.userData.at > 500) vrDrawNeeds();
  const session = renderer.xr.getSession();
  if (session) for (const s of session.inputSources) {
    const ax = s.gamepad && s.gamepad.axes;
    // xr-standard controllers put the thumbstick on axes 2 and 3; some older ones only have axes 0 and 1.
    if (ax && ax.length) vrStick(s, ax.length >= 4 ? ax[2] : ax[0], ax.length >= 4 ? ax[3] : ax[1]);
  }
  vrFadeStep();
}
function vrReset() {
  vrLiftBtn.visible = false; vrMenu.visible = false;
  vrSticks.clear(); vrFade = null; vrShade.visible = false; vrRing.visible = false; if (vrPanel.parent) vrPanel.parent.remove(vrPanel); vrPanel.userData.count = 0; vrPanel.userData.text = '';
  for (const a of agents) { a.label.scale.set(2.8, .7, 1); a.label.renderOrder = 10; }
  for (const pad of vrPads) Object.assign(pad.userData, { aiming: false, hit: null, ui: null, pressed: null });
}

/* ---------- VR: other floors ---------- */
// The view goes black for a moment, the floor changes, and the view comes back. Seeing the building slide past
// would make many people sick. You keep your spot: all floors have the same plan.
const VR_FADE = .15;   // seconds to black, and again back
const vrShade = new THREE.Mesh(new THREE.SphereGeometry(.5, 16, 12), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false }));
vrShade.visible = false; vrShade.renderOrder = 2000; scene.add(vrShade);
let vrFade = null;   // { to: floor index, at: start time, swapped }
// A place is a floor's index or 'roof'. The rooftop is the stop above the top floor.
const vrHere = () => viewMode === 'roof' ? 'roof' : curFloor.i;
function vrFloor(dir) {
  const top = floors.length - 1, here = vrHere();
  vrGoFloor(here === 'roof' ? (dir < 0 ? top : null) : here + dir > top ? 'roof' : here + dir);
}
function vrGoFloor(to) {
  if (vrFade || to === vrHere()) return;
  if (to !== 'roof' && !floors[to]) { vrBuzz(.3, 40); return; }   // no floor that way: a tiny tap instead of a black blink for nothing
  vrFade = { to, at: performance.now(), swapped: false };
}
// The height you stand at: 0 on a floor (the building moves so the floor in view is at 0), the deck on the rooftop.
const vrGround = () => viewMode === 'roof' ? building.position.y + roofGroup.position.y + ROOF_Y : 0;
// Go to a place at once (behind the black of a fade). Floor to floor keeps your spot, as every floor has the same
// plan. To or from the rooftop you step out of the lift, since the deck's furniture is not where the desks are.
function vrArrive(to) {
  const was = vrHere();
  if (to === 'roof') goRoofView(); else goToFloor(to);
  // In the normal view the building glides to the new floor; behind the black it jumps, so nothing moves on return.
  yOff = yOffTarget; building.position.y = city.position.y = yOff;
  // The page fades the roof and the upper floors in and out as the camera moves; in VR set them once for this place.
  cam.radius = goal.radius; shellT = -1; updateShell();
  const g = vrGround();
  if ((was === 'roof') !== (to === 'roof')) { camera.getWorldPosition(vrV); rig.position.x += 11.6 - vrV.x; rig.position.z += -1.8 - vrV.z; }
  rig.position.y = g;
  vrLiftBtn.position.set(to === 'roof' ? 12.27 : 12.33, g + 1.3, -.92);   // on the lift house up there, by the lift doors down here
  vrPanel.userData.at = -1e9;   // the panel shows the new place's name at once
}

/* The lift: a Floors button on the wall beside its doors, and the list of floors it opens, as the page's floor list.
   Both are VR only; on the page the floor list does this. */
const vrRaycaster = new THREE.Raycaster();
// Text in a headset is read close up: draw it at twice the canvas size (VR_RES), and filter it for steep angles,
// or it looks soft. vrCtx gives a 2D context that still takes the sizes below in the canvas's own units.
const VR_RES = 2;
const vrTexture = c => { const t = new THREE.CanvasTexture(c); t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t; };
const vrCtx = c => { const x = c.getContext('2d'); x.setTransform(VR_RES, 0, 0, VR_RES, 0, 0); return x; };
const vrCanvasPlane = (w, h, cw, ch) => {
  const c = document.createElement('canvas'); c.width = cw * VR_RES; c.height = ch * VR_RES;
  const t = vrTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
  Object.assign(m.userData, { c, t }); return m;
};
const vrLiftBtn = (() => {
  const m = vrCanvasPlane(.3, .3, 256, 256), x = vrCtx(m.userData.c);
  x.fillStyle = 'rgba(18,26,30,.95)'; rrect(x, 8, 8, 240, 240, 40); x.fill();
  x.strokeStyle = '#7cf0ff'; x.lineWidth = 6; rrect(x, 8, 8, 240, 240, 40); x.stroke();
  x.fillStyle = '#7cf0ff';   // up and down arrows, like a lift's call buttons
  x.beginPath(); x.moveTo(128, 40); x.lineTo(168, 92); x.lineTo(88, 92); x.fill();
  x.beginPath(); x.moveTo(128, 160); x.lineTo(168, 108); x.lineTo(88, 108); x.fill();
  x.fillStyle = '#E2EAED'; x.font = '700 44px "Bricolage Grotesque", sans-serif'; x.textAlign = 'center'; x.fillText('Floors', 128, 222);
  m.userData.t.needsUpdate = true;
  // On the wall to the right of the lift doors, at hand height, facing into the office.
  m.position.set(12.33, 1.3, -.92); m.rotation.y = -Math.PI / 2; m.visible = false; m.userData.key = 'lift';
  scene.add(m); return m;
})();
const VR_MENU_W = .5, VR_MENU_H = .5 * 720 / 512, VR_MENU_ROWS = 8;   // metres, for a 512 × 720 canvas
const vrMenu = (() => {
  const m = vrCanvasPlane(VR_MENU_W, VR_MENU_H, 512, 720);
  // Drawn over everything, so a wall or the lift never hides part of it when it opens close to them.
  m.material.depthTest = false; m.renderOrder = 1000;
  // Placed in front of you each time it opens (see vrOpenMenu); it grows down from its top edge.
  const g = new THREE.Group(); g.add(m); g.visible = false;
  Object.assign(g.userData, { m, rows: [], H: 640, hover: null, at: -1e9 });
  scene.add(g); return g;
})();
function vrDrawMenu() {
  const u = vrMenu.userData, m = u.m; u.at = performance.now();
  // Top floor first, as in the page's list. With many floors, the ones around yours.
  let list = floors.map(f => f.i).sort((p, q) => q - p);
  if (list.length > VR_MENU_ROWS) { const k = list.indexOf(curFloor.i), from = clamp(k - (VR_MENU_ROWS >> 1), 0, list.length - VR_MENU_ROWS); list = list.slice(from, from + VR_MENU_ROWS); }
  list.unshift('roof');   // the rooftop always heads the list, as it sits on top of the building
  const H = 72 + list.length * 60 + 72, f = H / 720;
  m.userData.t.repeat.y = f; m.userData.t.offset.y = 1 - f; m.scale.y = f; m.position.y = -VR_MENU_H * f / 2;   // grows down from the top
  const x = vrCtx(m.userData.c); x.clearRect(0, 0, 512, 720);
  x.fillStyle = 'rgba(18,26,30,.95)'; rrect(x, 4, 4, 504, H - 8, 28); x.fill();
  x.fillStyle = '#E2EAED'; x.font = '700 34px "Bricolage Grotesque", sans-serif'; x.fillText('Go to a floor', 28, 52);
  u.rows = [];
  list.forEach((i, n) => {
    const roof = i === 'roof', fl = roof ? null : floors[i], y0 = 72 + n * 60, key = roof ? 'roof' : 'floor:' + i, here = i === vrHere();
    const waiting = agents.filter(a => a.state === 'waiting' && !a.gone && (roof ? a.onRoof : !a.onRoof && (a.parent || a).floor === fl)).length;
    if (here || u.hover === key) { x.fillStyle = here ? 'rgba(124,240,255,.16)' : 'rgba(255,255,255,.1)'; rrect(x, 14, y0 + 4, 484, 52, 14); x.fill(); }
    x.fillStyle = '#E2EAED'; x.font = '600 26px "IBM Plex Sans", sans-serif'; if (!roof) x.fillText(`${floorNum(fl)}`, 30, y0 + 40);
    x.fillText(fitText(x, roof ? 'Rooftop' : fl.name, 260), 96, y0 + 40);
    const note = here ? 'You are here' : waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : '';
    x.fillStyle = here || !waiting ? '#8C9DA5' : STATUS.waiting.hex; x.font = '400 20px "IBM Plex Sans", sans-serif';
    x.textAlign = 'right'; x.fillText(note, 482, y0 + 38); x.textAlign = 'left';
    u.rows.push({ key, note, y0, y1: y0 + 60 });
  });
  const c0 = H - 72;
  if (u.hover === 'close') { x.fillStyle = 'rgba(255,255,255,.1)'; rrect(x, 14, c0 + 8, 484, 52, 14); x.fill(); }
  x.fillStyle = '#8C9DA5'; x.font = '600 24px "IBM Plex Sans", sans-serif'; x.textAlign = 'center'; x.fillText('Close', 256, c0 + 44); x.textAlign = 'left';
  u.rows.push({ key: 'close', y0: c0, y1: H }); u.H = H;
  m.userData.t.needsUpdate = true;
  vrMenu.updateMatrixWorld(true);   // moved or resized just now: pointing at it must work before the next frame draws
}
// What a controller points at: the lift button, a row of the floor list, or the list's empty parts. Else null.
function vrUiHit(origin, dir) {
  // While the list is open it is the only thing to press: opened at the lift, the Floors button can sit in front of
  // its rows, and a press meant for a row would close the list instead.
  const targets = vrMenu.visible ? [vrMenu.userData.m] : vrLiftBtn.visible ? [vrLiftBtn] : [];
  if (!targets.length) return null;
  vrRaycaster.set(origin, dir); vrRaycaster.far = VR_REACH;
  const [h] = vrRaycaster.intersectObjects(targets, false);
  if (!h) return null;
  if (h.object === vrLiftBtn) return { key: 'lift', distance: h.distance };
  const u = vrMenu.userData, cy = (1 - h.uv.y) * u.H, row = u.rows.find(r => cy >= r.y0 && cy < r.y1);
  return { key: row ? row.key : 'menu', distance: h.distance };
}
// Open the floor list a comfortable reading distance in front of you, its top just below eye height, turned to face
// you. It stays put after that: a panel that follows the head is tiring to read.
function vrOpenMenu() {
  camera.getWorldPosition(vrV); camera.getWorldDirection(vrDir); vrDir.y = 0;
  if (vrDir.lengthSq() < 1e-6) vrDir.set(0, 0, -1); vrDir.normalize();
  vrMenu.position.set(vrV.x + vrDir.x * .9, vrV.y + .05, vrV.z + vrDir.z * .9);
  vrMenu.rotation.set(0, Math.atan2(-vrDir.x, -vrDir.z), 0);
  vrMenu.visible = true; vrDrawMenu();
}
function vrPress(key) {
  if (key === 'lift') { if (vrMenu.visible) vrMenu.visible = false; else vrOpenMenu(); return; }
  if (key === 'close') { vrMenu.visible = false; return; }
  if (key === 'roof') { vrMenu.visible = false; vrGoFloor('roof'); }
  if (key.startsWith('floor:')) { vrMenu.visible = false; vrGoFloor(+key.slice(6)); }
}
function vrFadeStep() {
  if (!vrFade) return;
  const t = (performance.now() - vrFade.at) / 1000;
  if (!vrFade.swapped && t >= VR_FADE) { vrArrive(vrFade.to); vrFade.swapped = true; }
  const k = t < VR_FADE ? t / VR_FADE : 1 - (t - 2 * VR_FADE) / VR_FADE;   // in, hold one step at black, out
  vrShade.material.opacity = clamp(k, 0, 1);
  camera.getWorldPosition(vrShade.position); vrShade.visible = true;
  if (t >= 3 * VR_FADE) { vrFade = null; vrShade.visible = false; }
}

/* ---------- VR: reading the office ---------- */
// The panels and toasts are part of the page, which a headset does not show. In VR the name tags over the agents and a
// small "Needs you" panel over the left controller, like a watch, give the same news.

// A tag keeps its normal size up close and grows up to 2.5 times far away, so a tag across the floor stays readable.
function vrLabels() {
  camera.getWorldPosition(vrV);
  for (const a of agents) {
    if (!a.label.visible) continue;
    a.label.getWorldPosition(vrDir);
    const d = vrV.distanceTo(vrDir), k = clamp(d / 6, 1, 2.5);
    a.label.scale.set(2.8 * k, .7 * k, 1);
    // Tags draw over walls and furniture, so a far tag could cover a near one. Draw the nearer tag last, on top.
    a.label.renderOrder = 10 + Math.round(clamp(100 - d, 0, 100) * 10);   // 10 cm steps
  }
}

// The same agents as the "Needs you" strip: every one waiting on you, on any floor, oldest first.
const VR_PANEL_W = .24, VR_PANEL_H = .24 * 448 / 512;   // metres, for a 512 × 448 canvas
const vrPanel = (() => {
  const c = document.createElement('canvas'); c.width = 512 * VR_RES; c.height = 448 * VR_RES;
  const t = vrTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(VR_PANEL_W, VR_PANEL_H), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
  // Above the controller and tipped toward the face: look at your wrist to read it. The panel grows up from here.
  const g = new THREE.Group(); g.position.set(0, .03, .03); g.rotation.x = -.6; g.add(m);
  Object.assign(g.userData, { c, t, m, at: -1e9, count: 0, text: '' });
  return g;
})();
function vrDrawNeeds() {
  const u = vrPanel.userData; u.at = performance.now();
  const list = agents.filter(a => a.state === 'waiting' && !a.gone).sort((p, q) => (p.waitingSince || 0) - (q.waitingSince || 0));
  const title = !list.length ? 'Nothing needs you' : list.length === 1 ? '1 agent needs you' : `${list.length} agents need you`;
  const rows = list.slice(0, 4).map(a => {
    const s = a.parent || a, floor = s.floor && s.floor.name;
    return { name: a.name, where: [floor, a.waitingSince ? 'waiting ' + ago(a.waitingSince) : ''].filter(Boolean).join(' · '), what: a.activity || 'Waiting for you' };
  });
  // The first line says where you are, as the floor list does on the page.
  const here = viewMode === 'roof' ? 'Rooftop' : curFloor ? `Floor ${floorNum(curFloor)} · ${curFloor.name}` : '';
  const text = [here, title, ...rows.map(r => `${r.name}|${r.where}|${r.what}`), list.length > 4 ? `+${list.length - 4}` : ''].join('\n');
  // A new agent waiting: a short buzz in the hand, as the page plays a chime.
  if (list.length > u.count) vrBuzz();
  u.count = list.length;
  if (text === u.text) return;
  u.text = text;
  // Only as tall as what it shows: a title alone is a slim bar, not a big empty card.
  const more = list.length > 4, top = 44, H = top + (rows.length ? 96 + rows.length * 64 : 92) + (more ? 40 : 0), f = H / 448;
  u.t.repeat.y = f; u.t.offset.y = 1 - f; u.m.scale.y = f; u.m.position.y = VR_PANEL_H * f / 2;
  const x = vrCtx(u.c); x.clearRect(0, 0, 512, 448);
  x.fillStyle = 'rgba(18,26,30,.92)'; rrect(x, 4, 4, 504, H - 8, 28); x.fill();
  x.fillStyle = '#8C9DA5'; x.font = '400 22px "IBM Plex Sans", sans-serif'; x.fillText(fitText(x, here, 456), 28, 40);
  x.fillStyle = list.length ? STATUS.waiting.hex : STATUS.done.hex; x.beginPath(); x.arc(40, top + 46, 12, 0, 7); x.fill();
  x.fillStyle = '#E2EAED'; x.font = '700 34px "Bricolage Grotesque", sans-serif'; x.fillText(fitText(x, title, 430), 64, top + 58);
  rows.forEach((r, i) => {
    const y = top + 112 + i * 64;
    x.fillStyle = '#E2EAED'; x.font = '600 26px "IBM Plex Sans", sans-serif'; x.fillText(fitText(x, r.name, 240), 28, y);
    x.fillStyle = '#8C9DA5'; x.font = '400 22px "IBM Plex Sans", sans-serif'; x.fillText(fitText(x, r.where, 200), 284, y);
    x.fillText(fitText(x, r.what, 456), 28, y + 28);
  });
  if (more) { x.fillStyle = '#8C9DA5'; x.font = '400 22px "IBM Plex Sans", sans-serif'; x.fillText(`and ${list.length - 4} more`, 28, H - 22); }
  u.t.needsUpdate = true;
}
function vrBuzz(strength = .6, ms = 120) {
  const session = renderer.xr.getSession(); if (!session) return;
  for (const s of session.inputSources) {
    const h = s.gamepad && s.gamepad.hapticActuators && s.gamepad.hapticActuators[0];
    if (h && h.pulse) h.pulse(strength, ms).catch(() => {});
  }
}
