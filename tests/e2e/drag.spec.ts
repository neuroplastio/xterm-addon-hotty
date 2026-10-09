// Drags (SPEC §9.1), beyond what the shared vectors show: the pointer held
// outside the terminal and away from other surfaces and the program's mouse
// reporting, no text selected whatever the document's CSS, a new placement
// that keeps a drag, the order against the blur a press causes, and touch,
// which drags only an element whose touch-action allows no pan its way. And
// presses with Alt (§9.2), which are the program's: its mouse reports or the
// terminal's selection, and the keyboard back.

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

  test("a touch on elements whose touch-action is auto never drags: it scrolls, and a tap is a press and a click", async ({ page, browserName }) => {
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

test.describe("§9.1: a touch drags where touch-action allows no pan its way", () => {
  test.use({ hasTouch: true });

  /** One finger (and a second), through one CDP session: a touch is the
   * session's from its start to its end. Moves go in steps of 3 pixels, so
   * the touch passes the slop in their direction. */
  async function finger(page: Page) {
    const cdp = await page.context().newCDPSession(page);
    let at = { x: 0, y: 0 };
    const send = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[], alt = false) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points, modifiers: alt ? 1 : 0 });
    return {
      down: async (x: number, y: number, alt = false) => {
        at = { x, y };
        await send("touchStart", [at], alt);
      },
      move: async (dx: number, dy: number) => {
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 3));
        const from = at;
        for (let i = 1; i <= n; i++) await send("touchMove", [{ x: from.x + (dx * i) / n, y: from.y + (dy * i) / n }]);
        at = { x: from.x + dx, y: from.y + dy };
      },
      second: (x: number, y: number) => send("touchStart", [at, { x, y }]),
      both: (dx: number, dy: number, other: { x: number; y: number }) => send("touchMove", [{ x: at.x + dx, y: at.y + dy }, { x: other.x + dx, y: other.y + dy }]),
      up: () => send("touchEnd", []),
    };
  }

  const ROWS =
    `<style>body{margin:0}div{height:var(--hotty-cell-h);width:calc(20*var(--hotty-cell-w))}</style>` +
    `<div id=px data-on=drag style="touch-action:pan-x">x</div><div id=py data-on=drag style="touch-action:pan-y">y</div>` +
    `<div id=nn data-on=drag style="touch-action:none">n</div><div id=au data-on=drag>a</div>`;

  /** Whether a swipe from an element's left part, by (dx, dy) pixels,
   * started a drag of it. */
  async function drags(page: Page, id: string, dx: number, dy: number): Promise<boolean> {
    const f = await finger(page);
    const r = (await surface(page, "x").locator(`#${id}`).boundingBox())!;
    await f.down(r.x + 10, r.y + r.height / 2);
    await f.move(dx, dy);
    await f.up();
    const got = evs((await take(page)).msgs);
    return got.some((e) => e[1] === "dragstart" && e[2] === id);
  }

  test("pan-x drags vertically, pan-y horizontally, none both ways, auto never", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await place(page, "x", ROWS, "4");
    const want: Record<string, [boolean, boolean]> = { px: [false, true], py: [true, false], nn: [true, true], au: [false, false] };
    for (const [id, [across, down]] of Object.entries(want)) {
      expect(await drags(page, id, 40, 0), `${id} across`).toBe(across);
      expect(await drags(page, id, 0, 30), `${id} down`).toBe(down);
    }
  });

  test("the touch-action that counts is the touched element's, with its ancestors'", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await place(
      page,
      "x",
      `<style>body{margin:0}div,section{height:var(--hotty-cell-h);width:calc(20*var(--hotty-cell-w))}span{display:inline-block;width:calc(4*var(--hotty-cell-w))}</style>` +
        // pan-y on the element, pan-x on what is touched in it: neither.
        `<div id=g data-on=drag style="touch-action:pan-y"><span id=k style="touch-action:pan-x">k</span></div>` +
        // pan-x on an ancestor of an element that leaves it auto.
        `<section style="touch-action:pan-x"><div id=a data-on=drag>a</div></section>`,
      "3",
    );
    // On the span: no pan allowed, so a vertical swipe drags g, the element
    // that opts in.
    const f = await finger(page);
    const k = (await surface(page, "x").locator("#k").boundingBox())!;
    await f.down(k.x + 5, k.y + k.height / 2);
    await f.move(0, 30);
    await f.up();
    expect(evs((await take(page)).msgs).some((e) => e[1] === "dragstart" && e[2] === "g")).toBe(true);
    // Beside the span, g's own pan-y: a vertical swipe pans.
    const g = (await surface(page, "x").locator("#g").boundingBox())!;
    await f.down(g.x + g.width - 10, g.y + g.height / 2);
    await f.move(0, 30);
    await f.up();
    expect(evs((await take(page)).msgs).some((e) => e[1] === "dragstart")).toBe(false);
    // Under the section's pan-x: a horizontal swipe pans, a vertical one drags.
    expect(await drags(page, "a", 40, 0)).toBe(false);
    expect(await drags(page, "a", 0, 30)).toBe(true);
  });

  test("a second finger ends the drag with no target, and the surface hears nothing more until every finger lifts", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await place(page, "x", ROWS, "4");
    const f = await finger(page);
    const r = (await surface(page, "x").locator("#nn").boundingBox())!;
    await f.down(r.x + 10, r.y + r.height / 2);
    await f.move(30, 0);
    expect(evs((await take(page)).msgs).map((e) => [e[1], e[2]])).toEqual([["dragstart", "nn"]]);
    const other = { x: r.x + 100, y: r.y + r.height / 2 };
    await f.second(other.x, other.y);
    const ended = (await take(page)).msgs.filter((m) => m.get("a") === "ev");
    expect(ended.map((m) => [m.get("e"), m.get("t")])).toEqual([["dragend", ""]]);
    expect((ended[0]!.json as { r: number }).r).toBe(2);
    await f.both(20, 0, other);
    await f.up();
    expect(evs((await take(page)).msgs)).toEqual([]);
  });

  test("a long press, or Alt held at the touch, never drags", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await place(page, "x", ROWS, "4");
    const r = (await surface(page, "x").locator("#nn").boundingBox())!;
    const f = await finger(page);
    await f.down(r.x + 10, r.y + r.height / 2);
    await page.waitForTimeout(600);
    await f.move(40, 0);
    await f.up();
    expect(evs((await take(page)).msgs).some((e) => e[1] === "dragstart")).toBe(false);
    await f.down(r.x + 10, r.y + r.height / 2, true);
    await f.move(40, 0);
    await f.up();
    expect(evs((await take(page)).msgs).some((e) => e[1] === "dragstart")).toBe(false);
  });

  test("a finger that leaves the element it drags is still the drag's: a drag for each cell, with no target, until it lifts", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await place(
      page,
      "x",
      `<style>body{margin:0}#track{height:var(--hotty-cell-h);width:calc(20*var(--hotty-cell-w));touch-action:pan-y}</style><div id=track data-on=drag>track</div>`,
      "4",
    );
    const r = (await surface(page, "x").locator("#track").boundingBox())!;
    const cw = r.width / 20;
    const f = await finger(page);
    await f.down(r.x + cw / 2, r.y + r.height / 2);
    await f.move(2 * cw, 0); // along the track: the drag starts
    await f.move(0, 2 * r.height); // two rows below it
    await f.move(4 * cw, 0); // and on, to the right
    await f.up();
    // Along the track, the element under the finger stays the same: no
    // drag. Off it, a drag for each cell, with no target, and the lift.
    expect(evs((await take(page)).msgs).map((e) => [e[1], e[2], e[3]])).toEqual([
      ["dragstart", "track", { c: 0, r: 0, keys: [] }],
      ...[[2, 1], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2]].map(([c, r]) => ["drag", "", { c, r, keys: [] }]),
      ["dragend", "", { c: 6, r: 2, keys: [] }],
    ]);
  });

  test("in a document that scrolls, a drag element still drags its way and pans the other, and touch-action elsewhere stops no pan", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await send(
      page,
      { a: "doc", s: "x", scroll: "1", q: "2" },
      `<style>body{margin:0}#box{height:calc(3*var(--hotty-cell-h));overflow:auto}#box>div{height:calc(2*var(--hotty-cell-h));width:calc(20*var(--hotty-cell-w))}</style>` +
        `<div id=box><div id=d data-on=drag style="touch-action:pan-y">d</div><div id=w style="touch-action:none">w</div><div>1</div><div>2</div><div>3</div></div>`,
    );
    await send(page, { a: "place", s: "x", c: "30", r: "3", q: "2" });
    await take(page);
    const box = surface(page, "x").locator("#box");
    const f = await finger(page);
    // Across d: a drag.
    const d = (await surface(page, "x").locator("#d").boundingBox())!;
    await f.down(d.x + 10, d.y + 5);
    await f.move(40, 0);
    await f.up();
    expect(evs((await take(page)).msgs).map((e) => [e[1], e[2]])).toEqual([
      ["dragstart", "d"],
      ["dragend", "d"],
    ]);
    // Up over d, which allows pan-y: the box scrolls, and no drag.
    await f.down(d.x + 10, d.y + d.height - 4);
    await f.move(0, -20);
    await f.up();
    await expect.poll(() => box.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(evs((await take(page)).msgs)).toEqual([]);
    // Up over w, whose touch-action is none but which does not drag: the
    // box scrolls all the same.
    await box.evaluate((el) => (el.scrollTop = 0));
    const w = (await surface(page, "x").locator("#w").boundingBox())!;
    await f.down(w.x + 10, w.y + 10);
    await f.move(0, -20);
    await f.up();
    await expect.poll(() => box.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(evs((await take(page)).msgs)).toEqual([]);
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
