import { defineConfig, firefox } from "@playwright/test";
import { existsSync } from "node:fs";

const port = Number(process.env.HOTTY_PORT ?? 8766);

// Chromium always; Firefox too once installed (`npx playwright install
// firefox`, no root). HOTTY_BROWSERS=chromium,firefox chooses explicitly.
const browsers = (process.env.HOTTY_BROWSERS?.split(",") ?? ["chromium", ...(existsSync(firefox.executablePath()) ? ["firefox"] : [])]) as (
  | "chromium"
  | "firefox"
)[];

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  workers: 2,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}/`,
    viewport: { width: 1100, height: 700 },
  },
  webServer: {
    command: `python3 serve.py --examples --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
  },
  projects: browsers.map((name) => ({ name, use: { browserName: name } })),
});
