import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:1420', channel: 'chrome', viewport: { width: 1440, height: 1000 }, headless: true, screenshot: 'only-on-failure' },
  webServer: [
    { command: 'npm run dev', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI },
    { command: 'go run ./cmd/our-pets', cwd: '..', url: 'http://127.0.0.1:19377/healthz', reuseExistingServer: false,
      env: { OURPETS_BIND: '127.0.0.1:19377', OURPETS_DATA: `/tmp/our-pets-ui-${process.pid}`, OURPETS_INVITE: 'test-only-invite', OURPETS_SAMPLE_ENABLED: 'false', GOCACHE: '/tmp/our-pets-go-cache' } },
  ],
});
