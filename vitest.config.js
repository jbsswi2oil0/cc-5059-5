import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // UI specs live in tests/ too; they need a real browser via Playwright.
    include: ['tests/**/*.test.js'],
  },
});
