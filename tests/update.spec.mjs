import { test, expect, open } from './office.mjs';

// Only the desktop app answers /api/update, so these stand in for it.
const NOTES = '- **A bell for what you missed.** Click it when you want to see them.\n- **Clearer names.** <script>no</script>';
const waiting = (page, version, installed = 202, notes = NOTES) => page.route('**/api/update', route => route.request().method() === 'POST'
  ? route.fulfill({ status: installed })
  : route.fulfill({ json: { version, notes, current: '0.5.9' } }));

test('a downloaded update is offered in the corner until you close it', async ({ page, office }) => {
  await waiting(page, '0.5.10');
  await open(page, office);
  const notice = page.locator('#update-toast');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Agent Office 0.5.10 is ready');
  await expect(notice).toContainText('You have 0.5.9');
  await page.waitForTimeout(7000);   // ordinary toasts are gone by now
  await expect(notice).toBeVisible();

  await page.locator('#update-close').click();
  await expect(notice).toBeHidden();
  await page.reload();
  await expect(page.locator('#stage canvas')).toBeVisible();
  await expect(notice).toBeHidden();   // closed for this version

  await page.unroute('**/api/update');
  await waiting(page, '0.5.11');
  await page.reload();
  await expect(notice).toContainText('Agent Office 0.5.11 is ready');   // a newer one shows again
});

test("what's new opens the notes in plain words, and can update from there", async ({ page, office }) => {
  await waiting(page, '0.5.10');
  await open(page, office);
  await page.locator('#update-notes').click();
  const modal = page.locator('#whats-new');
  await expect(modal).toBeVisible();
  await expect(modal.locator('h2')).toHaveText("What's new in 0.5.10");
  await expect(modal.locator('li b').first()).toHaveText('A bell for what you missed.');
  await expect(modal.locator('li')).toHaveCount(2);
  await expect(modal.locator('li').nth(1)).toContainText('<script>no</script>');   // shown as text, never run
  await page.locator('#wn-later').click();
  await expect(modal).toBeHidden();
  await expect(page.locator('#update-toast')).toBeVisible();   // later keeps the notice

  await page.locator('#update-notes').click();
  const asked = page.waitForRequest(r => r.url().endsWith('/api/update') && r.method() === 'POST');
  await page.locator('#wn-go').click();
  await asked;
});

test('an older release with only a link still reads well', async ({ page, office }) => {
  await waiting(page, '0.5.10', 202, 'See https://github.com/regisBafutwabo/agent-office/releases/tag/v0.5.10');
  await open(page, office);
  await page.locator('#update-notes').click();
  await expect(page.locator('#wn-body')).toContainText('Version 0.5.10 has fixes and improvements. Read about it.');
  await expect(page.locator('#wn-body a')).toHaveAttribute('href', /\/tag\/v0\.5\.10$/);
});

test('restart to update asks the app to install it', async ({ page, office }) => {
  await waiting(page, '0.5.10', 202);
  await open(page, office);
  const asked = page.waitForRequest(r => r.url().endsWith('/api/update') && r.method() === 'POST');
  await page.locator('#update-go').click();
  await asked;
  await expect(page.locator('#update-go')).toHaveText('Restarting…');
});

test('no update, or a browser on the Node bridge, shows nothing', async ({ page, office }) => {
  await open(page, office);
  await expect(page.locator('#stage canvas')).toBeVisible();
  await expect(page.locator('#update-toast')).toBeHidden();
});
