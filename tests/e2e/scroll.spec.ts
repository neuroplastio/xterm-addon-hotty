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

type Scrolling = { buffer: { active: { viewportY: number } }; scrollToBottom(): void };
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
});
