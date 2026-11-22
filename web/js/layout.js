/* ---------- VR ---------- */
$('#vr-btn').onclick = async () => {
  if (!navigator.xr) { toast('This browser has no WebXR. Open the office in your headset browser to walk around in VR.'); return; }
  try {
    const ok = await navigator.xr.isSessionSupported('immersive-vr');
    if (!ok) { toast('No headset found here. On Quest or Vision Pro, open this page in the headset browser.'); return; }
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    rig.position.set(2.5, 0, 0.5); rig.rotation.y = 0; camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
    session.addEventListener('end', () => { renderer.xr.enabled = false; rig.position.set(0, 0, 0); layout(); });
  } catch (err) { toast('VR is blocked inside this preview. It will open from the local build on your network.'); }
};

/* ---------- layout ---------- */
// Collapsible rail + side panel. Per-viewer convenience, so it's kept in localStorage.
const appEl = $('#app'), liftEl = $('#lift');
const uiPrefs = (() => { try { return JSON.parse(localStorage.getItem('agent-office:ui')) || {}; } catch (_) { return {}; } })();
const saveUi = () => { try { localStorage.setItem('agent-office:ui', JSON.stringify(uiPrefs)); } catch (_) {} };
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
