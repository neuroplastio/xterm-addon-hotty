// Where an element is (SPEC §9: `area`): a click's and a press's cells. The
// shared vectors check it for the mouse and the keyboard, scrolled and
// clipped (conformance.spec.ts); these check a tap, cells that are not
// whole pixels, and a box that is not one rectangle of text.
import { expect, test, type Page } from "@playwright/test";
import { open, send, surface, take } from "./helpers.ts";

const W = "var(--hotty-cell-w)";
const H = "var(--hotty-cell-h)";

/** The clicks and presses the program heard, with their details. */
async function heard(page: Page, n: number): Promise<[string, string, unknown][]> {
  const got: [string, string, unknown][] = [];
  await expect
    .poll(async () => {
      for (const m of (await take(page)).msgs) {
        if (m.get("e") === "click" || m.get("e") === "press") got.push([m.get("e")!, m.get("t")!, m.json]);
      }
      return got.length;
    })
    .toBe(n);
  return got;
}

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a tap's press and click carry the element's cells", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "touch input comes from CDP");
    await open(page);
    await send(page, { a: "doc", s: "x", q: "2" }, `<style>body{margin:0}</style><b id=b data-on=click style="position:absolute;display:block;left:calc(3*${W});top:${H};width:calc(4*${W});height:${H}">b</b>`);
    await send(page, { a: "place", s: "x", c: "20", r: "3", p: "1", q: "2" });
    const b = (await surface(page, "x").locator("#b").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const area = { c: 3, r: 1, w: 4, h: 1 };
    expect(await heard(page, 2)).toEqual([
      ["press", "b", { area }],
      ["click", "b", { area }],
    ]);
  });
});

test.describe("where a cell is not a whole number of pixels", () => {
  // A cell of xterm.js's is whole device pixels: at 1.25 of them to the CSS
  // pixel, its CSS size is a fraction, and layout rounds the boxes it sizes.
  test.use({ deviceScaleFactor: 1.25 });

  // Each font its own fraction: DejaVu Sans Mono's lost a row 29 rows down
  // (a runner's fallback font, not the demo's MesloLGS).
  for (const font of ["MesloLGS Nerd Font Mono", "DejaVu Sans Mono"]) {
    test(`elements sized in cells report whole cells, however far down and across (${font})`, async ({ page }) => {
      await open(page, `?pty=0&font=${encodeURIComponent(font)}`);
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(1.25);
      // A column of thirty rows, and a row of boxes three cells wide.
      const rows = Array.from({ length: 30 }, (_, i) => `<div id=r${i} data-on=click style="height:${H};width:calc(2*${W})">${i}</div>`).join("");
      const boxes = Array.from({ length: 8 }, (_, i) => `<i id=c${i} data-on=click style="position:absolute;top:0;left:calc(${3 + 3 * i}*${W});width:calc(3*${W});height:${H}">${i}</i>`).join("");
      await send(page, { a: "doc", s: "x", q: "2" }, `<style>body{margin:0}i{display:block;font-style:normal}</style>${rows}${boxes}`);
      await send(page, { a: "place", s: "x", c: "30", r: "30", q: "2" });
      const w = await surface(page, "x").locator("html").evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--hotty-cell-w")));
      expect(Number.isInteger(w)).toBe(false);
      await take(page);
      for (const [id, area] of [
        ["r0", { c: 0, r: 0, w: 2, h: 1 }],
        ["r17", { c: 0, r: 17, w: 2, h: 1 }],
        ["r29", { c: 0, r: 29, w: 2, h: 1 }],
        ["c0", { c: 3, r: 0, w: 3, h: 1 }],
        ["c7", { c: 24, r: 0, w: 3, h: 1 }],
      ] as const) {
        await surface(page, "x").locator(`#${id}`).click();
        expect(await heard(page, 1), id).toEqual([["click", id, { area }]]);
      }
    });
  }
});

test("a link that wraps reports the cells of its whole box: both lines", async ({ page }) => {
  await open(page);
  // Ten cells wide: "aaaa bbbb" fits on the first line, "cccc" wraps.
  await send(page, { a: "doc", s: "x", q: "2" }, `<style>body{margin:0}p{margin:0;width:calc(10*${W})}</style><p>aaaa <a id=l href=next>bbbb cccc</a></p>`);
  await send(page, { a: "place", s: "x", c: "20", r: "3", q: "2" });
  await take(page);
  // A click on the second line's part.
  const [x, y] = await page.evaluate(() => {
    const frame = document.querySelector('.hotty-surface[data-surface="x"] iframe') as HTMLIFrameElement;
    const f = frame.getBoundingClientRect();
    const rects = frame.contentDocument!.getElementById("l")!.getClientRects();
    const r = rects[rects.length - 1]!;
    return [f.left + r.left + r.width / 2, f.top + r.top + r.height / 2];
  });
  await page.mouse.click(x, y);
  expect(await heard(page, 1)).toEqual([["click", "l", { href: "next", area: { c: 0, r: 0, w: 9, h: 2 } }]]);
});
