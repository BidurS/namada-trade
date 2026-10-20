// Vitest: the unit and replay tests in test/. Playwright specs (web/e2e) and copies of the
// tree in .claude/ worktrees are not Vitest tests.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'web/e2e/**', '.claude/**'],
  },
});
