import { test, expect, open, row } from './office.mjs';

const start = async (office, id, cwd, prompt) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: id, cwd });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd, prompt });
};
const where = page => page.evaluate(() => ({ view: viewMode, floor: curFloor && curFloor.key, flying: !!flight }));

test('Follow takes the camera to the agent when it is not in view', async ({ page, office }) => {
  await start(office, 'f1', '/tmp/e2e-follow-shop', 'Restyle the cart');
  await start(office, 'f2', '/tmp/e2e-follow-docs', 'Write the guide');
  await open(page, office);
  await row(page, 'Restyle the cart').click();
  await expect(page.locator('#d-name')).toHaveText('Restyle the cart');

  // Step back to the whole building with the card still open, then follow from there.
  await page.locator('#lift .lift-btn[data-floor="building"]').click();
  await expect.poll(() => where(page)).toMatchObject({ view: 'building' });
  await page.locator('#d-follow').click();
  await expect(page.locator('#d-follow')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => where(page), { timeout: 15_000 }).toEqual({ view: 'floor', floor: '/tmp/e2e-follow-shop', flying: false });
  await expect(page.locator('#d-follow')).toHaveAttribute('aria-pressed', 'true');   // still following once it's there
});

test('a followed agent that takes the lift to the roof takes the camera along', async ({ page, office }) => {
  await start(office, 'r1', '/tmp/e2e-follow-roof', 'Tidy the README');
  await office.hook({ hook_event_name: 'Stop', session_id: 'r1', cwd: '/tmp/e2e-follow-roof' });
  await open(page, office);
  await row(page, 'Tidy the README').click();
  await page.locator('#d-follow').click();
  await expect.poll(() => where(page), { timeout: 15_000 }).toMatchObject({ view: 'floor', flying: false });

  await page.evaluate(async () => {
    const a = agents.find(x => x.kind === 'main'); const up = goRoof(a);
    for (let i = 0; i < 120 && !a.onRoof; i++) await agentOffice.advance(.25);
    await up;
  });
  await expect.poll(() => where(page), { timeout: 15_000 }).toMatchObject({ view: 'roof', flying: false });
  await expect(page.locator('#d-follow')).toHaveAttribute('aria-pressed', 'true');
});
