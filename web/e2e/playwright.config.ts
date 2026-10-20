// Playwright harness (F1). Uses the installed Google Chrome (no browser download) and the
// viewport matrix of gate G6: 360x780, 375x812, 390x844, 412x915, 768x1024, 1280x800 (plus a
// 320 header smoke inside shell.spec.ts). The dev server is Vite proxied read-only to
// production data on port 5199; an already running server on that port is reused.
//
//   npm run e2e                         every spec, every viewport
//   npm run e2e -- --project=375x812    one viewport
//   npm run e2e -- shell.spec.ts        one spec
//
// Each screen owner adds web/e2e/<screen>.spec.ts; shared helpers are in helpers.ts.
import { defineConfig, type Project } from '@playwright/test';
import { VIEWPORTS } from './helpers';

// E2E_PORT: run against another dev server (default 5199). E2E_OUT: a private results folder, so two
// runs never clear each other's traces. The server the harness starts has HMR off (NT_NO_HMR), so an
// edit elsewhere never reloads a page mid-test.
const PORT = Number(process.env.E2E_PORT) || 5199;
const OUT = process.env.E2E_OUT || '../../scripts/out/e2e-results';

const projects: Project[] = VIEWPORTS.map((v) => ({
  name: `${v.width}x${v.height}`,
  use: {
    channel: 'chrome',
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.width < 768 ? 2 : 1,
    isMobile: v.width < 768,
    hasTouch: v.width < 768,
  },
}));

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: OUT,
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    headless: true,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects,
  webServer: {
    command: 'npx vite --config web/vite.config.ts',
    cwd: '../..',
    env: { API_TARGET: process.env.API_TARGET || 'https://namada.trade', PORT: String(PORT), NT_NO_HMR: '1' },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
