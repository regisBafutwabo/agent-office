import { test, expect, open } from './office.mjs';

// Step the scene by hand, so each check sees an exact amount of time pass.
const run = (page, seconds) => page.evaluate(s => { window.agentOffice.held = true; for (let t = 0; t < s; t += .05) step(.05); }, seconds);

// Fly a whole helicopter route; keep its lowest clearance over the roof under it and whether it was ever on screen.
const fly = page => page.evaluate(() => {
  window.agentOffice.held = true; heliFlight.wait = 0; step(.05);
  const started = heli.visible; let clearance = Infinity, seen = false, steps = 0; const p = new THREE.Vector3();
  while (heli.visible && steps++ < 2000) {
    step(.05); if (!heli.visible) break;
    const c = hCell(heli.position.x, heli.position.z); if (c >= 0) clearance = Math.min(clearance, heli.position.y - HGRID.top[c]);
    heli.getWorldPosition(p).project(camera); if (Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z < 1) seen = true;
  }
  return { started, clearance, seen, gone: !heli.visible };
});

// One page for all of it: CI draws in software, and every extra page load costs it many seconds.
test('clouds drift, roof lights blink and a helicopter crosses over the roofs and goes away', async ({ page, office }) => {
  await open(page, office);
  const before = await page.evaluate(() => clouds.rotation.y);
  const glow = [];
  for (let i = 0; i < 8; i++) { await run(page, .2); glow.push(await page.evaluate(() => beaconMat.color.r)); }
  expect(await page.evaluate(() => clouds.rotation.y)).toBeGreaterThan(before);
  expect(Math.max(...glow) - Math.min(...glow)).toBeGreaterThan(.3);

  for (const city of ['generic', 'sf']) {
    expect(await page.evaluate(c => setCity(c), city)).toBe(true);
    const flight = await fly(page);
    expect(flight, city).toMatchObject({ started: true, seen: true, gone: true });
    expect(flight.clearance, city).toBeGreaterThan(5);
  }
  expect(await page.evaluate(() => skyline.children.some(o => o.isPoints))).toBe(true);   // lights on San Francisco's tall towers
});

test('with reduced motion the sky holds still', async ({ page, office }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, office);
  const before = await page.evaluate(() => clouds.rotation.y);
  await page.evaluate(() => { heliFlight.wait = 0; });
  await run(page, 3);
  expect(await page.evaluate(() => clouds.rotation.y)).toBe(before);
  expect(await page.evaluate(() => heli.visible)).toBe(false);
});
