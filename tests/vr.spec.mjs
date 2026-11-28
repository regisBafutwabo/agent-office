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
  expect(await panel()).toEqual({ on: true, text: expect.stringMatching(/^Floor \d+ · .+\nNothing needs you/) });
  const height = () => page.evaluate(() => vrPanel.userData.m.scale.y);
  const slim = await height();
  expect(await page.evaluate(() => __xr.buzz)).toBe(0);

  await page.evaluate(() => { const a = agents.find(a => a.kind === 'main'); setState(a, 'waiting', 'Needs permission: Bash'); });
  const p = await panel();
  expect(p.text).toMatch(/\n1 agent needs you/);
  expect(p.text).toContain('Needs permission: Bash');
  expect(await height()).toBeGreaterThan(slim);   // the panel grows to show the row
  expect(await page.evaluate(() => __xr.buzz)).toBe(1);
  await panel();
  expect(await page.evaluate(() => __xr.buzz)).toBe(1);   // one buzz for each new agent, not one each time it looks

  await page.evaluate(() => { const a = agents.find(a => a.kind === 'main'); setState(a, 'working', 'Running Bash'); });
  expect((await panel()).text).toMatch(/\nNothing needs you/);
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

test('push a thumbstick down or up to change floors behind a short fade, and keep your spot', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr1', cwd: '/tmp/e2e-vr' });
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr2', cwd: '/tmp/e2e-vr2' });
  await enterWithPad(page, office);
  await expect.poll(() => page.evaluate(() => floors.length)).toBeGreaterThanOrEqual(2);
  const push = y => page.evaluate(y => { __xr.pad.gamepad.axes[3] = y; vrStep(); }, y);
  const state = () => page.evaluate(() => ({ floor: curFloor.i, settled: yOff === yOffTarget, dark: vrShade.visible, x: rig.position.x, z: rig.position.z, turn: rig.rotation.y }));
  await page.evaluate(() => goToFloor(floors.length - 1));
  const s0 = await state();

  await page.evaluate(() => { __xr.pad.gamepad.axes[2] = .4; });   // a push down and a little to the side changes floor only
  await push(.9);
  expect(await state()).toMatchObject({ floor: s0.floor, dark: true });   // fading to black first
  await page.waitForTimeout(250); await push(.9);                         // holding the stick does not go further
  const s1 = await state();
  expect(s1).toMatchObject({ floor: s0.floor - 1, settled: true, x: s0.x, z: s0.z, turn: s0.turn });
  await page.waitForTimeout(300); await push(0);
  expect(await state()).toMatchObject({ floor: s0.floor - 1, dark: false });
  expect(await page.evaluate(() => { vrPanel.userData.at = -1e9; vrStep(); return vrPanel.userData.text.split('\n')[0]; }))
    .toBe(await page.evaluate(() => `Floor ${floorNum(curFloor)} · ${curFloor.name}`));

  await push(-.9);   // and up again
  await page.waitForTimeout(250); await push(0);
  expect((await state()).floor).toBe(s0.floor);
});

test('on the rooftop a push up only taps the controller', async ({ page, office }) => {
  await enterWithPad(page, office);
  await page.evaluate(() => { vrArrive('roof'); __xr.buzz = 0; __xr.pad.gamepad.hapticActuators = [{ pulse: async () => { __xr.buzz++; } }]; });
  await page.evaluate(() => { __xr.pad.gamepad.axes[3] = -.9; vrStep(); });
  expect(await page.evaluate(() => ({ roof: viewMode === 'roof', dark: vrShade.visible, buzz: __xr.buzz }))).toEqual({ roof: true, dark: false, buzz: 1 });
});

// Point the right controller at the lift button or a row of the floor list, from in front of it.
const aimAt = (page, what) => page.evaluate(what => {
  let target;
  if (what === 'lift') target = vrLiftBtn.getWorldPosition(new THREE.Vector3());
  else {   // a row of the floor list, by its key
    const u = vrMenu.userData, r = u.rows.find(r => r.key === what), uvy = 1 - (r.y0 + r.y1) / 2 / u.H;
    target = u.m.localToWorld(new THREE.Vector3(0, (uvy - .5) * VR_MENU_H, 0));
  }
  // Stand back along the side it faces (its +Z), a little lower, as a person would.
  const obj = what === 'lift' ? vrLiftBtn : vrMenu.userData.m, facing = new THREE.Vector3(0, 0, 1).applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()));
  const eye = target.clone().addScaledVector(facing, what === 'lift' ? 1.5 : .6).add(new THREE.Vector3(0, -.2, 0));
  rig.updateMatrixWorld(true);
  const m = new THREE.Matrix4().lookAt(eye, target, new THREE.Vector3(0, 1, 0)).setPosition(eye);
  renderer.xr.getController(0).matrix.copy(new THREE.Matrix4().copy(rig.matrixWorld).invert().multiply(m));
  vrStep();
  return __xr.pad && renderer.xr.getController(0).userData.ui;
}, what);
const click = page => page.evaluate(() => { __xr.session.press('selectstart', __xr.pad); vrStep(); __xr.session.press('selectend', __xr.pad); vrStep(); });

test('the Floors button by the lift opens a list of floors, and picking one takes you there', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr1', cwd: '/tmp/e2e-vr' });
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr2', cwd: '/tmp/e2e-vr2' });
  await enterWithPad(page, office);
  await expect.poll(() => page.evaluate(() => floors.length)).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => goToFloor(floors.length - 1));
  expect(await page.evaluate(() => vrLiftBtn.visible)).toBe(true);

  expect(await aimAt(page, 'lift')).toBe('lift');
  const rig0 = await page.evaluate(() => rig.position.toArray());
  await click(page);
  expect(await page.evaluate(() => vrMenu.visible)).toBe(true);
  expect(await page.evaluate(() => rig.position.toArray())).toEqual(rig0);   // pressing the button is not a jump

  const to = await page.evaluate(() => curFloor.i - 1);
  expect(await aimAt(page, 'floor:' + to)).toBe('floor:' + to);
  await click(page);
  expect(await page.evaluate(() => ({ menu: vrMenu.visible, dark: vrShade.visible }))).toEqual({ menu: false, dark: true });
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => { vrStep(); return curFloor.i; })).toBe(to);
});

test('the floor list marks where you are and where someone needs you, and Close closes it', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr1', cwd: '/tmp/e2e-vr' });
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'vr2', cwd: '/tmp/e2e-vr2' });
  await enterWithPad(page, office);
  await expect.poll(() => page.evaluate(() => agents.filter(a => a.kind === 'main' && a.floor).length)).toBe(2);
  // Stand on one agent's floor, and let the other agent wait for you.
  await page.evaluate(() => { const [a, b] = agents.filter(a => a.kind === 'main'); goToFloor(a.floor.i); setState(b, 'waiting', 'Needs permission: Bash'); });
  await aimAt(page, 'lift'); await click(page);
  const r = await page.evaluate(() => {
    const [a, b] = agents.filter(a => a.kind === 'main'), note = f => vrMenu.userData.rows.find(r => r.key === 'floor:' + f.i).note;
    return { here: note(a.floor), waiting: note(b.floor), last: vrMenu.userData.rows.at(-1).key };
  });
  expect(r).toEqual({ here: 'You are here', waiting: '1 needs you', last: 'close' });
  expect(await aimAt(page, 'close')).toBe('close');
  await click(page);
  expect(await page.evaluate(() => vrMenu.visible)).toBe(false);
});

test('the lift button shows only in VR', async ({ page, office }) => {
  await enterWithPad(page, office);
  expect(await page.evaluate(() => vrLiftBtn.visible)).toBe(true);
  await page.evaluate(() => { vrPress('lift'); __xr.session.end(); });
  await expect.poll(() => page.evaluate(() => renderer.xr.isPresenting)).toBe(false);
  expect(await page.evaluate(() => ({ btn: vrLiftBtn.visible, menu: vrMenu.visible }))).toEqual({ btn: false, menu: false });
});

test('the floor list opens close in front of you, facing you', async ({ page, office }) => {
  await enterWithPad(page, office);
  await page.evaluate(() => vrTurn(Math.PI / 3));   // not facing the way you started
  await aimAt(page, 'lift'); await click(page);
  const r = await page.evaluate(() => {
    const head = camera.getWorldPosition(new THREE.Vector3()), look = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const at = vrMenu.userData.m.getWorldPosition(new THREE.Vector3()), facing = new THREE.Vector3(0, 0, 1).applyQuaternion(vrMenu.getWorldQuaternion(new THREE.Quaternion()));
    const to = at.clone().sub(head).setY(0);
    return { dist: to.length(), ahead: to.normalize().dot(look), toward: facing.dot(look), below: head.y - at.y };
  });
  expect(r.dist).toBeGreaterThan(.6); expect(r.dist).toBeLessThan(1.2);   // within reach of the eyes, not across the room
  expect(r.ahead).toBeGreaterThan(.95);                                     // straight ahead
  expect(r.toward).toBeLessThan(-.95);                                      // its face turned to you
  expect(r.below).toBeGreaterThan(0); expect(r.below).toBeLessThan(.5);    // a little below eye height
});

test('up from the top floor is the rooftop: you step out of its lift onto the deck, and down takes you back', async ({ page, office }) => {
  await enterWithPad(page, office);
  await page.evaluate(() => goToFloor(floors.length - 1));
  const go = async y => { await page.evaluate(y => { __xr.pad.gamepad.axes[3] = y; vrStep(); }, y); await page.waitForTimeout(500); await page.evaluate(() => { __xr.pad.gamepad.axes[3] = 0; vrStep(); }); };   // past the whole fade
  const where = () => page.evaluate(() => { const h = camera.getWorldPosition(new THREE.Vector3()); vrPanel.userData.at = -1e9; vrStep();
    return { roof: viewMode === 'roof', deck: roofGroup.visible, feet: rig.position.y, ground: vrGround(), x: h.x, z: h.z, btn: vrLiftBtn.position.y - rig.position.y, here: vrPanel.userData.text.split('\n')[0] }; });

  await go(-.9);
  const up = await where();
  expect(up).toMatchObject({ roof: true, deck: true, here: 'Rooftop' });
  expect(up.feet).toBeGreaterThan(3); expect(up.feet).toBeCloseTo(up.ground, 5);   // standing on the deck, not inside the top floor
  expect(up.x).toBeCloseTo(11.6, 5); expect(up.z).toBeCloseTo(-1.8, 5);            // at the lift
  expect(up.btn).toBeCloseTo(1.3, 5);                                              // the Floors button came up too
  // Jumps land on the deck, using the deck's own grid.
  expect(await page.evaluate(() => { const g = vrGround(), h = vrFloorHit(new THREE.Vector3(8, g + 1.2, -1.8), new THREE.Vector3(-1, -1, 0).normalize()); return h && h.x; })).toBeCloseTo(6.8, 5);

  await go(.9);
  const down = await where();
  expect(down).toMatchObject({ roof: false, deck: false, feet: 0 });
  expect(down.here).toMatch(/^Floor /);
  expect(down.x).toBeCloseTo(11.6, 5); expect(down.z).toBeCloseTo(-1.8, 5);
});

test('the floor list starts with the rooftop', async ({ page, office }) => {
  await enterWithPad(page, office);
  await aimAt(page, 'lift'); await click(page);
  expect(await page.evaluate(() => vrMenu.userData.rows[0].key)).toBe('roof');
  expect(await aimAt(page, 'roof')).toBe('roof');
  await click(page);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => { vrStep(); return viewMode; })).toBe('roof');
});

test('with the list open, a row behind the Floors button still gets the press', async ({ page, office }) => {
  await enterWithPad(page, office);
  await aimAt(page, 'lift'); await click(page);
  // Move the list so that its Rooftop row sits right behind the button, as when it opens into the lift wall.
  await page.evaluate(() => {
    const b = vrLiftBtn.getWorldPosition(new THREE.Vector3()), u = vrMenu.userData, r = u.rows[0];
    vrMenu.rotation.copy(vrLiftBtn.rotation);
    const down = (r.y0 + r.y1) / 2 / u.H * VR_MENU_H * u.m.scale.y;   // metres from the list's top edge to that row
    vrMenu.position.set(b.x + .2, b.y + down, b.z);                      // 20 cm behind the button, inside the wall, row level with it
    vrDrawMenu();
  });
  expect(await aimAt(page, 'roof')).toBe('roof');
  await click(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => { vrStep(); return viewMode; })).toBe('roof');
});
