import { defineConfig } from '@playwright/test';

// CI machines have no GPU, so WebGL runs in software (SwiftShader). There a reload takes ~2.6 s to show the agents
// instead of ~0.25 s on a Mac's GPU, almost all of it a synchronous GPU read-back for the agents' face pictures.
// So CI gets more time per assertion; a Mac uses its real GPU, keeps the default 5 s, and runs the speed test.
const ci = !!process.env.CI, gpu = !ci && process.platform === 'darwin';

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  expect: { timeout: ci ? 15_000 : 5_000 },
  workers: 1,
  reporter: ci ? 'github' : 'list',
  use: {
    browserName: 'chromium', viewport: { width: 1280, height: 800 },
    launchOptions: { args: gpu ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
  },
});
