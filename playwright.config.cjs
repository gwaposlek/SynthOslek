const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium', headless: true },
  webServer: { command: 'node tests/server.cjs', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI, timeout: 30000 },
});
