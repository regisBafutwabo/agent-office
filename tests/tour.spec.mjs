import { test, expect, open } from './office.mjs';

// office.mjs marks the tour as done for every test. Here the office starts with a crew and a city
// but no finished tour, once: a reload keeps whatever the tour saved.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('tour-test')) return;
    sessionStorage.setItem('tour-test', '1');
    localStorage.setItem('agent-office:ui', JSON.stringify({ crew: 'robots', city: 'generic' }));
  });
});
const guide = page => page.locator('#office-guide');
const next = page => page.locator('#guide-next');
const ui = page => page.evaluate(() => JSON.parse(localStorage.getItem('agent-office:ui')));

test('an empty office still shows where to look on every step, and the tour can be finished', async ({ page, office }) => {
  await open(page, office);
  await expect(guide(page)).toBeVisible();
  await expect(page.locator('#guide-step')).toHaveText('Office tour · 1 of 4');
  await expect(page.locator('#empty')).toBeHidden();                       // the tour card and the empty card used to overlap
  for (let i = 0; i < 3; i++) {
    await expect(page.locator('.guide-target')).toHaveCount(1);
    await next(page).click();
  }
  // No agents: step 4 points at the panel and doesn't describe Allow, Deny or a marker that isn't there.
  await expect(page.locator('.guide-target')).toHaveCount(1);
  await expect(page.locator('#guide-body')).toContainText('Try the demo');
  await expect(page.locator('#guide-action')).toHaveText('Try demo');
  await expect(next(page)).toHaveText('Start using my office');
  await next(page).click();
  await expect(guide(page)).toBeHidden();
  await expect(page.locator('#empty')).toBeVisible();
  expect((await ui(page)).guideDone).toBe(true);
});

test('Escape ends the tour even when focus has left the tour card', async ({ page, office }) => {
  await open(page, office);
  await expect(guide(page)).toBeVisible();
  await page.locator('#view-3d').focus();
  await page.keyboard.press('Escape');
  await expect(guide(page)).toBeHidden();
  expect((await ui(page)).guideDone).toBe(true);
});

test('?tour starts the tour once, and a reload after skipping it does not start it again', async ({ page, office }) => {
  await page.addInitScript(() => { const s = JSON.parse(localStorage.getItem('agent-office:ui')); s.guideDone = true; localStorage.setItem('agent-office:ui', JSON.stringify(s)); });
  await page.goto(`${office.url}/?tour#k=${office.key}`);
  await expect(guide(page)).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  await page.locator('#guide-skip').click();
  await page.reload();
  await expect(page.locator('body')).toHaveClass(/live/);
  await expect(guide(page)).toBeHidden();
});

test('the tour puts the floors and the panel back the way they were', async ({ page, office }) => {
  await open(page, office);
  await page.locator('#guide-skip').click();
  await page.keyboard.press('[');                                          // hide the floors
  await page.getByRole('tab', { name: 'Customize' }).click();              // and leave the panel on Customize
  await page.locator('#replay-guide').click();
  await page.locator('#welcome-next').click();
  await expect(guide(page)).toBeVisible();
  await expect(page.locator('#lift')).not.toHaveClass(/collapsed/);        // step 1 opens the floors
  await expect(page.locator('#panel .tabs [aria-selected="true"]')).toHaveAttribute('data-tab', 'agents');
  await page.locator('#guide-skip').click();
  await expect(page.locator('#lift')).toHaveClass(/collapsed/);
  await expect(page.locator('#panel .tabs [aria-selected="true"]')).toHaveAttribute('data-tab', 'custom');
});

test('reloading on the last step with an agent running selects it once the office has its agents', async ({ page, office }) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: 't1', cwd: '/tmp/e2e-tour' });
  await open(page, office);
  for (let i = 0; i < 3; i++) await next(page).click();
  await expect(page.locator('#guide-step')).toHaveText('Office tour · 4 of 4');
  await page.reload();
  await expect(page.locator('#guide-step')).toHaveText('Office tour · 4 of 4');
  await expect(page.locator('#guide-action')).toHaveText('View activity');
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#detail')).toHaveClass(/guide-target/);
});
