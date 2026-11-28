import { test, expect, open } from './office.mjs';

// Step the scene by hand, so each check sees an exact amount of time pass.
const run = (page, seconds) => page.evaluate(s => { window.agentOffice.held = true; for (let t = 0; t < s; t += .05) step(.05); }, seconds);

test('clouds drift and the roof lights blink', async ({ page, office }) => {
  await open(page, office);
  const before = await page.evaluate(() => clouds.rotation.y);
  const glow = [];
  for (let i = 0; i < 8; i++) { await run(page, .2); glow.push(await page.evaluate(() => beaconMat.color.r)); }
  expect(await page.evaluate(() => clouds.rotation.y)).toBeGreaterThan(before);
  expect(Math.max(...glow) - Math.min(...glow)).toBeGreaterThan(.3);
});

for (const city of ['generic', 'sf']) {
  test(`a helicopter crosses the view over the roofs of ${city} and goes away`, async ({ page, office }) => {
    await open(page, office);
    expect(await page.evaluate(c => setCity(c), city)).toBe(true);
    await page.evaluate(() => { heliFlight.wait = 0; });
    await run(page, .1);
    expect(await page.evaluate(() => heli.visible)).toBe(true);
    // Fly the whole route and keep its lowest clearance over the roof under it.
    const flight = await page.evaluate(() => {
      window.agentOffice.held = true;
      let clearance = Infinity, seen = false, steps = 0; const p = new THREE.Vector3();
      while (heli.visible && steps++ < 2000) {
        step(.05); if (!heli.visible) break;
        const c = hCell(heli.position.x, heli.position.z); if (c >= 0) clearance = Math.min(clearance, heli.position.y - HGRID.top[c]);
        heli.getWorldPosition(p).project(camera); if (Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1) seen = true;
      }
      return { clearance, seen, gone: !heli.visible };
    });
    expect(flight.gone).toBe(true);
    expect(flight.seen).toBe(true);
    expect(flight.clearance).toBeGreaterThan(5);
    if (city === 'sf') expect(await page.evaluate(() => skyline.children.some(o => o.isPoints))).toBe(true);   // lights on the tall towers
  });
}

test('with reduced motion the sky holds still', async ({ page, office }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, office);
  const before = await page.evaluate(() => clouds.rotation.y);
  await page.evaluate(() => { heliFlight.wait = 0; });
  await run(page, 3);
  expect(await page.evaluate(() => clouds.rotation.y)).toBe(before);
  expect(await page.evaluate(() => heli.visible)).toBe(false);
});
