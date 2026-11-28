import { test, expect, open } from './office.mjs';

// Only the desktop app answers /api/mini, so these stand in for it.
const desktop = (page, opened = 202) => page.route('**/api/mini', route => route.fulfill({ status: route.request().method() === 'POST' ? opened : 204 }));

test('in the Mac app, Float opens the mini office window', async ({ page, office }) => {
  await desktop(page);
  await open(page, office);
  const button = page.locator('#pip-btn');
  await expect(button).toBeVisible();
  const asked = page.waitForRequest(r => r.url().endsWith('/api/mini') && r.method() === 'POST');
  await button.click();
  await asked;
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('if the app cannot open the mini office, the office says what to do instead', async ({ page, office }) => {
  await desktop(page, 409);
  await open(page, office);
  await page.locator('#pip-btn').click();
  await expect(page.locator('.toast', { hasText: "Couldn't open the mini office" })).toBeVisible();
});

test("in a browser on the Node bridge, Float uses the browser's picture-in-picture", async ({ page, office }) => {
  // Headless browsers have no picture-in-picture window, so this stands in for the browser's.
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { get: () => true });
    let floating = null;
    Object.defineProperty(Document.prototype, 'pictureInPictureElement', { get: () => floating });
    HTMLVideoElement.prototype.requestPictureInPicture = async function () { floating = this; window.floated = this.srcObject instanceof MediaStream; };
    Document.prototype.exitPictureInPicture = async function () { const v = floating; floating = null; v.dispatchEvent(new Event('leavepictureinpicture')); };
  });
  await open(page, office);
  const button = page.locator('#pip-btn');
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.floated)).toBe(true);   // the video plays the 3D view
  await button.click();   // a second click brings it back
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('video.pip-source')).toHaveCount(0);
});

test('a browser without picture-in-picture shows no Float button', async ({ page, office }) => {
  await page.addInitScript(() => Object.defineProperty(Document.prototype, 'pictureInPictureEnabled', { get: () => false }));
  await open(page, office);
  await expect(page.locator('#stage canvas')).toBeVisible();
  await expect(page.locator('#pip-btn')).toBeHidden();
});

test('the mini office shows only the building, and never holds permission requests', async ({ page, office }) => {
  const presence = [];
  await page.routeWebSocket('**/ws', ws => {
    const server = ws.connectToServer();
    ws.onMessage(m => { try { const msg = JSON.parse(m); if (msg.type === 'presence') presence.push(msg.visible); } catch (_) {} server.send(m); });
  });
  await page.addInitScript(() => localStorage.removeItem('agent-office:ui'));   // a first start: the big office would welcome you
  await page.goto(`${office.url}/?mini#k=${office.key}`);
  await expect(page.locator('body')).toHaveClass(/live/);
  await expect(page.locator('#stage canvas')).toBeVisible();
  for (const id of ['#welcome', '#city-picker', '.topbar', '#panel', '#lift', '#hint']) await expect(page.locator(id)).toBeHidden();
  await expect.poll(() => presence.length).toBeGreaterThan(0);
  // It has no Allow and Deny buttons, so the bridge must not wait for an answer from it.
  expect(presence.every(v => v === false)).toBe(true);
  await page.screenshot({ path: process.env.SHOT || 'test-results/mini-office.png' });
});
