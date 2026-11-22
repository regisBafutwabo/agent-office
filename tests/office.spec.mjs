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

// Software WebGL (CI) is ~10x slower and says nothing about what people see, so this runs only on a real GPU.
test('a reload shows the agents within a second', async ({ page, office }) => {
  await open(page, office);
  const gl = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl'), e = g.getExtension('WEBGL_debug_renderer_info'); return g.getParameter(e.UNMASKED_RENDERER_WEBGL); });
  test.skip(/SwiftShader/i.test(gl), `software WebGL (${gl})`);
  await office.hook({ hook_event_name: 'SessionStart', session_id: 'speed', cwd: '/tmp/e2e-speed' });
  await office.hook({ hook_event_name: 'UserPromptSubmit', session_id: 'speed', cwd: '/tmp/e2e-speed', prompt: 'Check the speed' });
  await expect(row(page, 'Check the speed')).toBeVisible();
  const times = [];
  for (let i = 0; i < 3; i++) { const t = Date.now(); await page.reload(); await expect(row(page, 'Check the speed')).toBeVisible(); times.push(Date.now() - t); }
  expect(Math.min(...times), `reload times ${times.join(', ')} ms`).toBeLessThan(1000);
});
