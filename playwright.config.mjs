import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { browserName: 'chromium', viewport: { width: 1280, height: 800 }, launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] } },
});
