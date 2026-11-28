/* ---------- demo mode: simulated agents ---------- */
function startDemo() {
  if (live.demoStarted) return; live.demoStarted = true; MODE = 'demo';
  document.body.classList.remove('live');
  PROJECTS.forEach((p, i) => { if (i === 0) Object.assign(floors[0], { key: p.key, name: p.key, placeholder: false }); else makeFloor(p.key, p.key); });
  // [project, name, desk, colour, works at]: two floors have a pair of sessions working side by side
  const LOOKS = {
    Ada: { body: 'round', face: 'classic', trim: '#15212A', accent: '#E4572E', accessories: ['headphones'] },
    Max: { body: 'compact', face: 'pixel', trim: '#F4F1EA', accent: '#FFB400', accessories: ['glasses', 'backpack'] },
    Kit: { body: 'tall', face: 'pixel', trim: '#F4F1EA', accent: '#15212A', accessories: ['cap'] },
    Nova: { body: 'compact', face: 'anime', trim: '#15212A', accent: '#B16AD9', accessories: ['beanie', 'scarf'] },
    Iris: { body: 'tall', face: 'anime', trim: '#F4F1EA', accent: '#FFB400', accessories: ['antenna', 'backpack'] },
    Reno: { body: 'round', face: 'minimal', trim: '#15212A', accent: '#F4F1EA', accessories: ['glasses', 'mug'] },
  };
  [[0, 'Ada', 0, null, 'anywhere'], [0, 'Max', 6, '#A78BFA', 'anywhere'], [1, 'Kit', 9, null, 'anywhere'],
   [2, 'Nova', 0, null, 'lounge'], [2, 'Iris', 15, '#EE6C9F', 'anywhere'], [3, 'Reno', 6, null, 'anywhere']].forEach(([pi, name, seat, color, pref]) => {
    const p = PROJECTS[pi], floor = floors[pi], home = floor.deskSeats[seat];
    const a = createAgent({ name, kind: 'main', color: color || p.color, home, project: p, pref, floor, look: { ...LOOKS[name], intern: false } });
    home.by = a.id; home.owner = a;
    a.spot = home; a.where = 'Own desk'; a.g.position.set(home.x, 0, home.z); a.yaw = a.yawT = yawOf(home.face);
    setState(a, 'idle', 'Session started');
  });
  PROJECTS.forEach((p, i) => {                                // so the demo desks already have a past
    const DAY = 864e5, now = Date.now(); let d = remember({ ...emptyDesk(), dayCount: [2, 9, 16, 31][i % 4] }, 'team', now - 20 * DAY);
    for (let k = [1, 3, 6, 0][i % 4]; k > 0; k--) d = remember(d, 'merge', now - (k * 2 + 2) * DAY);
    demoDesks.set(p.key, i % 2 ? remember(d, 'unstuck', now - 3 * DAY, 4) : d);
  });
  curFloor = floors[floors.length - 1]; yOffTarget = yOff = -curFloor.i * FLOOR_H; rebuildTower(); refreshFloorVisuals();
  buildCustomize(); setModeLine(); goBuilding();
  agents.filter(a => a.kind === 'main').forEach(mainLoop);
}

// Browsers pause animation in background tabs. When the office comes back into view,
// finish any walks that were in progress instead of replaying them slowly.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = performance.now(); return; }
  if (performance.now() - hiddenAt < 3000) return;
  for (const a of agents.slice()) {
    if (!a.path.length) continue;
    const end = a.path[a.path.length - 1]; a.g.position.x = end.x; a.g.position.z = end.y; a.path.length = 0;
    if (a.arrive) { const f = a.arrive; a.arrive = null; f(); }
  }
});
/* ---------- boot ---------- */
window.agentOffice = { agents, SPOTS, DOOR, camera };   // for debugging from the console
curFloor = makeFloor('lobby', 'Your first project', true); rebuildTower();
setLiftOpen(uiPrefs.lift !== false); if (uiPrefs.panel === false) setPanelOpen(false);
showDetailTab(uiPrefs.detailTab === 'activity' ? 'activity' : 'chat');
setShowLabels(uiPrefs.labels !== false); setGridVisible(uiPrefs.grid === true);
applyScene(uiPrefs.theme in SCENES ? uiPrefs.theme : 'auto'); buildCustomize(); layout(); loadPacks();
if (Object.hasOwn(CITIES, uiPrefs.city)) setCity(uiPrefs.city);
setView('3d'); Object.assign(cam, { theta: goal.theta, phi: goal.phi, radius: goal.radius }); cam.target.copy(goal.target); applyCam();
if (MODE === 'demo' || !/^https?:$/.test(location.protocol)) startDemo(); else officeAuth.ready.then(connectLive);
syncCrewButtons();
if (!uiPrefs.guideDone && !uiPrefs.crew) openWelcome();
else if (!Object.hasOwn(CITIES, uiPrefs.city)) { tourAfterCity = !uiPrefs.guideDone || params.has('tour'); $('#city-picker').showModal(); $('#city-choices [aria-pressed="true"]')?.focus(); }
else if (!uiPrefs.guideDone || params.has('tour')) startGuide(Number.isInteger(uiPrefs.guideStep) ? uiPrefs.guideStep : 0);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { agents.forEach(a => a.labelDirty = true); floorLabels.forEach(l => l.draw()); screensDirty = true; drawNeon(); floors.forEach(f => drawSign(f, true)); });

setGroupBy(groupBy());   // here, not in ui.js: uiPrefs comes from layout.js, and a timer there could fire before it loaded
let last = performance.now(), uiT = 0;
let screenT = 0;
function step(dt) {
  if (Math.abs(vo.x - vo.tx) > .3 || Math.abs(vo.y - vo.ty) > .3) { const k = 1 - Math.exp(-dt * 9); vo.x += (vo.tx - vo.x) * k; vo.y += (vo.ty - vo.y) * k; applyViewOffset(); }
  if ((viewMode === 'screen') !== !!vo.zoomed) layout();            // entering or leaving a screen reframes the view
  const sdt = dt * speed; simTime += sdt; tickTimers();
  if (MODE === 'live') liveTick(dt);
  stepFlight(dt); if (!flight || flight.landing) skyDome.position.y = 0;
  yOff += (yOffTarget - yOff) * (reduced ? 1 : 1 - Math.exp(-dt * 5)); building.position.y = city.position.y = yOff;
  floorGlow();
  updateCafe(sdt); for (const a of agents.slice()) updateAgent(a, dt, sdt);
  updateHoops(dt); updateArcade(dt); updateParty(dt); updateClashes(); updateFx(dt); updateDust(sdt); if (deskDirty) drawDesks();
  { let want = 0; for (const a of agents) if (a.floor === curFloor && !a.onRoof && Math.hypot(a.g.position.x - 12.6, a.g.position.z + 1.8) < 1.9) want = 1;
    lift.open += (want - lift.open) * (1 - Math.exp(-dt * 6));
    lift.l.position.z = -1.8 - .275 - lift.open * .5; lift.r.position.z = -1.8 + .275 + lift.open * .5;
    lift.lamp.color.set(want ? '#59CD90' : '#2A3238'); }
  screenT += dt; if (screensDirty || screenT > .5) { drawScreens(screensDirty); screensDirty = false; screenT = 0; }
  let n = 0; for (const a of agents) if (a.labelDirty && n < 4) { drawLabel(a); n++; }
  if (!renderer.xr.isPresenting) { keyPan(dt); updateCam(dt); updateShell(); }
  uiT += dt;
  if (uiT > .15) { uiT = 0; if (uiDirty) renderUI(); if (detailDirty) renderDetail(); }
  if (selected && selected.approval) { const ap = selected.approval, tEl = $('#d-perm-timer');
    const txt = ap.live ? `Claude Code asks you itself in ${Math.max(0, Math.ceil((ap.expiresAt - Date.now()) / 1000))}s` : `Demo auto-approves in ${Math.max(0, Math.ceil(ap.deadline - simTime))}s`;
    if (tEl.textContent !== txt) tEl.textContent = txt; }
}
let hiddenFrames = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(.05, (now - last) / 1000); last = now;
  if (!window.agentOffice.held) step(dt);
  if (!review.open || ++hiddenFrames % 30 === 0) renderer.render(scene, camera);   // the review window covers the office: a frame now and then is enough
});
// Advance simulation independently of the frame loop, even in a background tab.
// Set `held = true` to keep the clock still between manual steps.
window.agentOffice.advance = async seconds => {
  for (let t = 0; t < seconds; t += .05) {
    step(.05);
    for (let k = 0; k < 6; k++) await null;
  }
};
