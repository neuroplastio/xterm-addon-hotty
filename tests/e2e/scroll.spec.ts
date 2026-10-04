// Nothing in a surface scrolls, and the gestures that scroll are the
// terminal's (SPEC §5.3, §9). A wheel or a touch drag over a surface moves
// the terminal's scrollback; a tap stays the surface's.
import { expect, test, type Page } from "@playwright/test";
import { open, send, surface, take, write } from "./helpers.ts";

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
