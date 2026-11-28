import { defineConfig } from '@playwright/test';

// CI machines have no GPU, so WebGL runs in software (SwiftShader). There a reload takes ~2.6 s to show the agents
// instead of ~0.25 s on a Mac's GPU, almost all of it a synchronous GPU read-back for the agents' face pictures.
// So CI gets more time per assertion; a Mac uses its real GPU, keeps the default 5 s, and runs the speed test.
const ci = !!process.env.CI, gpu = !ci && process.platform === 'darwin';

export default defineConfig({
  testDir: 'tests',
  // The same 3x for a whole test: CI draws about one frame every 0.7 s, so a click takes ~10 s to return and a long
  // test (coming-back.spec.mjs has 14 steps) ran past 60 s without any check failing.
  timeout: ci ? 180_000 : 60_000,
  expect: { timeout: ci ? 15_000 : 5_000 },
  workers: 1,
  // On CI, try a failed test once more and keep a trace of that retry, so a failure can be opened in the trace viewer.
  retries: ci ? 1 : 0,
  // On CI, list each test with its time as well, so a slow one shows in the log.
  reporter: ci ? [['github'], ['list']] : 'list',
  use: {
    browserName: 'chromium', viewport: { width: 1280, height: 800 },
    trace: ci ? 'on-first-retry' : 'off',
    launchOptions: { args: gpu ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
  },
});
