import { test, expect, open } from './office.mjs';

// No headset and no WebXR runtime on test machines, so each test puts a fake navigator.xr in the page before it loads.
// It runs in the page, so it gets its mode as an argument. The fake does just enough for three.js to start and end a session. It never draws a frame, so these tests check
// what the office does around a session, not what a headset shows. docs/vr.md tells how to check that in an emulator.
const fakeXr = mode => {
  window.__xr = { ended: 0 };
  if (mode === 'none') { Object.defineProperty(navigator, 'xr', { value: undefined, configurable: true }); return; }
  class FakeSession extends EventTarget {
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
