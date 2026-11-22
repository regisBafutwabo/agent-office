import { test as base, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../bridge/server.js', import.meta.url));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

// A bridge of its own per test, with its own keys, so tests never see a real office or each other.
export const test = base.extend({
  office: async ({}, use) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-e2e-')), data = path.join(root, 'data'), port = await freePort();
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, HOME: path.join(root, 'home'), AGENT_OFFICE_DATA: data, AGENT_OFFICE_PACKS: path.join(root, 'packs'), AGENT_OFFICE_PORT: String(port), AGENT_OFFICE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
    await expect.poll(() => log, { timeout: 15_000 }).toContain('#k=');
    const key = log.match(/#k=(\S+)/)[1], url = `http://127.0.0.1:${port}`;
    const hookKey = fs.readFileSync(path.join(data, 'hook-token'), 'utf8').trim().replace(/^X-Agent-Office-Token:\s*/i, '');
    const hook = async payload => {
      const r = await fetch(url + '/hook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Office-Token': hookKey }, body: JSON.stringify(payload) });
      expect(r.status).toBe(204);
    };
    await use({ url, key, hook, root, log: () => log });
    child.kill(); fs.rmSync(root, { recursive: true, force: true });
  },
  // Skip the welcome, the tour and the city picker; fail the test on any uncaught page error.
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => { if (!localStorage.getItem('agent-office:ui')) localStorage.setItem('agent-office:ui', JSON.stringify({ guideDone: true, city: 'generic' })); });
    await use(page);
    expect(errors, 'uncaught page errors').toEqual([]);
  },
});
export { expect };

export const open = async (page, office) => {
  await page.goto(`${office.url}/#k=${office.key}`);
  await expect(page.locator('body')).toHaveClass(/live/);
};
export const row = (page, name) => page.locator('#roster .agent-row', { hasText: name });
