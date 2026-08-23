import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  reporter: 'list',
  use: {
    baseURL: process.env.ANTBOT_E2E_URL ?? 'http://127.0.0.1:4780',
    headless: true,
  },
});
