import { test, expect, open, row } from './office.mjs';

const cwd = '/tmp/e2e-shop';
const start = async (office, id, prompt) => {
  await office.hook({ hook_event_name: 'SessionStart', session_id: id, cwd });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd, prompt });
};
const edit = (office, id, file) => office.hook({ hook_event_name: 'PreToolUse', session_id: id, cwd, tool_name: 'Edit', tool_input: { file_path: `${cwd}/${file}`, old_string: 'a', new_string: 'b' } });

test('two agents editing one file are flagged, and still are after a reload', async ({ page, office }) => {
  await start(office, 'c1', 'Restyle the cart');
  await start(office, 'c2', 'Fix the cart total');
  await open(page, office);
  await edit(office, 'c1', 'cart.js');
  await edit(office, 'c2', 'cart.js');
  await expect(row(page, 'Restyle the cart')).toContainText('Same file as Fix the cart total');
  await expect(page.locator('#recap')).toBeHidden();

  await page.reload();
  await expect(row(page, 'Restyle the cart')).toContainText('Same file as Fix the cart total');

  // Push the edits out of the bridge's last 80 events: the page's own record still has the clash.
  for (let i = 0; i < 90; i++) await office.hook({ hook_event_name: 'PreToolUse', session_id: 'c1', cwd, tool_name: 'Read', tool_input: { file_path: `${cwd}/notes${i}.md` } });
  await page.reload();
  await expect(row(page, 'Fix the cart total')).toContainText('Same file as Restyle the cart');
});

test('coming back after a while shows what happened meanwhile', async ({ page, office }) => {
  await page.addInitScript(t => localStorage.setItem('agent-office:seen', String(t)), Date.now() - 30 * 60 * 1000);
  await start(office, 'r1', 'Upgrade the router');
  await office.hook({ hook_event_name: 'PostToolUseFailure', session_id: 'r1', cwd, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'exit 1' });
  await office.hook({ hook_event_name: 'Stop', session_id: 'r1', cwd });
  await open(page, office);

  const recap = page.locator('#recap');
  await expect(recap).toBeVisible();
  await expect(recap).toContainText('While you were away · last here 30m ago');
  await expect(recap.locator('.recap-row', { hasText: 'Upgrade the router' })).toContainText('finished · 1 failed command');
  await recap.locator('.recap-row', { hasText: 'Upgrade the router' }).click();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#d-name')).toHaveText('Upgrade the router');
  await page.locator('#recap-close').click();
  await expect(recap).toBeHidden();
});
