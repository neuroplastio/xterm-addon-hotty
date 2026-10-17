// The shared protocol vectors (conformance/README.md), run in the browser.
// hotty-blitz runs the same file (crates/hotty-blitz/tests/conformance.rs).

import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { readVectors } from "../hotty.ts";
import { Writer, type Body } from "../../src/msgpack.ts";
import { mistyped, show, type Type } from "../msgpack.ts";
import { cmd, collapseMoves, mouseReports, open, screenPoint, take, write, type Msg, type Report } from "./helpers.ts";

type Expected = Record<string, unknown>;
type Step = {
  send?: Record<string, string>;
  payload?: string;
  /** A msgpack body, as JSON (conformance/README.md): a delta's ops, a menu. */
  body?: unknown;
  reply?: Record<string, string | Type | Expected> | null;
  inspect?: [string, string];
  expect?: Record<string, unknown> | null;
  pointer?: "move" | "down" | "up" | "wheel";
  touch?: "down" | "move" | "up";
  s?: string;
  at?: string | [number, number];
  by?: [number, number];
  key?: string;
  keys?: string[];
  menu?: "shown" | "pick";
  name?: string;
  count?: number;
  terminal?: boolean;
  /** What the terminal reported of the mouse's primary button (§9.6). */
  mouse?: Report[];
  /** Bytes the program writes to the terminal, not HOTTY's. */
  write?: string;
  events?: Expected[];
};
const vectors = readVectors() as {
  vectors: { name: string; requires?: string | string[]; steps: Step[] }[];
};

/**
 * Every event a step sent, against its `events`, in order and nothing more.
 * A detail is compared decoded: equal as values, each of its type, so an
 * int is not a float (a `Float`, in the vectors as read and as decoded).
 */
function checkEvents(where: string, msgs: Msg[], want: Expected[] | undefined) {
  if (want === undefined) return;
  const got = msgs.filter((m) => m.get("a") === "ev");
  const all = got.map((m) => `${m.get("e")}:${m.get("t")} ${show(m.body)}`).join(", ");
  expect(got.length, `${where}: events [${all}]`).toBe(want.length);
  want.forEach((w, i) => {
    for (const [k, v] of Object.entries(w)) {
      // `null`: the event has none of it (`t`: it names no element, SPEC §9;
      // `detail`: no payload).
      if (k === "detail") expect(got[i]!.body, `${where}: event ${i + 1} detail`).toStrictEqual(v);
      else if (v === null) expect(got[i]!.get(k), `${where}: event ${i + 1} ${k}`).toBeUndefined();
      else expect(got[i]!.get(k), `${where}: event ${i + 1} ${k}`).toBe(v);
    }
  });
}

/**
 * What a send step made the host send. Some events follow the command by a
 * frame or a load (`fit`, SPEC §5.2): a step that checks its events waits
 * for as many as it expects (two seconds at most), then two frames more,
 * so that one too many is seen too.
 */
async function sent(page: Page, want: Expected[] | undefined): Promise<Msg[]> {
  const msgs = (await take(page)).msgs;
  if (want === undefined) return msgs;
  const events = () => msgs.filter((m) => m.get("a") === "ev").length;
  const until = Date.now() + 2000;
  while (events() < want.length && Date.now() < until) {
    await frames(page, 1);
    msgs.push(...(await take(page)).msgs);
  }
  await frames(page, 2);
  msgs.push(...(await take(page)).msgs);
  return msgs;
}

/** Waits for the page to draw `n` frames. */
async function frames(page: Page, n: number) {
  await page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        const next = (k: number) => (k ? requestAnimationFrame(() => next(k - 1)) : done());
        next(n);
      }),
    n,
  );
}

/**
 * The vectors' mouse (pointer steps), in the page's coordinates. In
 * Chromium through CDP: Playwright's own mouse stalls on a press that moves
 * inside a frame without scripts (detach.spec.ts). Keys are held as the
 * event's modifiers there, and pressed on the keyboard in Firefox, whose
 * mouse events carry the keyboard's modifiers. A wheel step is one gesture
 * (conformance/README.md).
 */
class Mouse {
  x = 0;
  y = 0;
  s = "";
  down = false;
  constructor(
    private readonly page: Page,
    private readonly browser: string,
  ) {}

  async step(step: Step) {
    if (step.pointer === "move") {
      [this.x, this.y] = await point(this.page, step.s!, step.at!);
      this.s = step.s!;
    }
    const keys = step.keys ?? [];
    if (this.browser === "chromium") {
      const bits = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as Record<string, number>;
      const modifiers = keys.reduce((m, k) => m | (bits[k] ?? 0), 0);
      if (step.pointer === "wheel") {
        // A wheel gesture as the browser has one from a device, latched to
        // what it scrolls: wheels from dispatchMouseEvent are each one of
        // their own to Chromium.
        const [w, h] = await cellOf(this.page, this.s);
        const [dx, dy] = [step.by![0] * w, step.by![1] * h];
        const cdp = await this.page.context().newCDPSession(this.page);
        await cdp.send("Input.synthesizeScrollGesture", { x: this.x, y: this.y, xDistance: -dx, yDistance: -dy, gestureSourceType: "mouse", speed: 5000, preventFling: true });
        await cdp.detach();
        return;
      }
      const type = step.pointer === "move" ? "mouseMoved" : step.pointer === "down" ? "mousePressed" : "mouseReleased";
      if (step.pointer === "down") this.down = true;
      if (step.pointer === "up") this.down = false;
      const cdp = await this.page.context().newCDPSession(this.page);
      await cdp.send("Input.dispatchMouseEvent", { type, x: this.x, y: this.y, button: "left", buttons: this.down ? 1 : 0, clickCount: step.count ?? 1, modifiers });
      await cdp.detach();
      return;
    }
    const names = { shift: "Shift", ctrl: "Control", alt: "Alt", super: "Meta" } as Record<string, string>;
    for (const k of keys) await this.page.keyboard.down(names[k]!);
    if (step.pointer === "move") await this.page.mouse.move(this.x, this.y);
    else if (step.pointer === "down") await this.page.mouse.down({ clickCount: step.count ?? 1 });
    else if (step.pointer === "wheel") for (const [dx, dy] of await this.notches(step.by!)) await this.page.mouse.wheel(dx, dy);
    else await this.page.mouse.up({ clickCount: step.count ?? 1 });
    for (const k of [...keys].reverse()) await this.page.keyboard.up(names[k]!);
  }

  /** A wheel step as one gesture of wheel events, a cell's worth of pixels
   * each (of the surface the pointer is on): Firefox scrolls no more than a
   * page for one event. */
  private async notches(by: [number, number]): Promise<[number, number][]> {
    const [w, h] = await cellOf(this.page, this.s);
    const n = Math.max(Math.abs(by[0]), Math.abs(by[1]));
    return Array.from({ length: n }, () => [(by[0] / n) * w, (by[1] / n) * h]);
  }
}

/**
 * The vectors' finger (touch steps), in the page's coordinates, through
 * CDP: Chromium only. A move is one move, straight to its cell: it passes
 * the slop in its own direction (conformance README), and an element it
 * reaches is reached at that cell, as a pointer step's move reaches it. A
 * step without `s` touches the screen's cells (SPEC §9.6).
 */
class Finger {
  x = 0;
  y = 0;
  /** One session for every step: a touch is the session's, from its start
   * to its end. */
  private cdp: CDPSession | null = null;
  constructor(private readonly page: Page) {}

  async step(step: Step) {
    const bits = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as Record<string, number>;
    const modifiers = (step.keys ?? []).reduce((m, k) => m | (bits[k] ?? 0), 0);
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    const cdp = this.cdp;
    const send = (type: string, points: { x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: points, modifiers });
    const at = () => (step.s === undefined ? screenPoint(this.page, step.at as [number, number]) : point(this.page, step.s, step.at!));
    if (step.touch === "down") {
      [this.x, this.y] = await at();
      await send("touchStart", [{ x: this.x, y: this.y }]);
    } else if (step.touch === "move") {
      [this.x, this.y] = await at();
      await send("touchMove", [{ x: this.x, y: this.y }]);
    } else {
      await send("touchEnd", []);
    }
  }
}

/** A surface's cell, in CSS pixels, from its host stylesheet. */
async function cellOf(page: Page, s: string): Promise<[number, number]> {
  return page.evaluate((s) => {
    const doc = (document.querySelector(`.hotty-surface[data-surface="${s}"] iframe`) as HTMLIFrameElement).contentDocument!;
    const css = getComputedStyle(doc.documentElement);
    return [parseFloat(css.getPropertyValue("--hotty-cell-w")), parseFloat(css.getPropertyValue("--hotty-cell-h"))];
  }, s);
}

/**
 * After a wheel step: the scroll it started has finished (no offset in any
 * surface moved for three frames), and its gesture is over, so the next
 * wheel begins another (conformance/README.md).
 */
async function settle(page: Page) {
  await page.waitForTimeout(200);
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const offsets = () =>
          Array.from(document.querySelectorAll<HTMLIFrameElement>(".hotty-surface iframe"), (f) =>
            Array.from(f.contentDocument!.querySelectorAll("*"), (el) => `${el.scrollLeft},${el.scrollTop}`).join(" "),
          ).join("|");
        let last = offsets();
        let still = 0;
        const next = () =>
          requestAnimationFrame(() => {
            const now = offsets();
            still = now === last ? still + 1 : 0;
            last = now;
            if (still >= 3) done();
            else next();
          });
        next();
      }),
  );
}

/** Wheels that reached the terminal (xterm.js's element) since the last call. */
async function terminalWheels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { termWheels?: number };
    if (w.termWheels === undefined) {
      w.termWheels = 0;
      (window.hotty.term as unknown as { element: HTMLElement }).element.addEventListener("wheel", () => w.termWheels!++, true);
    }
    const n = w.termWheels;
    w.termWheels = 0;
    return n;
  });
}

/** Where a pointer step's `at` is in the page: the centre of an element's
 * box, or of a cell of the surface, from its top left (the frame's). */
async function point(page: Page, s: string, at: string | [number, number]): Promise<[number, number]> {
  return page.evaluate(
    ([s, at]) => {
      const frame = document.querySelector(`.hotty-surface[data-surface="${s}"] iframe`) as HTMLIFrameElement;
      const f = frame.getBoundingClientRect();
      const doc = frame.contentDocument!;
      if (typeof at === "string") {
        const r = doc.getElementById(at)!.getBoundingClientRect();
        return [f.left + r.left + r.width / 2, f.top + r.top + r.height / 2];
      }
      const css = getComputedStyle(doc.documentElement);
      const w = parseFloat(css.getPropertyValue("--hotty-cell-w"));
      const h = parseFloat(css.getPropertyValue("--hotty-cell-h"));
      return [f.left + (at[0] + 0.5) * w, f.top + (at[1] + 0.5) * h];
    },
    [s, at] as const,
  );
}

// What the vectors may require (conformance/README.md) that this addon has:
// the features `count` and `menu` (SPEC §4), all a 0.4 host does (`scroll`,
// `steps`, `drop`, `view`), a history in its fields (`undo`), edit commands
// (`commands`, §10.6), a terminal that reports the mouse (`mouse`, §9.6),
// and `touch` (§9.1, §16) where this runner can touch it, in Chromium,
// through CDP: Playwright gives Firefox no touch moves. It does not let the
// pointer through surfaces (§9.3, `passthrough`), and sends no `hover`
// (§9.4).
const reported = (browser: string) => new Set<string>(["scroll", "steps", "drop", "view", "count", "menu", "undo", "commands", "pressed", "mouse", ...(browser === "chromium" ? ["touch"] : [])]);

const needs = (v: { requires?: string | string[] }) => (v.requires === undefined ? [] : [v.requires].flat());

for (const vector of vectors.vectors.filter((v) => !needs(v).includes("touch"))) define(vector);

// A touch screen for the vectors that touch: touch events are on.
test.describe("touch", () => {
  test.use({ hasTouch: true });
  for (const vector of vectors.vectors.filter((v) => needs(v).includes("touch"))) define(vector);
});

function define(vector: { name: string; requires?: string | string[]; steps: Step[] }) {
  test(vector.name, async ({ page, browserName }) => {
    const requires = needs(vector);
    const has = reported(browserName);
    const missing = requires.filter((r) => !has.has(r));
    test.skip(missing.length > 0, `needs ${missing.join(", ")}, which this runner can't give in ${browserName}`);
    await open(page);
    // The terminal has the keyboard, as in a page that gave it focus: a key
    // goes to the cells until a surface takes it.
    await page.evaluate(() => window.hotty.term.focus());
    const mouse = new Mouse(page, browserName);
    const finger = new Finger(page);
    for (const [i, step] of vector.steps.entries()) {
      const where = `step ${i + 1}`;
      if (step.touch) {
        await take(page);
        await terminalWheels(page);
        await finger.step(step);
        await frames(page, 2);
        const { msgs, raw } = await take(page);
        checkEvents(where, msgs, step.events);
        if (step.terminal !== undefined) expect((await terminalWheels(page)) > 0, `${where}: the terminal got the touch`).toBe(step.terminal);
        if (step.mouse !== undefined) expect(collapseMoves(mouseReports(raw)), `${where}: the mouse reported (${JSON.stringify(raw)})`).toEqual(collapseMoves(step.mouse));
      } else if (step.pointer) {
        await take(page);
        await terminalWheels(page);
        await mouse.step(step);
        if (step.pointer === "wheel") await settle(page);
        checkEvents(where, (await take(page)).msgs, step.events);
        if (step.terminal !== undefined) expect((await terminalWheels(page)) > 0, `${where}: the terminal got the wheel`).toBe(step.terminal);
      } else if (step.key !== undefined) {
        // Where the keyboard is: the surface that has it, else the terminal.
        // A character typed with Shift on a US keyboard is pressed with it
        // held, as a keyboard would: xterm.js encodes Alt with a key from
        // its key code and Shift, not from the character.
        await take(page);
        const names = { shift: "Shift", ctrl: "Control", alt: "Alt", super: "Meta" } as Record<string, string>;
        const keys = [...(step.keys ?? [])];
        if (/^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(step.key) && !keys.includes("shift")) keys.unshift("shift");
        for (const k of keys) await page.keyboard.down(names[k]!);
        await page.keyboard.press(step.key);
        for (const k of [...keys].reverse()) await page.keyboard.up(names[k]!);
        await frames(page, 2);
        const { msgs, raw } = await take(page);
        checkEvents(where, msgs, step.events);
        // xterm.js sends nothing for Meta with an arrow, Home or End (the
        // browser's line keys on a Mac): that such a key went on to the
        // terminal cannot be seen, only that the surface did not use it.
        const silent = keys.includes("super") && /^(Arrow.*|Home|End)$/.test(step.key) && raw === "";
        if (step.terminal !== undefined && !(silent && step.terminal)) expect(raw !== "", `${where}: the program got ${JSON.stringify(step.key)} (${JSON.stringify(raw)})`).toBe(step.terminal);
      } else if (step.send) {
        await take(page);
        await write(page, cmd(step.send, step.body !== undefined ? new Writer().body(step.body as Body) : (step.payload ?? "")));
        const msgs = await sent(page, step.events);
        checkEvents(where, msgs, step.events);
        const replies = msgs.filter((m) => m.get("a") !== "ev");
        if (step.reply === undefined) continue;
        if (step.reply === null) {
          expect(replies, where).toHaveLength(0);
          continue;
        }
        expect(replies.length, where).toBeGreaterThan(0);
        const got = replies[0]!;
        const body = (got.body ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(step.reply)) {
          // `types` (conformance/README.md): the body decoded as an SDK
          // reads it (`take`), and each field it has is of its type, but
          // those `types` does not name.
          if (k === "types") expect(mistyped(got.body, v as Type, "skip"), `${where}: types, in ${show(got.body)}`).toBeNull();
          // `body`: the fields an `a=ok`'s body must have, equal as values,
          // each of its type (a `Float` a float, as the vectors are read).
          else if (k === "body") {
            expect(got.get("a"), `${where}: a body is an a=ok's`).toBe("ok");
            for (const [f, want] of Object.entries(v as Expected)) expect(body[f], `${where}: body ${f}, in ${show(got.body)}`).toStrictEqual(want);
          } else if (v === null) expect(k === "code" || k === "detail" ? body[k] : got.get(k), `${where}: ${k} is absent`).toBeUndefined();
          else expect(k === "code" || k === "detail" ? body[k] : got.get(k), `${where}: ${k}`).toBe(v);
        }
      } else if (step.write !== undefined) {
        // The program's own bytes (§9.6: mouse reporting, the alternate
        // screen), parsed before the next step.
        await write(page, step.write);
      } else if (step.menu === "shown") {
        // The level the host shows (SPEC §10.7), as the program sent it.
        const got = await page.evaluate(() => (window.hotty as unknown as { addon: { shownMenu(): unknown } }).addon.shownMenu());
        expect(got, `${where}: the level shown`).toEqual(step.expect);
      } else if (step.menu === "pick") {
        await take(page);
        const picked = await page.evaluate((n) => (window.hotty as unknown as { addon: { pick(n: string): boolean } }).addon.pick(n), step.name!);
        const msgs = await sent(page, step.events);
        checkEvents(where, msgs, step.events);
        if (step.events !== undefined) expect(picked, `${where}: picked`).toBe(step.events.length > 0);
      } else if (step.inspect) {
        const [s, id] = step.inspect;
        const got = await page.evaluate(([s, id]) => (window as unknown as { hotty: { addon: { inspect(s: string, id: string): unknown } } }).hotty.addon.inspect(s, id), [s, id] as const);
        if (step.expect === null) {
          expect(got, `${where}: #${id}`).toBeNull();
          continue;
        }
        expect(got, `${where}: #${id}`).not.toBeNull();
        for (const [k, v] of Object.entries(step.expect!)) expect((got as Record<string, unknown>)[k], `${where}: #${id} ${k}`).toEqual(v);
      }
    }
  });
}
