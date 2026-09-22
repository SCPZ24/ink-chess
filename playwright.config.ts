import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5680",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "node bin/ink-chess.mjs --mode local --port 5680 --store /private/tmp/ink-chess-e2e-store",
    url: "http://127.0.0.1:5680/health",
    reuseExistingServer: false,
  },
  reporter: "list",
});
