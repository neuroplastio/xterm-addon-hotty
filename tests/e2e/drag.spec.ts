// Drags (SPEC §9.1), beyond what the shared vectors show: the pointer held
// outside the terminal and away from other surfaces and the program's mouse
// reporting, no text selected whatever the document's CSS, a new placement
// that keeps a drag, the order against the blur a press causes, and touch,
// which never drags. And presses with Alt (§9.2), which are the program's:
// its mouse reports or the terminal's selection, and the keyboard back.

import { expect, test, type Page } from "@playwright/test";
import { open, sansArea, send, surface, take, write } from "./helpers.ts";

const evs = (msgs: Awaited<ReturnType<typeof take>>["msgs"]) =>
  msgs.filter((m) => m.get("a") === "ev").map((m) => [m.get("s"), m.get("e"), m.get("t"), sansArea(m.json)]);

/** Two cells, three columns wide each, the second with text to select. */
const CELLS =
  `<style>body{margin:0}i{position:absolute;top:0;height:var(--hotty-cell-h);width:calc(3*var(--hotty-cell-w));font-style:normal;user-select:text}</style>` +
  `<i id=a data-on="click drag" style="left:0">Alpha</i><i id=b data-on=drag style="left:calc(3*var(--hotty-cell-w))">Beta</i>` +
  `<p id=prose style="position:absolute;top:var(--hotty-cell-h);margin:0">some plain prose to select</p>`;

/** A mouse in the page's coordinates, with Alt held when `alt` says so. In
 * Chromium through CDP: Playwright's own mouse stalls on a press that moves
 * inside a frame without scripts. Firefox's mouse events carry the
 * keyboard's modifiers: Alt is pressed on the keyboard there. */
async function mouse(page: Page, browser: string) {
  const cdp = browser === "chromium" ? await page.context().newCDPSession(page) : null;
  let down = false;
  const go = async (type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, alt: boolean) => {
    if (type === "mousePressed") down = true;
    if (type === "mouseReleased") down = false;
    if (cdp) {
      await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: down ? 1 : 0, clickCount: 1, modifiers: alt ? 1 : 0 });
      return;
    }
    if (alt) await page.keyboard.down("Alt");
    if (type === "mouseMoved") await page.mouse.move(x, y);
    else if (type === "mousePressed") await page.mouse.down();
    else await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
  };
  return {
    move: (x: number, y: number, alt = false) => go("mouseMoved", x, y, alt),
    down: (x: number, y: number, alt = false) => go("mouseMoved", x, y, alt).then(() => go("mousePressed", x, y, alt)),
    up: (x: number, y: number, alt = false) => go("mouseMoved", x, y, alt).then(() => go("mouseReleased", x, y, alt)),
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

  test("a touch never drags: it scrolls, and a tap is a press and a click", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await write(page, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n");
    await place(page, "x", CELLS, "2", { p: "1" });
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
    await expect.poll(async () => evs((await take(page)).msgs)).toEqual([
      ["x", "press", "a", null],
      ["x", "click", "a", null],
    ]);
  });
});

test.describe("§9.2: a press with Alt is the program's", () => {
  /** The terminal's cell under a point in the page, 1-based, as mouse
   * reports count. */
  const cellAt = (page: Page, x: number, y: number) =>
    page.evaluate(
      ([x, y]) => {
        const r = document.querySelector(".xterm-screen")!.getBoundingClientRect();
        const t = window.hotty.term;
        return [Math.floor(((x - r.left) / r.width) * t.cols) + 1, Math.floor(((y - r.top) / r.height) * t.rows) + 1];
      },
      [x, y] as const,
    );

  test("with mouse reporting on, the program hears the press, its moves over the surface and its release, with Alt; the surface hears nothing", async ({ page, browserName }) => {
    // Button motion and SGR.
    await write(page, "\x1b[?1002h\x1b[?1006h");
    await place(page, "x", CELLS, "2", { p: "1" });
    const m = await mouse(page, browserName);
    const [ax, ay] = await centre(page, "x", "a");
    const [bx, by] = await centre(page, "x", "b");
    await m.down(ax, ay, true);
    await m.move(bx, by, true);
    // The surface under the pointer is no longer hovered.
    expect(await surface(page, "x").locator("#b").evaluate((e) => e.matches(":hover"))).toBe(false);
    await m.up(bx, by, true);
    const { msgs, raw } = await take(page);
    expect(evs(msgs)).toEqual([]);
    const [ac, ar] = await cellAt(page, ax, ay);
    const [bc, br] = await cellAt(page, bx, by);
    // Button 0 with Alt (8); motion adds 32. A release ends in `m`.
    expect(raw).toContain(`\x1b[<8;${ac};${ar}M`);
    expect(raw).toContain(`\x1b[<40;${bc};${br}M`);
    expect(raw).toMatch(new RegExp(`\\x1b\\[<8;${bc};${br}m$`));
    // The surface took no focus: the terminal has it.
    await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? "")).toContain("xterm-helper-textarea");
    // The gesture over: a press without Alt is the surface's again.
    await m.down(ax, ay);
    await m.up(ax, ay);
    const after = await take(page);
    expect(evs(after.msgs).map((e) => [e[1], e[2]])).toEqual([
      ["press", "a"],
      ["dragstart", "a"],
      ["dragend", "a"],
      ["click", "a"],
    ]);
    expect(after.raw).not.toMatch(/\x1b\[</);
  });

  test("Alt let go during the gesture keeps it the program's, outside the surface too", async ({ page, browserName }) => {
    await write(page, "\x1b[?1003h\x1b[?1006h");
    await place(page, "x", CELLS);
    const m = await mouse(page, browserName);
    const [ax, ay] = await centre(page, "x", "a");
    await m.down(ax, ay, true);
    await m.move(ax, ay + 100); // over the cells, without Alt
    await m.up(ax, ay + 100);
    const { msgs, raw } = await take(page);
    expect(evs(msgs)).toEqual([]);
    const [c, r] = await cellAt(page, ax, ay + 100);
    expect(raw).toContain(`\x1b[<32;${c};${r}M`);
    expect(raw).toContain(`\x1b[<0;${c};${r}m`);
  });

  test("with mouse reporting off, the terminal selects, as on the cells; nothing in the surface is selected", async ({ page, browserName }) => {
    await write(page, Array.from({ length: 4 }, (_, i) => `row ${i} of text under the surface`).join("\r\n") + "\x1b[H");
    await send(page, { a: "doc", s: "x", q: "2" }, CELLS);
    await send(page, { a: "place", s: "x", c: "30", r: "2", C: "1", q: "2" });
    await take(page);
    const m = await mouse(page, browserName);
    const [ax, ay] = await centre(page, "x", "a");
    await m.down(ax - 8, ay, true);
    await m.move(ax + 60, ay + 40, true);
    await m.up(ax + 60, ay + 40, true);
    expect(evs((await take(page)).msgs)).toEqual([]);
    const selected = await page.evaluate(() => (window.hotty.term as unknown as { getSelection(): string }).getSelection());
    expect(selected).toMatch(/ow 0[^]*ow 1/);
    const inSurface = await surface(page, "x").locator("body").evaluate((b) => b.ownerDocument.getSelection()?.toString() ?? "");
    expect(inSurface).toBe("");
  });

  test("a surface with the keyboard gives it back: blur, and no focus for the pressed one", async ({ page, browserName }) => {
    await write(page, "\x1b[?1002h\x1b[?1006h");
    await place(page, "f", `<input id=name value=x>`);
    await place(page, "x", `<input id=other value=y>`, "2", { p: "1" });
    await send(page, { a: "focus", s: "f", t: "name", q: "2" });
    await page.keyboard.press("End");
    await page.keyboard.type("z");
    await take(page);
    const m = await mouse(page, browserName);
    const r = (await surface(page, "x").locator("#other").boundingBox())!;
    await m.down(r.x + 4, r.y + r.height / 2, true);
    await m.up(r.x + 4, r.y + r.height / 2, true);
    await page.waitForTimeout(50);
    const { msgs, raw } = await take(page);
    // The edited field commits, as it does whenever the keyboard leaves.
    expect(evs(msgs)).toEqual([
      ["f", "change", "name", { value: "xz" }],
      ["f", "blur", "", null],
    ]);
    expect(raw).toMatch(/\x1b\[<8;\d+;\d+M/);
    await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? "")).toContain("xterm-helper-textarea");
    // Keys are the terminal's now.
    await page.keyboard.type("q");
    expect((await take(page)).raw).toBe("q");
  });
});
