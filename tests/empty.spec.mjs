import fs from 'node:fs';
import path from 'node:path';
import { test, expect, open, row } from './office.mjs';
import { encode } from '../bridge/discover.js';

test('an empty office names every tool, not only Claude Code', async ({ page, office }) => {
  await open(page, office);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty-title')).toHaveText('No agent sessions yet');
  await expect(page.locator('#empty')).toContainText('Codex');
  await expect(page.locator('#empty')).not.toContainText('claude plugin');
});

test('check again finds a chat that is already running, without waiting for the next scan', async ({ page, office }) => {
  await open(page, office);
  const check = page.locator('#empty-check');
  await expect(check).toBeVisible();
  // A Claude Code chat starts writing its log after the office's first look.
  const proj = path.join(office.root, 'home', 'code', 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const dir = path.join(office.root, 'home', '.claude', 'projects', encode(proj));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'found1.jsonl'), [
    { type: 'user', cwd: proj, entrypoint: 'cli', message: { content: 'tidy the cart' } },
    { type: 'ai-title', aiTitle: 'Tidy the cart' },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  await check.click();
  // The server answers once it has looked: the button comes back long before its 5 s fallback.
  await expect(check).toHaveText('Check again', { timeout: 2000 });
  await expect(row(page, 'Tidy the cart')).toBeVisible({ timeout: 2000 });
});
