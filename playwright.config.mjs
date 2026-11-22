import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  // CI renders the 3D office in software, about 2.5x slower than a Mac: a reload can take longer than 5 s to show agents.
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] } },
});
