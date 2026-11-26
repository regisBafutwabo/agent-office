import { test, expect, open } from './office.mjs';

const cwd = '/tmp/e2e-toast';
test('a toast about an agent that finished has a close button that dismisses it', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 't1', cwd });
  await open(page, office);
  await expect.poll(() => page.evaluate(() => agents.some(x => x.kind === 'main'))).toBe(true);
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 't1', cwd, prompt: 'Do it' });
  await office.hook({ hook_event_name: 'Stop', session_id: 't1', cwd });
  const t = page.locator('.toast', { hasText: 'finished' });
  await expect(t).toBeVisible();
  await page.screenshot({ path: process.env.SHOT || 'test-results/toast.png' });
  await t.getByRole('button', { name: 'Close' }).click();
  await expect(t).toHaveCount(0);
});

test('plain notices without an agent or buttons have no close button', async ({ page, office }) => {
  await open(page, office);
  await page.evaluate(() => toast('Copied.'));
  await expect(page.locator('.toast', { hasText: 'Copied.' })).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Copied.' }).locator('.toast-x')).toHaveCount(0);
});
