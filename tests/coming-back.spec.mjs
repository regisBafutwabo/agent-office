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
  await expect(page.locator('#recap-bell')).toBeHidden();

  await page.reload();
  await expect(row(page, 'Restyle the cart')).toContainText('Same file as Fix the cart total');

  // Push the edits out of the bridge's history, so only the page's own record can bring the clash back.
  const state = async () => (await fetch(`${office.url}/api/state`, { headers: { Authorization: `Bearer ${office.key}` } })).json();
  const { recentMax } = await state();
  for (let i = 0; i <= recentMax; i++) await office.hook({ hook_event_name: 'PreToolUse', session_id: 'c1', cwd, tool_name: 'Read', tool_input: { file_path: `${cwd}/notes${i}.md` } });
  expect((await state()).recent.some(e => e.tool === 'Edit'), 'the edits are gone from the snapshot').toBe(false);
  await page.reload();
  await expect(row(page, 'Fix the cart total')).toContainText('Same file as Restyle the cart');
});

test('coming back after a while shows what happened meanwhile', async ({ page, office }) => {
  await page.addInitScript(t => localStorage.setItem('agent-office:seen', String(t)), Date.now() - 30 * 60 * 1000);
  await start(office, 'r1', 'Upgrade the router');
  await office.hook({ hook_event_name: 'PostToolUseFailure', session_id: 'r1', cwd, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'exit 1' });
  await office.hook({ hook_event_name: 'Stop', session_id: 'r1', cwd });
  await open(page, office);

  const recap = page.locator('#recap'), bell = page.locator('#recap-bell');
  await expect(bell).toBeVisible();
  await expect(bell).toContainText('1');
  await expect(recap).toBeHidden();   // the list waits for the bell
  await bell.click();
  await expect(recap).toBeVisible();
  await expect(recap).toContainText('While you were away · last here 30m ago');
  await expect(recap.locator('.recap-row', { hasText: 'Upgrade the router' })).toContainText('finished · 1 failed command');
  await recap.locator('.recap-row', { hasText: 'Upgrade the router' }).click();
  await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#d-name')).toHaveText('Upgrade the router');
  await bell.click();
  await expect(recap).toBeHidden();
  await bell.click();
  await page.locator('#recap-close').click();
  await expect(recap).toBeHidden();
  await expect(bell).toBeHidden();
});

test("what you already answered in the coding app isn't counted as missed", async ({ page, office }) => {
  await page.addInitScript(t => localStorage.setItem('agent-office:seen', String(t)), Date.now() - 30 * 60 * 1000);
  await start(office, 'a1', 'Seen in the app');
  await office.hook({ hook_event_name: 'Stop', session_id: 'a1', cwd });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'a1', cwd, prompt: 'thanks, now the docs' });
  await start(office, 'a2', 'Not seen yet');
  await office.hook({ hook_event_name: 'Stop', session_id: 'a2', cwd });
  await open(page, office);
  const bell = page.locator('#recap-bell');
  await expect(bell).toContainText('1');
  await bell.click();
  await expect(page.locator('#recap .recap-row', { hasText: 'Not seen yet' })).toContainText('finished');
  await expect(page.locator('#recap .recap-row', { hasText: 'Seen in the app' })).toHaveCount(0);

  // Replying to it from the coding app now takes it off too, and an empty list puts the bell away.
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'a2', cwd, prompt: 'ok, ship it' });
  await expect(page.locator('#recap-bell')).toBeHidden();
  await expect(page.locator('#recap')).toBeHidden();
});

test('a session that ended while you were away is still in the recap', async ({ page, office }) => {
  await page.addInitScript(t => localStorage.setItem('agent-office:seen', String(t)), Date.now() - 30 * 60 * 1000);
  await start(office, 'e1', 'Tidy the README');
  await office.hook({ hook_event_name: 'Stop', session_id: 'e1', cwd });
  await office.hook({ hook_event_name: 'SessionEnd', session_id: 'e1', cwd, reason: 'exit' });
  await open(page, office);
  await page.locator('#recap-bell').click();
  await expect(page.locator('#recap .recap-row', { hasText: 'Tidy the README' })).toContainText('finished · closed the session');
});

test('missing events while the connection was down brings a recap when it comes back', async ({ page, office }) => {
  await start(office, 'd1', 'Migrate the database');
  await open(page, office);
  await expect(row(page, 'Migrate the database')).toBeVisible();
  // Last looked five minutes ago, then the connection dropped (the Mac slept, the Wi-Fi went).
  await page.evaluate(() => { seenAt -= 5 * 60 * 1000; live.ws.close(); });
  await office.hook({ hook_event_name: 'Stop', session_id: 'd1', cwd });
  await page.locator('#recap-bell').click({ timeout: 10_000 });
  await expect(page.locator('#recap .recap-row', { hasText: 'Migrate the database' })).toContainText('finished');
});

test("a subagent that has left doesn't make its parent look like it shares a file after a reload", async ({ page, office }) => {
  await start(office, 'p1', 'Restyle the cart');
  await start(office, 'p2', 'Fix the cart total');
  await open(page, office);
  await office.hook({ hook_event_name: 'PreToolUse', session_id: 'p1', agent_id: 'x1', agent_type: 'general-purpose', cwd, tool_name: 'Edit', tool_input: { file_path: `${cwd}/cart.js` } });
  await office.hook({ hook_event_name: 'SubagentStop', session_id: 'p1', agent_id: 'x1', agent_type: 'general-purpose', cwd });
  await edit(office, 'p2', 'cart.js');
  await page.reload();
  await expect(row(page, 'Fix the cart total')).toBeVisible();
  await expect(row(page, 'Restyle the cart')).not.toContainText('Same file');
  await expect(row(page, 'Fix the cart total')).not.toContainText('Same file');
});

test("a browser whose clock is off from the bridge's still sees clashes", async ({ page, office }) => {
  await page.clock.install({ time: Date.now() + 60 * 60 * 1000 });   // a phone an hour ahead
  await page.clock.resume();
  await start(office, 'k1', 'Restyle the cart');
  await start(office, 'k2', 'Fix the cart total');
  await open(page, office);
  await edit(office, 'k1', 'cart.js');
  await edit(office, 'k2', 'cart.js');
  await expect(row(page, 'Restyle the cart')).toContainText('Same file as Fix the cart total');
});
