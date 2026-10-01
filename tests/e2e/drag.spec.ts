// Drags (SPEC §9.1), beyond what the shared vectors show: the pointer held
// outside the terminal and away from other surfaces and the program's mouse
// reporting, no text selected whatever the document's CSS, a new placement
// that keeps a drag, the order against the blur a press causes, and touch,
// which never drags.

import { expect, test, type Page } from "@playwright/test";
import { open, send, surface, take, write } from "./helpers.ts";

const evs = (msgs: Awaited<ReturnType<typeof take>>["msgs"]) =>
  msgs.filter((m) => m.get("a") === "ev").map((m) => [m.get("s"), m.get("e"), m.get("t"), m.json]);

/** Two cells, three columns wide each, the second with text to select. */
const CELLS =
  `<style>body{margin:0}i{position:absolute;top:0;height:var(--hotty-cell-h);width:calc(3*var(--hotty-cell-w));font-style:normal;user-select:text}</style>` +
  `<i id=a data-on="click drag" style="left:0">Alpha</i><i id=b data-on=drag style="left:calc(3*var(--hotty-cell-w))">Beta</i>` +
  `<p id=prose style="position:absolute;top:var(--hotty-cell-h);margin:0">some plain prose to select</p>`;

/** A mouse in the page's coordinates. In Chromium through CDP: Playwright's
 * own mouse stalls on a press that moves inside a frame without scripts. */
async function mouse(page: Page, browser: string) {
  const cdp = browser === "chromium" ? await page.context().newCDPSession(page) : null;
  let down = false;
  const go = async (type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number) => {
    if (type === "mousePressed") down = true;
    if (type === "mouseReleased") down = false;
    if (cdp) {
      await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: down ? 1 : 0, clickCount: 1 });
      return;
    }
    if (type === "mouseMoved") await page.mouse.move(x, y);
    else if (type === "mousePressed") await page.mouse.down();
    else await page.mouse.up();
  };
  return {
    move: (x: number, y: number) => go("mouseMoved", x, y),
    down: (x: number, y: number) => go("mouseMoved", x, y).then(() => go("mousePressed", x, y)),
    up: (x: number, y: number) => go("mouseMoved", x, y).then(() => go("mouseReleased", x, y)),
  };
}

/** The centre of an element of a surface, in the page. */
async function centre(page: Page, s: string, id: string): Promise<[number, number]> {
  const r = (await surface(page, s).locator(`#${id}`).boundingBox())!;
  return [r.x + r.width / 2, r.y + r.height / 2];
}

async function place(page: Page, s: string, html: string, rows = "2", extra: Record<string, string> = {}) {
  await send(page, { a: "doc", s, q: "2" }, html);
  await send(page, { a: "place", s, c: "30", r: rows, q: "2", ...extra });
  await take(page);
}

test.beforeEach(async ({ page }) => open(page, "?pty=0"));

test("the drag holds the pointer: outside the terminal, over another surface, and none of it reaches the program's mouse", async ({ page, browserName }) => {
  // The program asked for mouse reports (button motion, SGR): a drag on the
  // surface sends none, wherever it goes.
  await write(page, "\x1b[?1002h\x1b[?1006h");
  await place(page, "x", CELLS);
  await place(page, "y", `<style>body{margin:0}</style><div id=other data-on="click drag" style="height:100vh">other</div>`);
  const m = await mouse(page, browserName);
  const [ax, ay] = await centre(page, "x", "a");
  const [ox, oy] = await centre(page, "y", "other");
  await m.down(ax, ay);
  await m.move(ox, oy); // over the other surface, two rows below
  await m.move(2, 2); // outside the terminal's element, above and left of the surface
  await m.move(700, 650); // over the cells, far below
  await m.up(700, 650);
  const { msgs, raw } = await take(page);
  const got = evs(msgs);
  expect(got[0]).toEqual(["x", "dragstart", "a", { c: 1, r: 0, keys: [] }]);
  expect(got.at(-1)?.slice(0, 3)).toEqual(["x", "dragend", ""]);
  // Every event is the dragged surface's, none the other's.
  expect(got.every((e) => e[0] === "x")).toBe(true);
  // Outside the terminal, the cell counts on past the surface's top left.
  const cells = got.map((e) => e[3] as { c: number; r: number });
  expect(cells.some((d) => d.c < 0 && d.r < 0)).toBe(true);
  expect(cells.some((d) => d.r >= 2)).toBe(true);
  // No mouse report for the drag reached the program.
  expect(raw).not.toMatch(/\x1b\[</);
});

test("a drag selects no text, whatever the document's CSS; plain text still selects", async ({ page, browserName }) => {
  await place(page, "x", CELLS);
  const m = await mouse(page, browserName);
  const sel = () => surface(page, "x").locator("body").evaluate((b) => b.ownerDocument.getSelection()?.toString() ?? "");
  const [ax, ay] = await centre(page, "x", "a");
  const [bx, by] = await centre(page, "x", "b");
  await m.down(ax - 8, ay);
  await m.move(bx, by);
  await m.up(bx + 8, by);
  expect(await sel()).toBe("");
  expect(evs((await take(page)).msgs).map((e) => e[1])).toEqual(["dragstart", "drag", "dragend"]);
  // Prose that does not opt in is selected as before (SPEC §9: local).
  const p = (await surface(page, "x").locator("#prose").boundingBox())!;
  await m.down(p.x + 2, p.y + p.height / 2);
  await m.up(p.x + p.width - 2, p.y + p.height / 2);
  expect((await sel()).length).toBeGreaterThan(5);
  expect(evs((await take(page)).msgs)).toEqual([]);
});

test("a new placement keeps a drag; scrolling it out of view ends it", async ({ page, browserName }) => {
  await place(page, "x", CELLS);
  const m = await mouse(page, browserName);
  const [ax, ay] = await centre(page, "x", "a");
  await m.down(ax, ay);
  await take(page);
  // Placed again (with C=1, where the cursor is: below the first placement).
  await send(page, { a: "place", s: "x", c: "30", r: "2", C: "1", q: "2" });
  expect(evs((await take(page)).msgs)).toEqual([]);
  const [bx, by] = await centre(page, "x", "b");
  await m.move(bx, by);
  expect(evs((await take(page)).msgs)).toEqual([["x", "drag", "b", { c: 4, r: 0, keys: [] }]]);
  // Its line scrolls off the screen: the drag ends there.
  await write(page, "\r\n".repeat(60));
  expect(evs((await take(page)).msgs)).toEqual([["x", "dragend", "", { c: 4, r: 0, keys: [] }]]);
  await m.up(bx, by);
  expect(evs((await take(page)).msgs)).toEqual([]);
});

test("dragstart comes before the change and the blur its press causes", async ({ page, browserName }) => {
  await place(page, "f", `<input id=name value=x>`, "2");
  await place(page, "x", CELLS);
  await send(page, { a: "focus", s: "f", t: "name", q: "2" });
  await page.keyboard.type("yz");
  await take(page);
  const m = await mouse(page, browserName);
  const [ax, ay] = await centre(page, "x", "a");
  await m.down(ax, ay);
  await m.up(ax, ay);
  await page.waitForTimeout(50);
  const got = evs((await take(page)).msgs).map((e) => [e[0], e[1], e[2]]);
  expect(got).toEqual([
    ["x", "dragstart", "a"],
    ["f", "change", "name"],
    ["f", "blur", ""],
    // Released where it began: the click follows the drag's end.
    ["x", "dragend", "a"],
    ["x", "click", "a"],
  ]);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a touch never drags: it scrolls, and a tap is a click", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await write(page, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n");
    await place(page, "x", CELLS, "2");
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    type Scrolling = { buffer: { active: { viewportY: number } } };
    const viewportY = () => page.evaluate(() => (window.hotty.term as unknown as Scrolling).buffer.active.viewportY);
    const [ax, ay] = await centre(page, "x", "a");
    const bottom = await viewportY();
    await touch("touchStart", [{ x: ax, y: ay }]);
    for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x: ax, y: ay + i * 12 }]);
    await touch("touchEnd", []);
    await expect.poll(viewportY).toBeLessThan(bottom);
    expect(evs((await take(page)).msgs)).toEqual([]);
    // Back at the bottom, a tap on the element is a click, and no drag.
    await page.evaluate(() => (window.hotty.term as unknown as { scrollToBottom(): void }).scrollToBottom());
    const [tx, ty] = await centre(page, "x", "a");
    await touch("touchStart", [{ x: tx, y: ty }]);
    await touch("touchEnd", []);
    await expect.poll(async () => evs((await take(page)).msgs)).toEqual([["x", "click", "a", null]]);
  });
});
