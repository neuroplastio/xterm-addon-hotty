// Touch in the cells (SPEC §9.6): where the program names an area, a
// finger's drag the way it drags is the mouse's primary button, which
// xterm.js reports as a mouse's, in the program's own mode and encoding.
// The shared vectors check which touches drag and what they report in SGR
// (conformance.spec.ts); these check what they cannot: other modes and
// encodings, the keys held, the selection, a surface the finger crosses,
// the scrollback, a second finger, a lost touch and a long press. In
// Chromium the finger is the browser's own, from CDP; in Firefox, which
// Playwright gives no touch moves, it is touch events made in the page,
// which the addon takes as it takes the browser's.
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { Writer } from "../../src/msgpack.ts";
import { collapseMoves, mouseReports, open, screenPoint, send, take, write, type Report } from "./helpers.ts";

test.use({ hasTouch: true });

type Keys = { alt?: boolean; ctrl?: boolean; shift?: boolean };
type Point = { x: number; y: number };

/** One finger on the screen's cells, and perhaps a second. */
class Finger {
  private cdp: CDPSession | null = null;
  private at: Point = { x: 0, y: 0 };
  constructor(
    private readonly page: Page,
    private readonly browser: string,
  ) {}

  /** Touches the centre of the screen's cell [c, r]. */
  async down(c: number, r: number, keys: Keys = {}) {
    this.at = await this.cell(c, r);
    await this.fire("touchstart", [this.at], [this.at], keys);
  }

  /** Moves to the centre of [c, r], along a straight line, in `n` moves. */
  async move(c: number, r: number, keys: Keys = {}, n = 4) {
    const from = this.at;
    const to = await this.cell(c, r);
    for (let i = 1; i <= n; i++) {
      this.at = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n };
      await this.fire("touchmove", [this.at], [this.at], keys);
    }
  }

  async up(keys: Keys = {}) {
    await this.fire("touchend", [], [this.at], keys);
  }

  /** The browser loses the touch. */
  async cancel() {
    await this.fire("touchcancel", [], [this.at], {});
  }

  /** A second finger lands at [c, r], the first still down. */
  async second(c: number, r: number) {
    const p = await this.cell(c, r);
    await this.fire("touchstart", [this.at, p], [p], {});
  }

  private async cell(c: number, r: number): Promise<Point> {
    const [x, y] = await screenPoint(this.page, [c, r]);
    return { x, y };
  }

  /** `points` are the fingers down after the event, `changed` those it is
   * about (the first finger is 1, the second 2). */
  private async fire(type: "touchstart" | "touchmove" | "touchend" | "touchcancel", points: Point[], changed: Point[], keys: Keys) {
    if (this.browser === "chromium") {
      this.cdp ??= await this.page.context().newCDPSession(this.page);
      const cdpType = ({ touchstart: "touchStart", touchmove: "touchMove", touchend: "touchEnd", touchcancel: "touchCancel" } as const)[type];
      const modifiers = (keys.alt ? 1 : 0) | (keys.ctrl ? 2 : 0) | (keys.shift ? 8 : 0);
      await this.cdp.send("Input.dispatchTouchEvent", { type: cdpType, touchPoints: points, modifiers });
      return;
    }
    const ids = changed.map((p) => points.indexOf(p) + 1 || 1);
    await this.page.evaluate(
      ({ type, points, changed, ids, keys }) => {
        // Each event of a touch goes to the element it began on, as a
        // browser's do.
        const w = window as unknown as { fingerOn?: Element };
        if (type === "touchstart" && points.length === 1) w.fingerOn = document.elementFromPoint(points[0]!.x, points[0]!.y)!;
        const target = w.fingerOn!;
        const touch = (p: { x: number; y: number }, id: number) => new Touch({ identifier: id, target, clientX: p.x, clientY: p.y });
        const touches = points.map((p, i) => touch(p, i + 1));
        const init = { touches, targetTouches: touches, changedTouches: changed.map((p, i) => touch(p, ids[i]!)), bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(new TouchEvent(type, { ...init, altKey: !!keys.alt, ctrlKey: !!keys.ctrl, shiftKey: !!keys.shift }));
      },
      { type, points, changed, ids, keys },
    );
  }
}

/** What the program read since the last call, two frames on. */
async function read(page: Page): Promise<string> {
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  return (await take(page)).raw;
}

/** The mouse's primary button in what the program read (SGR), as the
 * vectors compare it: of each run of moves, the last. */
async function reports(page: Page): Promise<Report[]> {
  return collapseMoves(mouseReports(await read(page)));
}

async function areas(page: Page, ...list: { c: number; r: number; w: number; h: number; drag: string }[]) {
  await send(page, { a: "touch", q: "2" }, new Writer().body({ areas: list }));
}

test("in the program's mode: with presses and releases only (1000), a drag is a press where it began and a release where it lifts, and a tap one of each", async ({ page, browserName }) => {
  await open(page);
  await write(page, "\x1b[?1000h\x1b[?1006h");
  await areas(page, { c: 2, r: 3, w: 10, h: 1, drag: "x" });
  await take(page);
  const f = new Finger(page, browserName);
  await f.down(3, 3);
  await f.move(8, 3);
  expect(await reports(page)).toEqual([["down", 3, 3]]);
  await f.up();
  expect(await reports(page)).toEqual([["up", 8, 3]]);
  await f.down(5, 3);
  await f.up();
  expect(await reports(page)).toEqual([
    ["down", 5, 3],
    ["up", 5, 3],
  ]);
});

test("in the program's encoding: with none asked for, the drag is the mouse's own bytes", async ({ page, browserName }) => {
  await open(page);
  // The default encoding is bytes, not text: xterm.js sends it as binary.
  await page.evaluate(() => {
    const w = window as unknown as { binary: string[]; hotty: { term: { onBinary(f: (d: string) => void): void } } };
    w.binary = [];
    w.hotty.term.onBinary((d) => w.binary.push(d));
  });
  await write(page, "\x1b[?1002h");
  await areas(page, { c: 2, r: 3, w: 10, h: 1, drag: "x" });
  const f = new Finger(page, browserName);
  await f.down(3, 3);
  await f.move(5, 3);
  await f.up();
  await read(page);
  const bytes = await page.evaluate(() => (window as unknown as { binary: string[] }).binary.join(""));
  const got: Report[] = [];
  for (const [, b, x, y] of bytes.matchAll(/\x1b\[M([\s\S])([\s\S])([\s\S])/g)) {
    const button = b!.charCodeAt(0) - 32;
    got.push([(button & 3) === 3 ? "up" : button & 32 ? "move" : "down", x!.charCodeAt(0) - 33, y!.charCodeAt(0) - 33]);
  }
  expect(collapseMoves(got)).toEqual([
    ["down", 3, 3],
    ["move", 5, 3],
    ["up", 5, 3],
  ]);
});

test("the keys held go with the reports, but Shift, and nothing is selected", async ({ page, browserName }) => {
  await open(page);
  await write(page, "line one, to select\r\n\x1b[?1002h\x1b[?1006h");
  await areas(page, { c: 0, r: 0, w: 20, h: 2, drag: "x" });
  await take(page);
  const f = new Finger(page, browserName);
  const keys = { ctrl: true, shift: true };
  await f.down(2, 0, keys);
  await f.move(9, 0, keys, 1);
  await f.up(keys);
  // Ctrl is 16 in a report, Shift 4, a held button's motion 32.
  expect(await read(page)).toBe("\x1b[<16;3;1M\x1b[<48;10;1M\x1b[<16;10;1m");
  expect(await page.evaluate(() => (window.hotty.term as unknown as { hasSelection(): boolean }).hasSelection())).toBe(false);
});

test("the finger is the program's until it lifts, over a surface too, which hears none of it", async ({ page, browserName }) => {
  await open(page);
  await write(page, "\x1b[?1002h\x1b[?1006h\r\n\r\n");
  await send(page, { a: "doc", s: "s", q: "2" }, "<style>body{margin:0}</style><p id=p>a surface</p>");
  await send(page, { a: "place", s: "s", c: "20", r: "3", p: "1", q: "2" });
  // A row apart: Chromium gives a touch that lands within about 10 px of
  // an element that responds to it (the surface) to that element.
  await areas(page, { c: 0, r: 0, w: 40, h: 1, drag: "y" });
  await take(page);
  const f = new Finger(page, browserName);
  await f.down(5, 0);
  await f.move(5, 3);
  await f.move(12, 3);
  await f.up();
  const { msgs, raw } = await take(page);
  expect(collapseMoves(mouseReports(raw))).toEqual([
    ["down", 5, 0],
    ["move", 12, 3],
    ["up", 12, 3],
  ]);
  // Every move, the one onto the surface's cells included.
  expect(mouseReports(raw)).toContainEqual(["move", 5, 3]);
  expect(msgs.filter((m) => m.get("a") === "ev").map((m) => m.get("e"))).toEqual([]);
});

test("while the terminal shows its scrollback, an area does nothing: the drag goes on as a scroll", async ({ page, browserName }) => {
  await open(page);
  await write(page, Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\r\n") + "\r\n\x1b[?1002h\x1b[?1006h");
  await areas(page, { c: 0, r: 0, w: 80, h: 30, drag: "xy" });
  type Scrolls = { scrollToLine(n: number): void; scrollToBottom(): void };
  await page.evaluate(() => (window.hotty.term as unknown as Scrolls).scrollToLine(0));
  await take(page);
  const f = new Finger(page, browserName);
  await f.down(3, 3);
  await f.move(3, 8);
  await f.up();
  const raw = await read(page);
  expect(mouseReports(raw)).toEqual([]);
  // The program reads the mouse, and so the wheel too.
  expect(raw).toMatch(/\x1b\[<6[45];4;\d+M/);
  await page.evaluate(() => (window.hotty.term as unknown as Scrolls).scrollToBottom());
  await f.down(3, 3);
  await f.move(3, 8);
  await f.up();
  expect(await reports(page)).toEqual([
    ["down", 3, 3],
    ["move", 3, 8],
    ["up", 3, 8],
  ]);
});

test("a second finger releases the button on the cell the finger was last on, and so does a touch the browser loses", async ({ page, browserName }) => {
  await open(page);
  await write(page, "\x1b[?1002h\x1b[?1006h");
  await areas(page, { c: 2, r: 3, w: 10, h: 1, drag: "x" });
  await take(page);
  const f = new Finger(page, browserName);
  await f.down(3, 3);
  await f.move(8, 3);
  await f.second(20, 10);
  expect(await reports(page)).toEqual([
    ["down", 3, 3],
    ["move", 8, 3],
    ["up", 8, 3],
  ]);
  // The rest of the gesture is the host's: none of it reaches the program.
  await f.up();
  expect(await reports(page)).toEqual([]);

  await f.down(3, 3);
  await f.move(6, 3);
  await f.cancel();
  expect(await reports(page)).toEqual([
    ["down", 3, 3],
    ["move", 6, 3],
    ["up", 6, 3],
  ]);
});

test("a long press in an area never drags, and is no tap", async ({ page, browserName }) => {
  await open(page);
  await write(page, "\x1b[?1002h\x1b[?1006h");
  await areas(page, { c: 2, r: 3, w: 10, h: 1, drag: "x" });
  await take(page);
  const f = new Finger(page, browserName);
  await f.down(3, 3);
  await page.waitForTimeout(700);
  await f.move(8, 3);
  await f.up();
  expect(await reports(page)).toEqual([]);
});
