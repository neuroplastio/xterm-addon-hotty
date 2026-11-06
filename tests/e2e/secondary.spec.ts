// A secondary press on an element that takes it (SPEC §9, §9.1, §9.2,
// HOST.md §3): a mouse's button 2, a pen's barrel button, or a touch's long
// press. The shared vectors cover what is reported (conformance.spec.ts);
// these check what they cannot see: the browser's own menu, which stays for
// the terminal's presses and is cancelled for the surface's, the focus, the
// click and the drag it does not make, and the touch's lift.
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { open, send, surface, take, write } from "./helpers.ts";

type Keys = { alt?: boolean; shift?: boolean };

/** A button, in the page's coordinates: through CDP in Chromium,
 * where Playwright's mouse stalls on a press that moves inside a frame
 * without scripts, and Playwright's own in Firefox, whose mouse events
 * carry the keyboard's modifiers. */
class Mouse {
  private cdp: CDPSession | null = null;
  private held = false;
  constructor(
    private readonly page: Page,
    private readonly browser: string,
    private readonly button: "left" | "right" = "right",
  ) {}

  private async go(type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, keys: Keys) {
    if (type === "mousePressed") this.held = true;
    if (type === "mouseReleased") this.held = false;
    if (this.browser === "chromium") {
      this.cdp ??= await this.page.context().newCDPSession(this.page);
      const modifiers = (keys.alt ? 1 : 0) | (keys.shift ? 8 : 0);
      await this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: this.button, buttons: this.held ? (this.button === "right" ? 2 : 1) : 0, clickCount: 1, modifiers });
      return;
    }
    if (keys.alt) await this.page.keyboard.down("Alt");
    if (keys.shift) await this.page.keyboard.down("Shift");
    if (type === "mouseMoved") await this.page.mouse.move(x, y);
    else if (type === "mousePressed") await this.page.mouse.down({ button: this.button });
    else await this.page.mouse.up({ button: this.button });
    if (keys.shift) await this.page.keyboard.up("Shift");
    if (keys.alt) await this.page.keyboard.up("Alt");
  }

  move = (x: number, y: number, keys: Keys = {}) => this.go("mouseMoved", x, y, keys);
  async down(x: number, y: number, keys: Keys = {}) {
    await this.go("mouseMoved", x, y, keys);
    await this.go("mousePressed", x, y, keys);
  }
  async up(x: number, y: number, keys: Keys = {}) {
    await this.go("mouseMoved", x, y, keys);
    await this.go("mouseReleased", x, y, keys);
  }
  /** Press and release. */
  async click(x: number, y: number, keys: Keys = {}) {
    await this.down(x, y, keys);
    await this.up(x, y, keys);
  }
}

/** A left click, as the primary button's. */
async function leftClick(page: Page, browser: string, x: number, y: number) {
  await new Mouse(page, browser, "left").click(x, y);
}

/** One finger in Chromium, through CDP: a touch is its session's, from its
 * start to its end. */
function finger(page: Page) {
  let cdp: CDPSession | null = null;
  return async (type: "touchStart" | "touchMove" | "touchEnd", x?: number, y?: number) => {
    cdp ??= await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: x!, y: y! }] });
  };
}

const DOC =
  `<style>body{margin:0}b,i,u,input,div{position:absolute;display:block;box-sizing:border-box;height:var(--hotty-cell-h);font-style:normal;font-weight:normal;margin:0;padding:0}` +
  `#o{left:0;top:0;width:calc(9*var(--hotty-cell-w));height:calc(3*var(--hotty-cell-h))}` +
  `#i{left:calc(3*var(--hotty-cell-w));top:var(--hotty-cell-h);width:calc(3*var(--hotty-cell-w))}` +
  `#n{left:calc(10*var(--hotty-cell-w));top:0;width:calc(3*var(--hotty-cell-w))}` +
  `#k{left:0;top:calc(4*var(--hotty-cell-h));width:calc(3*var(--hotty-cell-w))}` +
  `#f{left:calc(10*var(--hotty-cell-w));top:calc(2*var(--hotty-cell-h));width:calc(6*var(--hotty-cell-w))}` +
  `.a{left:0;top:calc(6*var(--hotty-cell-h));width:calc(6*var(--hotty-cell-w))}` +
  `#d{left:calc(7*var(--hotty-cell-w));top:calc(6*var(--hotty-cell-h));width:calc(3*var(--hotty-cell-w))}</style>` +
  // #o holds #i, both with it; #n has none; #k also takes the click; #a has
  // it with no id, inside no other element that takes it; #d drags.
  `<b id=o data-on=secondary><u id=i data-on=secondary>i</u></b><i id=n>n</i><i id=k data-on="secondary click">k</i><input id=f type=text>` +
  `<i class=a data-on=secondary id=a>a</i><i id=d data-on="secondary drag">d</i>`;

/** The id-less case: the element has no id, nor does anything around it. */
const NOID = DOC.replace(" id=a>", ">");

async function place(page: Page, p: "0" | "1", doc = DOC) {
  await send(page, { a: "doc", s: "x", q: "2" }, doc);
  await send(page, { a: "place", s: "x", c: "20", r: "8", q: "2", p });
  await take(page);
}

/** The centre of an element of the surface, in the page. */
async function centre(page: Page, id: string): Promise<[number, number]> {
  const r = (await surface(page, "x").locator(`#${id}`).boundingBox())!;
  return [r.x + r.width / 2, r.y + r.height / 2];
}

/** Records, in the frame, each `contextmenu` and whether anything cancelled
 * it by the time it reached the window (bubbling, after the surface's own
 * listeners), and every `click` and `blur` the frame's document gets. */
async function record(page: Page) {
  await page.evaluate(() => {
    const f = document.querySelector('.hotty-surface[data-surface="x"] iframe') as HTMLIFrameElement;
    const w = f.contentWindow as unknown as { log: string[] } & Window;
    w.log = [];
    w.addEventListener("contextmenu", (e) => w.log.push(e.defaultPrevented ? "contextmenu:prevented" : "contextmenu:open"));
    w.document.addEventListener("click", (e) => w.log.push(`click:${(e.target as Element).id}`), true);
    w.document.addEventListener("blur", () => w.log.push("blur"), true);
    w.document.addEventListener("focusin", (e) => w.log.push(`focusin:${(e.target as Element).id}`), true);
  });
}

const log = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const f = document.querySelector('.hotty-surface[data-surface="x"] iframe') as HTMLIFrameElement;
    return (f.contentWindow as unknown as { log: string[] }).log.splice(0);
  });

const events = async (page: Page) =>
  (await take(page)).msgs
    .filter((m) => m.get("a") === "ev")
    .map((m) => [m.get("e"), m.get("t") ?? "", m.body as Record<string, unknown> | null] as const);

test.beforeEach(async ({ page }) => open(page, "?pty=0"));

for (const p of ["0", "1"] as const) {
  test(`p=${p}: the innermost element that takes it is the press, and its release makes nothing`, async ({ page, browserName }) => {
    await place(page, p);
    await record(page);
    const m = new Mouse(page, browserName);
    const [ix, iy] = await centre(page, "i");
    await m.click(ix, iy);
    expect(await events(page)).toEqual([["press", "i", { button: 2, area: { c: 3, r: 1, w: 3, h: 1 }, c: 4, r: 1 }]]);
    // On #o, outside #i: the outer one.
    const o = (await surface(page, "x").locator("#o").boundingBox())!;
    await m.click(o.x + 1, o.y + 1);
    const got = await events(page);
    expect(got.map((g) => [g[0], g[1]])).toEqual([["press", "o"]]);
    expect(got[0]![2]).toMatchObject({ button: 2, area: { c: 0, r: 0, w: 9, h: 3 } });
    // The browser's menu was cancelled both times.
    expect((await log(page)).filter((l) => l.startsWith("contextmenu"))).toEqual(["contextmenu:prevented", "contextmenu:prevented"]);
  });
}

test("an element that takes it, with no id, reports it with no t", async ({ page, browserName }) => {
  await place(page, "0", NOID);
  await record(page);
  const m = new Mouse(page, browserName);
  const r = (await surface(page, "x").locator("[data-on=secondary]:not([id])").boundingBox())!;
  await m.click(r.x + r.width / 2, r.y + r.height / 2);
  const [ev] = await take(page).then((t) => t.msgs.filter((x) => x.get("a") === "ev"));
  expect(ev!.get("e")).toBe("press");
  expect(ev!.get("t")).toBeUndefined();
  expect(ev!.body).toMatchObject({ button: 2, area: { c: 0, r: 6, w: 6, h: 1 } });
  expect(await log(page)).toContain("contextmenu:prevented");
});

test("over an element without it, or with Shift held over one with it, it is the terminal's: no event, and the browser's menu is not cancelled", async ({ page, browserName }) => {
  await write(page, "\x1b[?1002h\x1b[?1006h");
  await place(page, "1");
  await record(page);
  const m = new Mouse(page, browserName);
  const [ix, iy] = await centre(page, "i");
  const [nx, ny] = await centre(page, "n");
  // Over an element without it: the browser's menu, no event.
  await m.click(nx, ny);
  expect(await events(page)).toEqual([]);
  expect(await log(page)).toEqual(["contextmenu:open"]);
  // Shift over one with it: the terminal's menu, not cancelled, no event.
  // (Firefox gives a page no `contextmenu` for it at all.)
  await m.click(ix, iy, { shift: true });
  expect(await events(page)).toEqual([]);
  expect((await log(page)).filter((l) => l.startsWith("contextmenu") && l !== "contextmenu:open")).toEqual([]);
  await take(page);
});

test("Alt over an element that takes it, or one that does not, is the program's mouse report, button 2 with Alt: CSI < 10", async ({ page, browserName }) => {
  await write(page, "\x1b[?1002h\x1b[?1006h");
  await place(page, "1");
  await record(page);
  const m = new Mouse(page, browserName);
  for (const id of ["i", "n"]) {
    await take(page);
    const [x, y] = await centre(page, id);
    await m.down(x, y, { alt: true });
    await m.up(x, y, { alt: true });
    const { msgs, raw } = await take(page);
    expect(msgs.filter((g) => g.get("a") === "ev"), id).toEqual([]);
    const f = (await page.locator(".xterm-screen").boundingBox())!;
    const t = await page.evaluate(() => ({ c: window.hotty.term.cols, r: window.hotty.term.rows }));
    const col = Math.floor((x - f.x) / (f.width / t.c)) + 1;
    const row = Math.floor((y - f.y) / (f.height / t.r)) + 1;
    expect(raw, id).toContain(`\x1b[<10;${col};${row}M`);
    expect(raw, id).toContain(`\x1b[<10;${col};${row}m`);
  }
  // No click, no focus: the program's gesture.
  expect((await log(page)).filter((l) => !l.startsWith("contextmenu"))).toEqual([]);
});

test("Alt with mouse reporting off reports nothing to the program", async ({ page, browserName }) => {
  await place(page, "1");
  const m = new Mouse(page, browserName);
  const [x, y] = await centre(page, "i");
  await m.down(x, y, { alt: true });
  await m.up(x, y, { alt: true });
  const { msgs, raw } = await take(page);
  expect(msgs.filter((g) => g.get("a") === "ev")).toEqual([]);
  expect(raw).toBe("");
});

test("a focused field keeps its focus: no blur, no focus, and the keyboard stays", async ({ page, browserName }) => {
  await place(page, "0");
  await record(page);
  const [fx, fy] = await centre(page, "f");
  await leftClick(page, browserName, fx, fy);
  expect((await events(page)).map((e) => e[0])).toEqual(["focus"]);
  await log(page);
  const m = new Mouse(page, browserName);
  // Over an element that takes it, over one that takes a click too, and over
  // a field that does not: the field keeps the keyboard throughout.
  for (const id of ["o", "k"]) {
    const [x, y] = await centre(page, id);
    await m.click(x + (id === "o" ? 20 : 0), y);
    expect((await events(page)).map((e) => e[0]), id).toEqual(["press"]);
  }
  expect((await log(page)).filter((l) => l.startsWith("blur") || l.startsWith("focusin"))).toEqual([]);
  expect(await surface(page, "x").locator("#f").evaluate((el) => el.ownerDocument.activeElement === el)).toBe(true);
  await page.keyboard.type("hi");
  await surface(page, "x").locator("#f").press("Enter");
  expect((await events(page)).filter((e) => e[0] === "blur")).toEqual([]);
});

test("`secondary click` gets a press and no click, on the press or the release", async ({ page, browserName }) => {
  await place(page, "1");
  await record(page);
  const m = new Mouse(page, browserName);
  const [x, y] = await centre(page, "k");
  await m.down(x, y);
  await m.up(x, y);
  const got = await events(page);
  expect(got.map((e) => e[0])).toEqual(["press"]);
  expect((await log(page)).filter((l) => l.startsWith("click"))).toEqual([]);
  // The primary button still clicks it.
  await leftClick(page, browserName, x, y);
  expect((await events(page)).map((e) => e[0])).toEqual(["press", "click"]);
});

test("`drag secondary` starts no drag, and moving the pointer with the button down reports nothing", async ({ page, browserName }) => {
  await place(page, "0");
  const m = new Mouse(page, browserName);
  const [x, y] = await centre(page, "d");
  await m.down(x, y);
  await m.move(x + 40, y + 5);
  await m.move(x + 80, y + 40);
  await m.up(x + 80, y + 40);
  expect((await events(page)).map((e) => e[0])).toEqual(["press"]);
  // And it did not leave a drag behind: a primary drag still works.
  const left = new Mouse(page, browserName, "left");
  await left.down(x, y);
  await left.move(x + 30, y + 3);
  await left.up(x + 30, y + 3);
  expect((await events(page)).map((e) => e[0])).toContain("dragstart");
});

test("a press by the primary button on an element that takes it is unchanged: a press at p=1 without button, c or r, none at p=0", async ({ page, browserName }) => {
  await place(page, "0");
  const [x, y] = await centre(page, "i");
  await leftClick(page, browserName, x, y);
  expect(await events(page)).toEqual([]);
  await page.reload();
  await page.waitForFunction(() => window.hotty !== undefined);
  await place(page, "1");
  await leftClick(page, browserName, x, y);
  const got = await events(page);
  expect(got.map((e) => [e[0], e[1]])).toEqual([["press", "i"]]);
  expect(got[0]![2]).not.toHaveProperty("button");
  expect(got[0]![2]).not.toHaveProperty("c");
});

test("the keyboard's context menu is a key for the program, not a secondary press", async ({ page }) => {
  await place(page, "1");
  await surface(page, "x").locator("#i").evaluate((el) => (el as HTMLElement).setAttribute("tabindex", "0"));
  await surface(page, "x").locator("#i").focus();
  await take(page);
  // The browser makes a contextmenu of Shift+F10 over the focused element.
  await page.keyboard.press("Shift+F10");
  expect((await events(page)).filter((e) => e[0] === "press")).toEqual([]);
});

test("the Menu key, with no Shift, over a focused element that takes it, is a key for the program: no press", async ({ page }) => {
  await place(page, "1");
  await surface(page, "x").locator("#i").evaluate((el) => (el as HTMLElement).setAttribute("tabindex", "0"));
  await surface(page, "x").locator("#i").focus();
  await record(page);
  await take(page);
  await page.keyboard.press("ContextMenu");
  expect((await events(page)).filter((e) => e[0] === "press")).toEqual([]);
  // Whether the browser opened its menu is its own: the surface does not
  // cancel it (the log says what happened).
  expect((await log(page)).filter((l) => l === "contextmenu:prevented")).toEqual([]);
});

test.describe("a long press", () => {
  test.use({ hasTouch: true });

  test("on an element that takes it reports button 2 at the finger's cell, and its lift makes no click and no scroll", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Playwright gives Firefox no touch");
    await place(page, "0");
    await record(page);
    const [x, y] = await centre(page, "k");
    const touch = finger(page);
    await touch("touchStart", x, y);
    await page.waitForTimeout(900);
    await touch("touchEnd");
    await page.waitForTimeout(100);
    const got = await events(page);
    expect(got.map((e) => [e[0], e[1]])).toEqual([["press", "k"]]);
    expect(got[0]![2]).toMatchObject({ button: 2, area: { c: 0, r: 4, w: 3, h: 1 }, c: 1, r: 4 });
    expect((await log(page)).filter((l) => l.startsWith("click"))).toEqual([]);
    // A tap on it is a click, as before.
    await touch("touchStart", x, y);
    await touch("touchEnd");
    await page.waitForTimeout(200);
    expect((await events(page)).map((e) => e[0])).toEqual(["click"]);
  });

  test("on an element that does not take it reports nothing", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Playwright gives Firefox no touch");
    await place(page, "1");
    const [x, y] = await centre(page, "n");
    const touch = finger(page);
    await touch("touchStart", x, y);
    await page.waitForTimeout(900);
    await touch("touchEnd");
    await page.waitForTimeout(100);
    expect((await events(page)).filter((e) => e[2] && "button" in e[2])).toEqual([]);
  });
});

// A 0.6 session has no secondary press (HOST.md §4.1): the secondary button
// is the terminal's, as it was before 0.7. The session is the version the
// last query was answered in.
test.describe("a 0.6 session", () => {
  const query = (page: Page, v: string) => send(page, { a: "q", n: "9", v });

  test("a secondary press over an element with it reports nothing, and the browser's menu is not cancelled", async ({ page, browserName }) => {
    await query(page, "0.6");
    await place(page, "1");
    await record(page);
    const m = new Mouse(page, browserName);
    // What the pre-0.7 test of the terminal's press asserts (over an element
    // without `secondary`): no event, and the contextmenu left open.
    for (const id of ["i", "o", "k"]) {
      const [x, y] = await centre(page, id);
      await m.click(x, y);
      expect(await events(page), id).toEqual([]);
      expect(await log(page), id).toEqual(["contextmenu:open"]);
    }
  });

  test("Alt with the secondary button sends no CSI < 10; a 0.7 session still does", async ({ page, browserName }) => {
    await write(page, "\x1b[?1002h\x1b[?1006h");
    await query(page, "0.6");
    await place(page, "1");
    const m = new Mouse(page, browserName);
    const [x, y] = await centre(page, "i");
    await take(page);
    await m.down(x, y, { alt: true });
    await m.up(x, y, { alt: true });
    const six = await take(page);
    expect(six.msgs.filter((g) => g.get("a") === "ev")).toEqual([]);
    expect(six.raw).not.toContain("\x1b[<10;");
    // The same program queries again in 0.7: the gesture is the program's.
    await query(page, "0.6,0.7");
    await take(page);
    await m.down(x, y, { alt: true });
    await m.up(x, y, { alt: true });
    expect((await take(page)).raw).toContain("\x1b[<10;");
  });

  test("a 0.7 query puts the press back, and a full reset (RIS) ends the 0.6 session", async ({ page, browserName }) => {
    await query(page, "0.6");
    await place(page, "0");
    const m = new Mouse(page, browserName);
    const [x, y] = await centre(page, "i");
    await m.click(x, y);
    expect(await events(page)).toEqual([]);
    await query(page, "0.7");
    await take(page);
    await m.click(x, y);
    expect((await events(page)).map((e) => [e[0], e[1]])).toEqual([["press", "i"]]);
    await query(page, "0.6");
    await write(page, "\x1bc");
    await place(page, "0");
    await take(page);
    await m.click(x, y);
    expect((await events(page)).map((e) => [e[0], e[1]])).toEqual([["press", "i"]]);
  });

  test("a long press over an element with it reports nothing", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "Playwright gives Firefox no touch");
    await query(page, "0.6");
    await place(page, "0");
    const [x, y] = await centre(page, "k");
    const touch = finger(page);
    await touch("touchStart", x, y);
    await page.waitForTimeout(900);
    await touch("touchEnd");
    await page.waitForTimeout(100);
    expect((await events(page)).filter((e) => e[2] && "button" in e[2])).toEqual([]);
  });
});
