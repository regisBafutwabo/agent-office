import { test, expect, open } from './office.mjs';

test('a full floor spills into the lounge, then into a second floor for the same project', async ({ page, office }) => {
  test.setTimeout(120_000);
  await open(page, office);
  await expect(page.locator('#stage canvas')).toBeVisible();
  const cwd = '/tmp/e2e-big';
  // Every seat a main agent can take on one floor: the desks, then the spare seats.
  const seats = await page.evaluate(() => { const f = makeFloor('probe', 'probe'); const n = f.deskSeats.length + freeSpots(SPARE_SEATS, f).length; building.remove(f.group); floors.splice(floors.indexOf(f), 1); return n; });
  expect(seats).toBeGreaterThan(23);   // more than the 16 desks, 4 hot desks and 3 café stools there were before
  for (let i = 0; i <= seats; i++) await office.hook({ hook_event_name: 'SessionStart', session_id: `big${i}`, cwd });
  await expect.poll(() => page.evaluate(() => agents.filter(a => a.kind === 'main' && a.live).length), { timeout: 60_000 }).toBe(seats + 1);

  const where = await page.evaluate(() => agents.filter(a => a.kind === 'main' && a.live).map(a => ({ floor: a.floor.name, home: `${a.floor.key}|${a.home.type}|${a.home.x},${a.home.z}` })));
  expect(new Set(where.map(w => w.home)).size, 'nobody shares a seat').toBe(where.length);
  expect(where.filter(w => w.floor === 'e2e-big')).toHaveLength(seats);
  expect(where.filter(w => w.floor === 'e2e-big · 2')).toHaveLength(1);
  await expect(page.locator('#lift-list .fl-name', { hasText: 'e2e-big · 2' })).toBeVisible();
});
