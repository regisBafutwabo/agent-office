import { test, expect, open } from './office.mjs';

// No headset and no WebXR runtime on test machines, so each test puts a fake navigator.xr in the page before it loads.
// It runs in the page, so it gets its mode as an argument. The fake does just enough for three.js to start and end a
// session and to see controllers. It never draws a frame, so the tests call vrStep() for one and place the controllers
// by hand. They check what the office does, not what a headset shows: docs/vr.md tells how to check that in an emulator.
const fakeXr = mode => {
  window.__xr = { ended: 0 };
  if (mode === 'none') { Object.defineProperty(navigator, 'xr', { value: undefined, configurable: true }); return; }
  class FakeSession extends EventTarget {
    inputSources = [];
    // A controller as a Quest reports it: thumbstick left-right on axes[2].
    addPad(handedness) {
      const source = { handedness, targetRayMode: 'tracked-pointer', gamepad: { axes: [0, 0, 0, 0], buttons: [] } };
      this.inputSources.push(source);
      this.dispatchEvent(Object.assign(new Event('inputsourceschange'), { added: [source], removed: [] }));
      return source;
    }
    press(type, source) { this.dispatchEvent(Object.assign(new Event(type), { inputSource: source })); }
    updateRenderState() {}
    async requestReferenceSpace() { return {}; }
    requestAnimationFrame() { return 1; }
    cancelAnimationFrame() {}
    async end() { window.__xr.ended++; this.dispatchEvent(new Event('end')); }
  }
  window.XRWebGLLayer = class { constructor() { if (mode === 'no-layer') throw new Error('no layer'); this.framebuffer = null; this.framebufferWidth = 2; this.framebufferHeight = 2; } };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) if (C) C.prototype.makeXRCompatible = async () => {};
  Object.defineProperty(navigator, 'xr', { configurable: true, value: {
    isSessionSupported: async () => mode !== 'unsupported',
    requestSession: async () => { if (mode === 'refused') throw new Error('refused'); return (window.__xr.session = new FakeSession()); },
  } });
};
const enter = page => page.locator('#vr-btn').click();
const toastWith = (page, text) => page.locator('.toast', { hasText: text });

test('Enter VR in a browser without VR says to use the headset browser', async ({ page, office }) => {
  await page.addInitScript(fakeXr, 'none');
  await open(page, office);
  await expect(page.locator('#vr-btn')).toContainText('beta');
  await enter(page);
  await expect(toastWith(page, 'This browser cannot show VR')).toBeVisible();
});

test('Enter VR with no headset connected says how to connect a Quest', async ({ page, office }) => {
  await page.addInitScript(fakeXr, 'unsupported');
  await open(page, office);
  await enter(page);
  await expect(toastWith(page, 'No VR headset found')).toBeVisible();
  expect(await page.evaluate(() => renderer.xr.isPresenting)).toBe(false);
});

test('a headset that refuses to start VR gives a plain message', async ({ page, office }) => {
  await page.addInitScript(fakeXr, 'refused');
  await open(page, office);
  await enter(page);
  await expect(toastWith(page, 'The headset did not start VR')).toBeVisible();
  expect(await page.evaluate(() => renderer.xr.enabled)).toBe(false);
});

test('a session that opens but cannot draw is closed again, so the headset is not left black', async ({ page, office }) => {
  await page.addInitScript(fakeXr, 'no-layer');
  await open(page, office);
  await enter(page);
  await expect(toastWith(page, 'The headset did not start VR')).toBeVisible();
  expect(await page.evaluate(() => ({ ended: __xr.ended, xr: renderer.xr.enabled, shadow: sun.castShadow }))).toEqual({ ended: 1, xr: false, shadow: true });
});

test('entering VR puts you on the floor without soft shadows, and leaving gives the normal view back', async ({ page, office }) => {
  await page.addInitScript(fakeXr, 'ok');
  await open(page, office);
  await enter(page);
  await expect.poll(() => page.evaluate(() => renderer.xr.isPresenting)).toBe(true);
  expect(await page.evaluate(() => ({ shadow: sun.castShadow, x: rig.position.x, y: rig.position.y }))).toEqual({ shadow: false, x: 2.5, y: 0 });
  await enter(page);   // a second press while in VR must not ask for another session
  expect(await page.evaluate(() => __xr.ended)).toBe(0);

  await page.evaluate(() => __xr.session.end());
  await expect.poll(() => page.evaluate(() => renderer.xr.isPresenting)).toBe(false);
  expect(await page.evaluate(() => ({ shadow: sun.castShadow, x: rig.position.x, xr: renderer.xr.enabled }))).toEqual({ shadow: true, x: 0, xr: false });
  // The page draws again on its own once the headset session is over.
  const f0 = await page.evaluate(() => renderer.info.render.frame);
  await expect.poll(() => page.evaluate(() => renderer.info.render.frame)).toBeGreaterThan(f0);
});

// Enter VR with one controller. The head is 1.6 m up; the controller is at hip height in front and points 45° down.
const enterWithPad = async (page, office) => {
  await page.addInitScript(fakeXr, 'ok');
  await open(page, office);
  await enter(page);
  await expect.poll(() => page.evaluate(() => renderer.xr.isPresenting)).toBe(true);
  await page.evaluate(() => {
    __xr.pad = __xr.session.addPad('right');
    camera.position.set(0, 1.6, 0);
    renderer.xr.getController(0).matrix.compose(new THREE.Vector3(.2, 1.1, -.3), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 4, 0, 0)), new THREE.Vector3(1, 1, 1));
  });
};
const head = page => page.evaluate(() => { const v = camera.getWorldPosition(new THREE.Vector3()); return { x: v.x, z: v.z }; });

test('hold the trigger to aim at the floor, let go to jump there', async ({ page, office }) => {
  await enterWithPad(page, office);
  const aim = await page.evaluate(() => { __xr.session.press('selectstart', __xr.pad); vrStep(); return { ring: vrRing.visible, x: vrRing.position.x, z: vrRing.position.z }; });
  expect(aim.ring).toBe(true);
  await page.evaluate(() => __xr.session.press('selectend', __xr.pad));
  const h = await head(page);
  expect(h.x).toBeCloseTo(aim.x, 5); expect(h.z).toBeCloseTo(aim.z, 5);
  expect(await page.evaluate(() => { vrStep(); return vrRing.visible; })).toBe(false);
});

test('a jump lands only where a person can stand', async ({ page, office }) => {
  await open(page, office);
  const r = await page.evaluate(() => {
    const hit = (x, y, z, dx, dy, dz) => vrFloorHit(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, dy, dz).normalize());
    // A cell in the middle of the office that the agents' walking grid marks as furniture.
    let desk = null;
    for (let j = 8; j < NAV.H - 8 && !desk; j++) for (let i = 8; i < NAV.W - 8 && !desk; i++) if (blockedInterior[j * NAV.W + i]) desk = { x: wx(i), z: wz(j) };
    return {
      aisle: hit(2.5, 1.2, .5, 0, -1, -.3),
      up: hit(2.5, 1.2, .5, 0, .2, -1),
      level: hit(2.5, 1.2, .5, 0, 0, -1),
      far: hit(2.5, 1.2, .5, 0, -.05, -1),
      outside: hit(30, 1.2, 0, 0, -1, 0),
      desk: hit(desk.x, 1.2, desk.z, 0, -1, 0),
    };
  });
  expect(r.aisle).not.toBeNull();
  expect(r).toMatchObject({ up: null, level: null, far: null, outside: null, desk: null });
});

test('one push of the thumbstick turns 30 degrees on the spot', async ({ page, office }) => {
  await enterWithPad(page, office);
  const turn = x => page.evaluate(x => { __xr.pad.gamepad.axes[2] = x; vrStep(); return rig.rotation.y; }, x);
  const h0 = await head(page), r0 = await turn(0);
  const r1 = await turn(.9);
  expect(r1 - r0).toBeCloseTo(-Math.PI / 6, 5);   // stick right turns you right: clockwise seen from above, a negative angle
  expect(await turn(1)).toBe(r1);                   // holding the stick does not keep turning
  await turn(0);
  expect(await turn(-.9)).toBeCloseTo(r0, 5);       // stick left turns you back
  const h1 = await head(page);
  expect(h1.x).toBeCloseTo(h0.x, 5); expect(h1.z).toBeCloseTo(h0.z, 5);   // the head stays where it was
});

test('after a turn, a jump still puts the head on the ring', async ({ page, office }) => {
  await enterWithPad(page, office);
  await page.evaluate(() => { vrTurn(Math.PI / 2); __xr.session.press('selectstart', __xr.pad); vrStep(); });
  const aim = await page.evaluate(() => ({ ring: vrRing.visible, x: vrRing.position.x, z: vrRing.position.z }));
  expect(aim.ring).toBe(true);
  await page.evaluate(() => __xr.session.press('selectend', __xr.pad));
  const h = await head(page);
  expect(h.x).toBeCloseTo(aim.x, 5); expect(h.z).toBeCloseTo(aim.z, 5);
});

test('leaving VR while aiming hides the ring and the next session starts clean', async ({ page, office }) => {
  await enterWithPad(page, office);
  await page.evaluate(() => { __xr.session.press('selectstart', __xr.pad); vrStep(); });
  await page.evaluate(() => __xr.session.end());
  await expect.poll(() => page.evaluate(() => renderer.xr.isPresenting)).toBe(false);
  expect(await page.evaluate(() => ({ ring: vrRing.visible, aiming: vrPads.some(p => p.userData.aiming) }))).toEqual({ ring: false, aiming: false });
});

// One live agent, so there is a name tag to read.
const withAgent = async (page, office) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr1', cwd: '/tmp/e2e-vr' });
  await enterWithPad(page, office);
  await expect.poll(() => page.evaluate(() => agents.some(a => a.kind === 'main'))).toBe(true);
};

test('name tags show in VR even when they are turned off, and far tags grow so they stay readable', async ({ page, office }) => {
  await withAgent(page, office);
  const size = d => page.evaluate(d => {
    setShowLabels(false); const a = agents.find(a => a.kind === 'main'); step(0);
    const p = a.label.getWorldPosition(new THREE.Vector3());
    vrTeleport(p.x + d, p.z); camera.position.y = p.y - rig.position.y; vrStep();
    return { shown: a.label.visible, w: a.label.scale.x };
  }, d);
  expect(await size(2)).toEqual({ shown: true, w: 2.8 });
  const far = await size(12);
  expect(far.shown).toBe(true); expect(far.w).toBeCloseTo(5.6, 5);
  expect((await size(40)).w).toBeCloseTo(7, 5);   // no bigger than 2.5 times
  await page.evaluate(() => __xr.session.end());
  await expect.poll(() => page.evaluate(() => renderer.xr.isPresenting)).toBe(false);
  expect(await page.evaluate(() => { step(0); const a = agents.find(a => a.kind === 'main'); return { shown: a.label.visible, w: a.label.scale.x }; })).toEqual({ shown: false, w: 2.8 });
});

test('the left controller carries a "Needs you" panel that lists waiting agents and buzzes for a new one', async ({ page, office }) => {
  await withAgent(page, office);
  await page.evaluate(() => {
    __xr.buzz = 0;
    __xr.left = __xr.session.addPad('left');
    __xr.left.gamepad.hapticActuators = [{ pulse: async () => { __xr.buzz++; } }];
  });
  const panel = () => page.evaluate(() => { vrPanel.userData.at = -1e9; vrStep(); return { on: vrPads.some(p => p.children.includes(vrPanel)), text: vrPanel.userData.text }; });
  expect(await panel()).toEqual({ on: true, text: expect.stringMatching(/^Nothing needs you/) });
  const height = () => page.evaluate(() => vrPanel.userData.m.scale.y);
  const slim = await height();
  expect(await page.evaluate(() => __xr.buzz)).toBe(0);

  await page.evaluate(() => { const a = agents.find(a => a.kind === 'main'); setState(a, 'waiting', 'Needs permission: Bash'); });
  const p = await panel();
  expect(p.text).toMatch(/^1 agent needs you/);
  expect(p.text).toContain('Needs permission: Bash');
  expect(await height()).toBeGreaterThan(slim);   // the panel grows to show the row
  expect(await page.evaluate(() => __xr.buzz)).toBe(1);
  await panel();
  expect(await page.evaluate(() => __xr.buzz)).toBe(1);   // one buzz for each new agent, not one each time it looks

  await page.evaluate(() => { const a = agents.find(a => a.kind === 'main'); setState(a, 'working', 'Running Bash'); });
  expect((await panel()).text).toMatch(/^Nothing needs you/);
  expect(await height()).toBe(slim);
});

test('a nearer name tag draws on top of a farther one', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr1', cwd: '/tmp/e2e-vr' });
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr2', cwd: '/tmp/e2e-vr2' });
  await enterWithPad(page, office);
  await expect.poll(() => page.evaluate(() => agents.filter(a => a.kind === 'main').length)).toBe(2);
  const r = await page.evaluate(() => {
    step(0);
    const [one] = agents.filter(a => a.kind === 'main'), p = one.label.getWorldPosition(new THREE.Vector3());
    vrTeleport(p.x + 1, p.z); vrStep();   // stand next to one of the two
    const c = camera.getWorldPosition(new THREE.Vector3());
    const [near, far] = agents.filter(a => a.kind === 'main').map(a => ({ d: a.label.getWorldPosition(new THREE.Vector3()).distanceTo(c), o: a.label.renderOrder })).sort((p, q) => p.d - q.d);
    return { near, far };
  });
  expect(r.near.d).toBeLessThan(r.far.d);
  expect(r.near.o).toBeGreaterThan(r.far.o);
});
