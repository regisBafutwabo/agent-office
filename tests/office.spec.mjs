import { test, expect, open, row } from './office.mjs';

test('the office opens live and shows a session its hooks report', async ({ page, office }) => {
  await open(page, office);
  await expect(page.locator('#stage canvas')).toBeVisible();
  await office.hook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/tmp/e2e-alpha' });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp/e2e-alpha', prompt: 'Fix the login page' });
  await expect(row(page, 'Fix the login page')).toBeVisible();
});

test('the demo office runs simulated agents', async ({ page, office }) => {
  await page.goto(`${office.url}/?demo#k=${office.key}`);
  await expect(page.locator('#roster .agent-row').first()).toBeVisible();
});
