// Bub-n-Bros (examples/bubbros.py), unchanged game, through the bridge:
// hundreds of sprites, a handful of deltas a frame, and key releases from the
// kitty keyboard protocol (SPEC §10.3). Skipped when the game is not fetched
// (scripts/bubbros-fetch.sh in the hotty repository).

import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOTTY_DIR } from "../hotty.ts";

const game = join(HOTTY_DIR, "..", "bubbros", "bubbob");
test.skip(!existsSync(game), "the game is not fetched: scripts/bubbros-fetch.sh");

test("the game runs, sends deltas to a few sprites a frame, and hears key presses and releases", async ({ page }, info) => {
  test.setTimeout(60_000);
  const log = info.outputPath("keys.log");
  rmSync(log, { force: true });
  await page.goto(`/?run=bubbros&args=${encodeURIComponent(`--log ${log}`)}`);
  const status = page.locator(".xterm-rows");
  await expect(status).toContainText("keys: kitty", { timeout: 20_000 });
  const sprites = page.frameLocator(".hotty-surface iframe").locator(".s");
  expect(await sprites.count()).toBeGreaterThan(300);
  // Once the level is up, frames touch few sprites (the first second
  // includes creating them all).
  const changed = async () => Number(/([\d.]+) changed\/frame/.exec(await status.innerText())?.[1] ?? 999);
  await expect.poll(changed, { timeout: 10_000 }).toBeLessThan(40);

  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(1000);
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("KeyW"); // the second player joins and jumps
  await page.waitForTimeout(200);
  await page.keyboard.up("KeyW");
  await expect.poll(() => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0)).toBe(4);
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "));
  expect(lines.map((l) => l.slice(1).join(" "))).toEqual(["press 0 Right", "release 0 Right", "press 1 Jump", "release 1 Jump"]);
  // One press and one release, a held second apart: no auto-repeat presses.
  expect(Number(lines[1]![0]) - Number(lines[0]![0])).toBeGreaterThan(0.8);
  await page.keyboard.press("q");
  await expect.poll(() => page.evaluate(() => (window as unknown as { hotty: { exited: boolean } }).hotty.exited)).toBe(true);
});
