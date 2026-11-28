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
      renderer.xr.enabled = false; sun.castShadow = true; rig.position.set(0, 0, 0); rig.rotation.y = 0; layout();
    });
    await renderer.xr.setSession(session);
    // Stand in the aisle of the floor in view. The building moves so that this floor is always at height 0.
    rig.position.set(2.5, 0, 0.5); rig.rotation.y = 0; camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
  } catch (_) {
    if (session) session.end().catch(() => {});   // a session that opened but failed to draw would leave the headset black
    toast('The headset did not start VR. Put the headset on, then select Enter VR again.');
  } finally { vrBusy = false; }
};

/* ---------- layout ---------- */
// Collapsible rail + side panel. Per-viewer convenience, so it's kept in localStorage.
const appEl = $('#app'), liftEl = $('#lift');
// Every open office tab reads these settings once, at start. If a tab saved its whole copy, an older tab would put back
// what another tab changed since: pick Seoul in one tab, hide the floors in an older one, and the next start shows
// the older tab's city. So each tab notes which settings it changed and saves only those, over what is stored now.
const readUi = () => { try { const v = JSON.parse(localStorage.getItem('agent-office:ui')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_) { return {}; } };
const uiChanged = new Set();
const uiPrefs = new Proxy(readUi(), {
  set(o, k, v) { o[k] = v; uiChanged.add(k); return true; },
  deleteProperty(o, k) { delete o[k]; uiChanged.add(k); return true; },
});
const saveUi = () => {
  const stored = readUi();
  for (const k of uiChanged) { if (Object.hasOwn(uiPrefs, k)) stored[k] = uiPrefs[k]; else delete stored[k]; }
  try { localStorage.setItem('agent-office:ui', JSON.stringify(stored)); uiChanged.clear(); } catch (_) {}
};
const panelOpen = () => isMobile() ? !panel.classList.contains('collapsed') : !appEl.classList.contains('panel-off');
function setPanelOpen(open) {
  if (isMobile()) { panel.classList.toggle('collapsed', !open); cardFolded = false; }
  else { appEl.classList.toggle('panel-off', !open); $('#panel-show').hidden = open; panel.inert = !open; }
  uiPrefs.panel = open; saveUi(); layout();
}
function setLiftOpen(open) {
  liftEl.classList.toggle('collapsed', !open);
  const b = $('#lift-toggle'); b.setAttribute('aria-expanded', open); b.setAttribute('aria-label', open ? 'Hide floors' : 'Show floors'); b.title = open ? 'Hide floors  [' : 'Show floors  [';
  uiPrefs.lift = open; saveUi();
  if (open) liftToCurrent();
}
$('#lift-toggle').onclick = () => setLiftOpen(liftEl.classList.contains('collapsed'));
$('#lift-current').onclick = () => setLiftOpen(true);
$('#panel-hide').onclick = () => setPanelOpen(isMobile() ? panel.classList.contains('collapsed') : false);   // on a phone it folds the sheet up and down
$('#panel-show').onclick = () => setPanelOpen(true);
// the camera's framing slides over when the panel opens or closes instead of jumping
const vo = { x: 0, y: 0, tx: 0, ty: 0, w: 1, h: 1, init: false };
function applyViewOffset() { camera.setViewOffset(vo.w, vo.h, vo.x, vo.y, vo.w, vo.h); camera.updateProjectionMatrix(); }
// On a phone the card (top) and the agent list (bottom) would cover the whole scene, so the list folds away while a card is open.
let cardFolded = false;
function fitCardOnPhone() {
  if (isMobile()) {
    if (selected && !panel.classList.contains('collapsed')) { panel.classList.add('collapsed'); cardFolded = true; }
    else if (!selected && cardFolded) { panel.classList.remove('collapsed'); cardFolded = false; }
  }
  layout();
}
function layout() {
  const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  let ox = 0, oy = 0;
  if (isMobile()) {
    const st = stage.getBoundingClientRect(), pr = panel.getBoundingClientRect(), folded = panel.classList.contains('collapsed'), hb = $('#panel-hide');
    hb.setAttribute('aria-label', folded ? 'Show the panel' : 'Fold the panel down'); hb.title = hb.getAttribute('aria-label');
    if (detail.hidden) oy = Math.max(0, pr.height / 2 - 24);
    else oy = h / 2 - (detail.getBoundingClientRect().bottom + pr.top) / 2 + st.top;   // centre the view in the gap between card and list
  }
  else { ox = appEl.classList.contains('panel-off') ? 0 : (panel.offsetWidth + 16) / 2; const hb = $('#panel-hide'); hb.setAttribute('aria-label', 'Hide panel'); hb.title = 'Hide panel  ]'; }
  vo.zoomed = viewMode === 'screen'; if (vo.zoomed) ({ ox, oy } = screenFrame(w, h));
  Object.assign(vo, { tx: ox, ty: oy, w, h });
  if (!vo.init || reduced) { vo.x = ox; vo.y = oy; vo.init = true; }
  applyViewOffset();
}
new ResizeObserver(layout).observe(stage);
addEventListener('resize', layout);
