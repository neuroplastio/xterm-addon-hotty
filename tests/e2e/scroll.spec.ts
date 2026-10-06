// Nothing in a surface scrolls unless its document asks, and the gestures
// that scroll are the terminal's (SPEC §5.3, §9). A wheel or a touch drag
// over a surface moves the terminal's scrollback; a tap stays the
// surface's. A document with `scroll` scrolls along the axes it asked for,
// as a page does, and hands a gesture on to the terminal at its end. The
// shared vectors check where gestures and keys go (conformance.spec.ts);
// these check what they cannot: pixels, touch, the scrollback, the page.
import { expect, test, type Page } from "@playwright/test";
import { open, send, surface, take, write } from "./helpers.ts";

// Scrollbars as a page has them: headless Chromium hides them all.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const DOC =
  `<style>body{margin:0} #box{height:60px;overflow:auto;background:#223} #tall{height:600px} button{height:30px}</style>` +
  `<div id=box><div id=tall>tall</div></div><button id=b>b</button>`;

/** Scrollback to move through, then the surface at the bottom. */
async function setup(page: Page) {
  await open(page, "?pty=0");
  await write(page, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n");
  await send(page, { a: "doc", s: "s", q: "2" }, DOC);
  await send(page, { a: "place", s: "s", c: "30", r: "6", q: "2" });
  await expect(surface(page, "s").locator("#box")).toBeVisible();
}

type Scrolling = { rows: number; buffer: { active: { viewportY: number } }; scrollToBottom(): void; scrollToLine(line: number): void };
const viewportY = (page: Page) => page.evaluate(() => (window.hotty.term as unknown as Scrolling).buffer.active.viewportY);

test("nothing in a surface scrolls: no scrollbar, no offset, and a wheel over it moves the terminal", async ({ page }) => {
  await setup(page);
  const box = surface(page, "s").locator("#box");
  // No scrollbar, even with overflow: auto.
  expect(await box.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(0);
  const bottom = await viewportY(page);
  await box.hover();
  await page.mouse.wheel(0, -400);
  await expect.poll(() => viewportY(page)).toBeLessThan(bottom);
  expect(await box.evaluate((el) => el.scrollTop)).toBe(0);
  // Whatever scrolls it anyway is put back.
  await box.evaluate((el) => {
    el.scrollTop = 100;
  });
  await expect.poll(() => box.evaluate((el) => el.scrollTop)).toBe(0);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a drag over a surface moves the terminal, and a tap stays the surface's", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await setup(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    const r = (await page.locator('.hotty-surface[data-surface="s"]').boundingBox())!;
    const x = r.x + r.width / 2;
    const bottom = await viewportY(page);
    // The finger moves down, as over the cells: the scrollback comes down.
    await touch("touchStart", [{ x, y: r.y + 10 }]);
    for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x, y: r.y + 10 + i * 12 }]);
    await touch("touchEnd", []);
    await expect.poll(() => viewportY(page)).toBeLessThan(bottom);
    expect(await surface(page, "s").locator("#box").evaluate((el) => el.scrollTop)).toBe(0);

    // A tap on the button is its click, for the program.
    await page.evaluate(() => (window.hotty.term as unknown as Scrolling).scrollToBottom());
    await take(page);
    const b = (await surface(page, "s").locator("#b").boundingBox())!;
    await touch("touchStart", [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }]);
    await touch("touchEnd", []);
    let clicked = false;
    await expect
      .poll(async () => {
        clicked ||= (await take(page)).msgs.some((m) => m.get("e") === "click" && m.get("t") === "b");
        return clicked;
      })
      .toBe(true);
  });

  test("a drag over a surface moves the scrollback the way the finger goes, as far as it goes", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await open(page, "?pty=0");
    // A surface in the middle of the scrollback, and the screen on it.
    await write(page, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n");
    await send(page, { a: "doc", s: "s", q: "2" }, DOC);
    await send(page, { a: "place", s: "s", c: "30", r: "6", q: "2" });
    await write(page, Array.from({ length: 100 }, (_, i) => `more ${i}`).join("\r\n"));
    await page.evaluate(() => (window.hotty.term as unknown as Scrolling).scrollToLine(95));
    await expect(surface(page, "s").locator("#box")).toBeInViewport();
    const cellH = await page.evaluate(() => document.querySelector(".xterm-screen")!.clientHeight / (window.hotty.term as unknown as Scrolling).rows);
    const r = (await page.locator('.hotty-surface[data-surface="s"]').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    // The finger goes up 120 pixels, and rests before it lifts: no fling.
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    await touch("touchStart", [{ x, y }]);
    for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x, y: y - i * 15 }]);
    await page.waitForTimeout(150);
    await touch("touchEnd", []);
    const moved = (await viewportY(page)) - 95;
    expect(Math.abs(moved - 120 / cellH)).toBeLessThanOrEqual(1);
  });

  test("on the cells, a tap is a click and a drag is wheel input, at the finger", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await open(page, "?pty=0");
    // The program asks for mouse reports, SGR encoded, as a TUI does.
    await write(page, "\x1b[?1000h\x1b[?1006h");
    await take(page);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    const r = (await page.locator(".xterm-screen").boundingBox())!;
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    await touch("touchStart", [{ x, y }]);
    await touch("touchEnd", []);
    let raw = "";
    await expect
      .poll(async () => {
        raw += (await take(page)).raw;
        return raw;
      })
      .toMatch(/\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m/);
    raw = "";
    await touch("touchStart", [{ x, y }]);
    for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x, y: y + i * 15 }]);
    await touch("touchEnd", []);
    await expect
      .poll(async () => {
        raw += (await take(page)).raw;
        return raw;
      })
      .toMatch(/\x1b\[<64;\d+;\d+M/);
    expect(raw).not.toContain("NaN");
  });
});

// `scroll: "page"`: the page scrolls, natively, from the surfaces and the
// cells alike, and the terminal, as tall as what it shows, never does.
test.describe("where the page scrolls", () => {
  /** A surface near the top of a terminal three windows tall. */
  async function tall(page: Page) {
    await open(page, "?pty=0&scroll=page");
    await write(page, "top\r\n");
    await send(page, { a: "doc", s: "s", q: "2" }, DOC);
    await send(page, { a: "place", s: "s", c: "30", r: "6", q: "2" });
    await expect(surface(page, "s").locator("#box")).toBeVisible();
    await take(page);
  }
  const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

  test("a wheel over a surface scrolls the page, over an element that would scroll too", async ({ page }) => {
    await tall(page);
    // Over the box (overflow: auto), which nothing scrolls.
    const box = (await surface(page, "s").locator("#box").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 100);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(50);
    expect(await surface(page, "s").locator("#box").evaluate((el) => el.scrollTop)).toBe(0);
    // Over the button below it.
    const before = await scrollY(page);
    const b = (await surface(page, "s").locator("#b").boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, 100);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(before + 50);
    expect(await viewportY(page)).toBe(0);
    expect((await take(page)).raw).toBe("");
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true });

    test("a drag over a surface or the cells scrolls the page, and the program hears nothing", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "touch input comes from CDP");
      await tall(page);
      const cdp = await page.context().newCDPSession(page);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
      const drag = async (at: { x: number; y: number }) => {
        await touch("touchStart", [at]);
        for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x: at.x, y: at.y - i * 15 }]);
        await page.waitForTimeout(150);
        await touch("touchEnd", []);
      };
      // On the box (overflow: auto), which nothing scrolls.
      const box = (await surface(page, "s").locator("#box").boundingBox())!;
      await drag({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await expect.poll(() => scrollY(page)).toBeGreaterThan(60);
      // On the button below it.
      let before = await scrollY(page);
      const b = (await surface(page, "s").locator("#b").boundingBox())!;
      await drag({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      await expect.poll(() => scrollY(page)).toBeGreaterThan(before + 60);
      // On the cells, right of the surface.
      before = await scrollY(page);
      const screen = (await page.locator(".xterm-screen").boundingBox())!;
      await drag({ x: screen.x + screen.width - 40, y: 400 });
      await expect.poll(() => scrollY(page)).toBeGreaterThan(before + 60);
      expect(await surface(page, "s").locator("#box").evaluate((el) => el.scrollTop)).toBe(0);
      expect(await viewportY(page)).toBe(0);
      expect((await take(page)).raw).toBe("");
    });
  });
});

// --- A document that scrolls (SPEC §5.1, §5.3: scroll on a=doc) ----------

/** Ten rows of four cells, a row as wide as forty, and an inner box three
 * rows tall that overflows both ways: a document to scroll. */
const ROWS =
  `<style>body{margin:0}div{height:var(--hotty-cell-h);width:calc(4*var(--hotty-cell-w))}` +
  `#wide{width:calc(40*var(--hotty-cell-w))}` +
  `#box{height:calc(3*var(--hotty-cell-h));width:calc(6*var(--hotty-cell-w));overflow:auto}` +
  `#box div{width:calc(20*var(--hotty-cell-w))}</style>` +
  `<div id=a>a</div><div id=box>${Array.from({ length: 8 }, (_, i) => `<div id=b${i}>b${i}</div>`).join("")}</div>` +
  `<div id=wide>wide</div>${"cdefghij".split("").map((c) => `<div id=${c}>${c}</div>`).join("")}`;

/** Scrollback to move through, then a document that scrolls, placed 10x4. */
async function scrolling(page: Page, scroll = "1", query = "?pty=0") {
  await open(page, query);
  await write(page, Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n");
  await send(page, { a: "doc", s: "s", scroll, q: "2" }, ROWS);
  await send(page, { a: "place", s: "s", c: "10", r: "4", q: "2" });
  await expect(surface(page, "s").locator("#a")).toBeVisible();
  await take(page);
}

const root = (page: Page) => surface(page, "s").locator("html");

/** The width of the browser's scrollbars: 0 where they overlay the content
 * (Firefox on Linux), and take no pixels from it. */
const barWidth = (page: Page) =>
  page.evaluate(() => {
    const d = document.createElement("div");
    d.style.cssText = "overflow:scroll;width:100px;height:100px;position:absolute";
    document.body.append(d);
    const w = d.offsetWidth - d.clientWidth;
    d.remove();
    return w;
  });
const offset = (page: Page, sel: string) =>
  surface(page, "s")
    .locator(sel)
    .evaluate((el) => [el.scrollLeft, el.scrollTop]);

test.describe("a document that scrolls", () => {
  test("scroll=1: the root and an inner box show vertical scrollbars, in pixels; nothing scrolls across or shows a bar for it", async ({ page }) => {
    await scrolling(page);
    const box = surface(page, "s").locator("#box");
    // The vertical bars take pixels inside the rectangle: the root's and the
    // box's widths, never the surface's cells.
    const size = await page.locator('.hotty-surface[data-surface="s"]').boundingBox();
    const cellW = await root(page).evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--hotty-cell-w")));
    expect(Math.abs(size!.width - 10 * cellW)).toBeLessThanOrEqual(1);
    const bar = await barWidth(page);
    if (bar) {
      expect(await root(page).evaluate((el) => el.clientWidth)).toBe(Math.round(10 * cellW) - bar);
      expect(await box.evaluate((el) => (el as HTMLElement).offsetWidth - el.clientWidth)).toBe(bar);
    }
    // Across, clipped as overflow: hidden is, whatever the document's CSS.
    expect(await box.evaluate((el) => (el as HTMLElement).offsetHeight - el.clientHeight)).toBe(0);
    expect(await box.evaluate((el) => getComputedStyle(el).overflowX)).toBe("hidden");
    expect(await root(page).evaluate((el) => getComputedStyle(el).overflowX)).toBe("hidden");
    // The host's own attribute: the document is as the program wrote it.
    const inspected = await page.evaluate(() => (window.hotty as unknown as { addon: { inspect(s: string, id: string): { attrs: object } } }).addon.inspect("s", "box"));
    expect(inspected.attrs).toEqual({ id: "box" });
    // Whatever scrolls it across anyway is put back; down stays.
    await box.evaluate((el) => el.scrollTo(30, 20));
    await expect.poll(() => offset(page, "#box")).toEqual([0, 20]);
    await expect(root(page)).toHaveCSS("touch-action", "pan-y");
  });

  test("scroll=2 scrolls across only; scroll=3 both ways", async ({ page }) => {
    await scrolling(page, "2");
    await surface(page, "s").locator("#box").evaluate((el) => el.scrollTo(30, 20));
    await expect.poll(() => offset(page, "#box")).toEqual([30, 0]);
    await expect(root(page)).toHaveCSS("touch-action", "pan-x");
    await send(page, { a: "doc", s: "s", scroll: "3", q: "2" }, ROWS);
    await surface(page, "s").locator("#box").evaluate((el) => el.scrollTo(30, 20));
    await page.waitForTimeout(100);
    expect(await offset(page, "#box")).toEqual([30, 20]);
    expect(await surface(page, "s").locator("#box").evaluate((el) => (el as HTMLElement).offsetHeight - el.clientHeight)).toBe(await barWidth(page));
  });

  test("a wheel scrolls the document, and at its end the terminal's scrollback; the program hears nothing of the document's", async ({ page }) => {
    await scrolling(page);
    const bottom = await viewportY(page);
    const a = (await surface(page, "s").locator("#a").boundingBox())!;
    await page.mouse.move(a.x + 5, a.y + 5);
    await page.mouse.wheel(0, 40);
    await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await viewportY(page)).toBe(bottom);
    expect((await take(page)).msgs).toEqual([]);
    // Back up to the top, then on: the scrollback moves.
    for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -100);
    await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBe(0);
    await page.waitForTimeout(300); // a new gesture
    await page.mouse.wheel(0, -100);
    await expect.poll(() => viewportY(page)).toBeLessThan(bottom);
  });

  test("a gesture begun over the cells stays the terminal's when a document that scrolls comes under the pointer", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "wheels from CDP");
    await scrolling(page);
    const cdp = await page.context().newCDPSession(page);
    const wheel = (x: number, y: number, deltaY: number) => cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    const a = (await surface(page, "s").locator("#a").boundingBox())!;
    const screen = (await page.locator(".xterm-screen").boundingBox())!;
    const bottom = await viewportY(page);
    // Over the cells, right of the surface, then over the surface at once.
    await wheel(screen.x + screen.width - 20, a.y + 5, 60);
    await page.mouse.move(0, 0);
    await wheel(a.x + 5, a.y + 5, -60);
    await wheel(a.x + 5, a.y + 5, -60);
    await expect.poll(() => viewportY(page)).toBeLessThan(bottom);
    expect(await root(page).evaluate((el) => el.scrollTop)).toBe(0);
    // A pause ends the gesture: the next is the document's.
    await page.evaluate(() => (window.hotty.term as unknown as Scrolling).scrollToBottom());
    await page.waitForTimeout(300);
    await wheel(a.x + 5, a.y + 5, 60);
    await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("keys scroll as a browser's do: a line, a page, Space, the ends; past an end the key is the program's", async ({ page }) => {
    await scrolling(page);
    // Focus on an element that uses no keys (SPEC §10.2): a button's are
    // Space, with or without Shift, and Enter.
    await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, `<div id=k tabindex=0>k</div>${ROWS}`);
    await send(page, { a: "focus", s: "s", t: "k", q: "2" });
    const top = () => root(page).evaluate((el) => el.scrollTop);
    const view = await root(page).evaluate((el) => el.clientHeight);
    await page.keyboard.press("ArrowDown");
    expect(await top()).toBe(40);
    await page.keyboard.press("PageDown");
    expect(Math.abs((await top()) - (40 + view * 0.875))).toBeLessThanOrEqual(1);
    await page.keyboard.press("Shift+Space");
    expect(Math.abs((await top()) - 40)).toBeLessThanOrEqual(1); // half a pixel of a page each way
    await page.keyboard.press("End");
    const end = await root(page).evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(await top()).toBe(end);
    expect((await take(page)).raw).toBe("");
    // Nothing moves down: the program has the key, as typed in the terminal.
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await take(page)).raw).toBe("\x1b[B");
    // The surface still has the keyboard.
    await page.keyboard.press("Home");
    expect(await top()).toBe(0);
  });

  test("keys the focused element uses stay its own: a radio button's arrows scroll, and a text field's Space types", async ({ page }) => {
    await scrolling(page);
    await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, `<input id=t><input type=radio name=r id=r1 checked><input type=radio name=r id=r2>${ROWS}`);
    await send(page, { a: "focus", s: "s", t: "r1", q: "2" });
    await page.keyboard.press("ArrowDown");
    expect(await root(page).evaluate((el) => el.scrollTop)).toBe(40);
    expect(await surface(page, "s").locator("#r1").isChecked()).toBe(true);
    await send(page, { a: "focus", s: "s", t: "t", q: "2" });
    await page.keyboard.press("Space");
    await expect(surface(page, "s").locator("#t")).toHaveValue(" ");
  });

  test("a delta keeps an inner box's offset; hiding and placing again keeps every offset; a new document starts at the top", async ({ page }) => {
    await scrolling(page);
    await surface(page, "s").locator("#box").evaluate((el) => (el.scrollTop = 30));
    await root(page).evaluate((el) => (el.scrollTop = 20));
    await send(page, { a: "delta", s: "s", t: "box", q: "2" }, `<div id=box>${Array.from({ length: 8 }, (_, i) => `<div id=b${i}>B${i}</div>`).join("")}</div>`);
    await expect(surface(page, "s").locator("#b0")).toHaveText("B0");
    expect(await offset(page, "#box")).toEqual([0, 30]);
    expect(await offset(page, "html")).toEqual([0, 20]);
    await send(page, { a: "hide", s: "s", q: "2" });
    await send(page, { a: "place", s: "s", c: "10", r: "4", q: "2" });
    await expect(surface(page, "s").locator("#a")).toBeVisible();
    expect(await offset(page, "#box")).toEqual([0, 30]);
    expect(await offset(page, "html")).toEqual([0, 20]);
    await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, ROWS);
    expect(await offset(page, "html")).toEqual([0, 0]);
  });

  test("r=auto and fit measure without the root's scrollbar, which would make the lines wrap", async ({ page }) => {
    await open(page, "?pty=0");
    // Nine cells of ten: with the root's scrollbar beside them, they wrap.
    const line = "x".repeat(9);
    await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, `<style>body{margin:0;white-space:normal;word-break:break-all}</style><div>${line}</div><div>${line}</div><div>${line}</div>`);
    await send(page, { a: "place", s: "s", c: "10", f: "1" });
    const placed = (await take(page)).msgs.find((m) => m.get("re") === "place")!;
    expect(placed.get("r")).toBe("3");
    await page.waitForTimeout(100);
    expect((await take(page)).msgs.filter((m) => m.get("e") === "fit")).toEqual([]);
  });

  test.describe("on a touch screen", () => {
    test.use({ hasTouch: true });

    test("a drag pans the document, and once it can go no further, the next drag the terminal's scrollback", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "touch input comes from CDP");
      await scrolling(page);
      const cdp = await page.context().newCDPSession(page);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
      const r = (await page.locator('.hotty-surface[data-surface="s"]').boundingBox())!;
      // Right of the box and the rows, left of the root's scrollbar.
      const cellW = r.width / 10;
      const drag = async (dy: number) => {
        const x = r.x + 7.5 * cellW;
        const y = r.y + r.height / 2;
        await touch("touchStart", [{ x, y }]);
        for (let i = 1; i <= 8; i++) await touch("touchMove", [{ x, y: y + (i * dy) / 8 }]);
        await page.waitForTimeout(150);
        await touch("touchEnd", []);
      };
      const bottom = await viewportY(page);
      // The finger goes up: the document comes up under it.
      await drag(-50);
      await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(20);
      expect(await viewportY(page)).toBe(bottom);
      // Down, past the top: first the document, then the scrollback.
      await drag(200);
      await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBe(0);
      expect(await viewportY(page)).toBe(bottom);
      await drag(120);
      await expect.poll(() => viewportY(page)).toBeLessThan(bottom);
    });
  });

  test("where the page scrolls, a wheel scrolls the document, and at its end the page", async ({ page }) => {
    await open(page, "?pty=0&scroll=page");
    await write(page, "top\r\n");
    const rows = `<style>body{margin:0}div{height:var(--hotty-cell-h)}</style>${Array.from({ length: 12 }, (_, i) => `<div id=d${i}>${i}</div>`).join("")}`;
    await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, rows);
    await send(page, { a: "place", s: "s", c: "10", r: "4", q: "2" });
    await expect(surface(page, "s").locator("#d0")).toBeVisible();
    const a = (await surface(page, "s").locator("#d0").boundingBox())!;
    await page.mouse.move(a.x + 5, a.y + 5);
    await page.mouse.wheel(0, 40);
    await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // To its end, then on: the browser chains to the page once the gesture
    // that reached the end is over (Firefox holds one for 1.5 seconds).
    const end = await root(page).evaluate((el) => el.scrollHeight - el.clientHeight);
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, 100);
        return root(page).evaluate((el) => el.scrollTop);
      })
      .toBe(end);
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, 100);
        return page.evaluate(() => window.scrollY);
      }, { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect((await take(page)).raw).toBe("");
  });
});
