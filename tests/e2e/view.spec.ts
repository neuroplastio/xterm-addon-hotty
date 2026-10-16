// Reveal and view (SPEC §6.1, §9.5). The shared vectors check where reveal
// puts an element and what view reports (conformance.spec.ts); these check
// what they cannot: that reveal scrolls nothing outside the document, that
// a scroll sends one view once it comes to rest, and when views go out.
import { expect, test, type Page } from "@playwright/test";
import { delta, open, send, surface, take, write } from "./helpers.ts";

/** Rows of four cells, `a` to `l`, each reporting whether it is in view. */
const ROWS =
  `<style>body{margin:0}div{height:var(--hotty-cell-h);width:calc(4*var(--hotty-cell-w))}</style>` +
  "abcdefghijkl".split("").map((c) => `<div id=${c} data-on=view>${c}</div>`).join("");

type View = { in: Record<string, { c: number; r: number; w: number; h: number }>; end: boolean };

/** The views the program heard since the last call. */
const views = async (page: Page): Promise<View[]> =>
  (await take(page)).msgs.filter((m) => m.get("a") === "ev" && m.get("e") === "view").map((m) => m.body as View);

/** Waits until the program has heard `n` views, then a while longer, and
 * returns every view it heard: one too many is seen too. */
async function heard(page: Page, n: number): Promise<View[]> {
  const got: View[] = [];
  await expect.poll(async () => got.push(...(await views(page))) && got.length, { timeout: 5000 }).toBeGreaterThanOrEqual(n);
  await page.waitForTimeout(800);
  got.push(...(await views(page)));
  return got;
}

/** Each element in view, by its id, with the row it starts on. */
const rows = (v: View) => Object.fromEntries(Object.entries(v.in).map(([id, a]) => [id, a.r]));

const root = (page: Page) => surface(page, "s").locator("html");

/** Every scroll offset outside the surfaces' documents: the page's, and
 * each element's of the page, xterm.js's and the boxes that show windows
 * included. */
const outside = (page: Page) =>
  page.evaluate(() => [`${window.scrollX},${window.scrollY}`, ...Array.from(document.querySelectorAll("*"), (el) => `${el.scrollLeft},${el.scrollTop}`)].join(" "));

type Scrolling = { buffer: { active: { viewportY: number; baseY: number } }; scrollToLine(line: number): void; scrollToBottom(): void };

test("reveal scrolls only the document: not the box that shows its window, not xterm.js's scrollback, not the page", async ({ page }) => {
  // A page that scrolls, and a window of three rows of the surface's six:
  // a target the root cannot bring all the way would take every box around
  // it along with scrollIntoView.
  await open(page, "?pty=0&scroll=page");
  await write(page, Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n");
  await page.evaluate(() => window.scrollTo(0, 40));
  await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, ROWS);
  await send(page, { a: "place", s: "s", c: "10", r: "6", h: "3", q: "2" });
  await expect(surface(page, "s").locator("#a")).toBeVisible();
  const before = await outside(page);
  const max = await root(page).evaluate((el) => el.scrollHeight - el.clientHeight);
  for (const where of ["start", "end", ""]) {
    await delta(page, { s: "s", q: "2" }, { op: "reveal", t: "l", v: where || undefined });
    await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBe(max);
    expect(await outside(page)).toBe(before);
    await delta(page, { s: "s", q: "2" }, { op: "reveal", t: "a", v: where || undefined });
    await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBe(0);
    expect(await outside(page)).toBe(before);
  }
  expect((await take(page)).raw).toBe("");
});

test("reveal scrolls neither an overflow: hidden box nor along an axis the document did not ask for", async ({ page }) => {
  await open(page, "?pty=0");
  await send(
    page,
    { a: "doc", s: "s", scroll: "1", q: "2" },
    `<style>body{margin:0}div{height:var(--hotty-cell-h)}#clip,#box{height:calc(2*var(--hotty-cell-h));overflow:hidden}#box{overflow:auto}#wide{width:calc(30*var(--hotty-cell-w))}</style>` +
      `<div id=clip><div>1</div><div>2</div><div id=deep>3</div></div><div id=box><div>1</div><div>2</div><div id=far><span id=x style="margin-left:calc(25*var(--hotty-cell-w))">x</span></div></div>`,
  );
  await send(page, { a: "place", s: "s", c: "10", r: "4", q: "2" });
  await expect(surface(page, "s").locator("#deep")).toBeAttached();
  await delta(page, { s: "s", q: "2" }, { op: "reveal", t: "deep", v: "start" });
  await delta(page, { s: "s", q: "2" }, { op: "reveal", t: "x" });
  // The scrolling box moves down to x, and not across: scroll=1.
  await expect.poll(() => surface(page, "s").locator("#box").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await surface(page, "s").locator("#box").evaluate((el) => el.scrollLeft)).toBe(0);
  expect(await surface(page, "s").locator("#clip").evaluate((el) => el.scrollTop)).toBe(0);
});

test("a wheel that scrolls the document sends one view, once the scroll has come to rest", async ({ page, browserName }) => {
  await open(page, "?pty=0");
  await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, ROWS);
  await send(page, { a: "place", s: "s", c: "10", r: "4", q: "2" });
  expect((await heard(page, 1)).map(rows)).toEqual([{ a: 0, b: 1, c: 2, d: 3 }]);
  const box = (await surface(page, "s").locator("#a").boundingBox())!;
  const [x, y] = [box.x + 5, box.y + 5];
  if (browserName === "chromium") {
    // A gesture over many frames, as a hand scrolls: every one of them
    // moves the rows.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance: -5 * box.height, gestureSourceType: "mouse", speed: 300 });
    await cdp.detach();
  } else {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 5 * box.height);
  }
  const got = await heard(page, 1);
  expect(got).toHaveLength(1);
  // The view says where the rows came to rest: each that shows some of
  // itself in the four rows, by the row it starts on.
  const top = await root(page).evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(0);
  const want: Record<string, number> = {};
  for (const [i, id] of [..."abcdefghijkl"].entries()) {
    const y = i * box.height - top;
    if (y + box.height > 0.5 && y < 4 * box.height - 0.5) want[id] = Math.floor((y + 0.5) / box.height);
  }
  expect(rows(got[0]!)).toEqual(want);
});

test("a smooth reveal sends one view, where the scroll comes to rest", async ({ page }) => {
  await open(page, "?pty=0");
  await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, `<style>html{scroll-behavior:smooth}</style>${ROWS}`);
  await send(page, { a: "place", s: "s", c: "10", r: "4", q: "2" });
  await heard(page, 1);
  await delta(page, { s: "s", q: "2" }, { op: "reveal", t: "h", v: "start" });
  const got = await heard(page, 1);
  expect(got.map(rows)).toEqual([{ h: 0, i: 1, j: 2, k: 3 }]);
  expect(got[0]!.end).toBe(false);
  await delta(page, { s: "s", q: "2" }, { op: "reveal", t: "l" });
  expect((await heard(page, 1)).map((v) => [rows(v), v.end])).toEqual([[{ i: 0, j: 1, k: 2, l: 3 }, true]]);
});

test("an element is out of view where a box clips it, but not past its containing block, and not while it is not rendered (a closed details' too)", async ({ page }) => {
  await open(page, "?pty=0");
  await send(
    page,
    { a: "doc", s: "s", q: "2" },
    `<style>body{margin:0}div{height:var(--hotty-cell-h);width:calc(4*var(--hotty-cell-w))}#clip{overflow:hidden;height:var(--hotty-cell-h)}` +
      `#out{position:absolute;top:calc(2*var(--hotty-cell-h));left:0}#moved{transform:translateY(calc(3*var(--hotty-cell-h)))}</style>` +
      `<div id=clip><div>x</div><div id=hidden data-on=view>clipped</div><div id=out data-on=view>escapes</div></div>` +
      `<div id=moved data-on=view>moved</div><div id=invisible data-on=view style=visibility:hidden>i</div>` +
      `<details><summary>more</summary><div id=folded data-on=view>f</div></details>`,
  );
  await send(page, { a: "place", s: "s", c: "10", r: "6", q: "2" });
  // #moved sits on row 1, drawn three rows lower: row 4.
  expect(await heard(page, 1)).toEqual([{ in: { out: { c: 0, r: 2, w: 4, h: 1 }, moved: { c: 0, r: 4, w: 4, h: 1 } }, end: true }]);
  // A window without it: the transform counts, as the user sees it.
  await send(page, { a: "place", s: "s", c: "10", r: "6", h: "4", q: "2" });
  expect((await heard(page, 1)).map(rows)).toEqual([{ out: 2 }]);
  // The user opens the details: what it held is in view, below its summary.
  await send(page, { a: "place", s: "s", c: "10", r: "6", q: "2" });
  await heard(page, 1);
  await surface(page, "s").locator("summary").click();
  expect((await heard(page, 1)).map(rows)).toEqual([{ out: 2, moved: 4, folded: 4 }]);
});

test("a detached surface sends no view; the document that makes it the program's again sends one", async ({ page }) => {
  await open(page, "?pty=0");
  await send(page, { a: "doc", s: "s", scroll: "1", d: "1", q: "2" }, ROWS);
  await send(page, { a: "place", s: "s", c: "10", r: "4", q: "2" });
  await expect(surface(page, "s").locator("#a")).toBeVisible();
  await delta(page, { s: "s", q: "2" }, { op: "reveal", t: "e", v: "start" });
  await expect.poll(() => root(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  expect(await views(page)).toEqual([]);
  await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, ROWS);
  expect((await heard(page, 1)).map(rows)).toEqual([{ a: 0, b: 1, c: 2, d: 3 }]);
});

test("a placement scrolled out of view hears nothing until it is drawn again, then what changed; reveal scrolls it meanwhile", async ({ page }) => {
  await open(page, "?pty=0");
  await write(page, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n");
  await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, ROWS);
  await send(page, { a: "place", s: "s", c: "10", r: "4", q: "2" });
  expect((await heard(page, 1)).map(rows)).toEqual([{ a: 0, b: 1, c: 2, d: 3 }]);
  const term = () => page.evaluate(() => (window.hotty.term as unknown as Scrolling).buffer.active.baseY);
  const bottom = await term();
  await page.evaluate(() => (window.hotty.term as unknown as Scrolling).scrollToLine(0));
  await expect(page.locator('.hotty-surface[data-surface="s"]')).toBeHidden();
  await delta(page, { s: "s", q: "2" }, { op: "remove", t: "b" });
  await delta(page, { s: "s", q: "2" }, { op: "reveal", t: "h", v: "start" });
  await page.waitForTimeout(500);
  expect(await views(page)).toEqual([]);
  await page.evaluate((line) => (window.hotty.term as unknown as Scrolling).scrollToLine(line), bottom);
  await expect(page.locator('.hotty-surface[data-surface="s"]')).toBeVisible();
  expect((await heard(page, 1)).map(rows)).toEqual([{ h: 0, i: 1, j: 2, k: 3 }]);
});

test("a 0.3 host does reveal and view: the capabilities list neither ops nor events", async ({ page }) => {
  await open(page, "?pty=0");
  await send(page, { a: "q", n: "1", v: "0.3" });
  const caps = (await take(page)).msgs[0]!.body as Record<string, unknown>;
  expect(caps).not.toHaveProperty("ops");
  expect(caps).not.toHaveProperty("events");
});
