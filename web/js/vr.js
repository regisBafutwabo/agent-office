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
    // Stand in the aisle of the floor in view. The building moves so that this floor is always at height 0.
    rig.position.set(2.5, 0, 0.5); rig.rotation.y = 0; camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
  } catch (_) {
    if (session) session.end().catch(() => {});   // a session that opened but failed to draw would leave the headset black
    toast('The headset did not start VR. Put the headset on, then select Enter VR again.');
  } finally { vrBusy = false; }
};

/* ---------- VR: moving with the controllers ---------- */
// Teleport and snap turns, not smooth walking or smooth turning: those make many people sick in a headset.
// Hold the trigger to aim at the floor, let go to jump there. Push a thumbstick left or right to turn 30 degrees.
const VR_TURN = Math.PI / 6, VR_REACH = 10;   // one snap turn; the farthest jump in metres
const vrV = new THREE.Vector3(), vrDir = new THREE.Vector3(), vrUp = new THREE.Vector3(0, 1, 0);
const vrSticks = new Map();   // input source → is the stick back near the middle, so that the next push turns again
const vrRing = new THREE.Mesh(new THREE.RingGeometry(.2, .28, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7cf0ff, transparent: true, opacity: .85, depthTest: false }));
vrRing.visible = false; vrRing.renderOrder = 10; scene.add(vrRing);
const vrPads = [0, 1].map(i => {
  const pad = renderer.xr.getController(i);
  const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0x7cf0ff, transparent: true, opacity: .6 }));
  ray.visible = false; pad.add(ray);
  Object.assign(pad.userData, { ray, aiming: false, hit: null });
  // Only a controller has a ray. A gaze or a screen tap points from the head and would draw a line through the eyes.
  pad.addEventListener('connected', e => { ray.visible = e.data.targetRayMode === 'tracked-pointer'; });
  pad.addEventListener('disconnected', () => { ray.visible = false; pad.userData.aiming = false; });
  pad.addEventListener('selectstart', () => { pad.userData.aiming = true; });
  pad.addEventListener('selectend', () => { const h = pad.userData.hit; pad.userData.aiming = false; pad.userData.hit = null; if (h) vrTeleport(h.x, h.z); });
  rig.add(pad);
  return pad;
});

// Where a ray from origin along dir meets the floor (height 0), if a person can stand there: inside the walls, not in
// furniture (the agents' walking grid already knows both), and not too far away. Else null.
function vrFloorHit(origin, dir) {
  if (dir.y > -.05) return null;   // level or up: the ray never meets the floor, or meets it far beyond reach
  const t = -origin.y / dir.y, x = origin.x + dir.x * t, z = origin.z + dir.z * t;
  if (Math.hypot(x - origin.x, z - origin.z) > VR_REACH) return null;
  const i = ci(x), j = cj(z);
  if (i < 0 || j < 0 || i >= NAV.W || j >= NAV.H || blockedInterior[j * NAV.W + i]) return null;
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
// One turn for each push of a stick. x is the stick's left-right value, from -1 to 1.
function vrStick(source, x) {
  const ready = vrSticks.get(source) !== false;
  if (Math.abs(x) < .3) { vrSticks.set(source, true); return; }
  if (Math.abs(x) > .7 && ready) { vrSticks.set(source, false); vrTurn(x > 0 ? -VR_TURN : VR_TURN); }
}
function vrStep() {
  rig.updateMatrixWorld(true);
  let shown = null;
  for (const pad of vrPads) {
    const u = pad.userData; u.hit = null;
    if (!u.aiming) { u.ray.scale.z = 2; continue; }
    vrV.setFromMatrixPosition(pad.matrixWorld); vrDir.set(0, 0, -1).transformDirection(pad.matrixWorld);
    u.hit = vrFloorHit(vrV, vrDir);
    u.ray.scale.z = u.hit ? Math.hypot(u.hit.x - vrV.x, vrV.y, u.hit.z - vrV.z) : 2;
    if (u.hit) shown = u.hit;
  }
  vrRing.visible = !!shown; if (shown) vrRing.position.set(shown.x, .02, shown.z);
  const session = renderer.xr.getSession();
  if (session) for (const s of session.inputSources) {
    const ax = s.gamepad && s.gamepad.axes;
    // xr-standard controllers put the thumbstick on axes 2 and 3; some older ones only have axes 0 and 1.
    if (ax && ax.length) vrStick(s, ax.length >= 4 ? ax[2] : ax[0]);
  }
}
function vrReset() {
  vrSticks.clear(); vrRing.visible = false;
  for (const pad of vrPads) { pad.userData.aiming = false; pad.userData.hit = null; }
}
