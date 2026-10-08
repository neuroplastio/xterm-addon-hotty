// The shared protocol vectors (conformance/README.md), run in the browser.
// hotty-blitz runs the same file (crates/hotty-blitz/tests/conformance.rs).

import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOTTY_DIR } from "../hotty.ts";
import { cmd, open, take, write, type Msg } from "./helpers.ts";

type Expected = Record<string, unknown>;
type Step = {
  send?: Record<string, string>;
  payload?: string;
  reply?: Record<string, string> | null;
  inspect?: [string, string];
  expect?: Record<string, unknown> | null;
  pointer?: "move" | "down" | "up" | "wheel";
  s?: string;
  at?: string | [number, number];
  by?: [number, number];
  key?: string;
  keys?: string[];
  terminal?: boolean;
  events?: Expected[];
};
const vectors = JSON.parse(readFileSync(join(HOTTY_DIR, "conformance", "vectors.json"), "utf8")) as {
  vectors: { name: string; requires?: string | string[]; steps: Step[] }[];
};

/** Every event a step sent, against its `events`, in order and nothing more. */
function checkEvents(where: string, msgs: Msg[], want: Expected[] | undefined) {
  if (want === undefined) return;
  const got = msgs.filter((m) => m.get("a") === "ev");
  const show = got.map((m) => `${m.get("e")}:${m.get("t")} ${m.body}`).join(", ");
  expect(got.length, `${where}: events [${show}]`).toBe(want.length);
  want.forEach((w, i) => {
    for (const [k, v] of Object.entries(w)) {
      if (k === "detail") expect(got[i]!.json, `${where}: event ${i + 1} detail`).toEqual(v);
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
      await cdp.send("Input.dispatchMouseEvent", { type, x: this.x, y: this.y, button: "left", buttons: this.down ? 1 : 0, clickCount: 1, modifiers });
      await cdp.detach();
      return;
    }
    const names = { shift: "Shift", ctrl: "Control", alt: "Alt", meta: "Meta" } as Record<string, string>;
    for (const k of keys) await this.page.keyboard.down(names[k]!);
    if (step.pointer === "move") await this.page.mouse.move(this.x, this.y);
    else if (step.pointer === "down") await this.page.mouse.down();
    else if (step.pointer === "wheel") for (const [dx, dy] of await this.notches(step.by!)) await this.page.mouse.wheel(dx, dy);
    else await this.page.mouse.up();
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

// Capabilities this addon reports that vectors may require (SPEC §4):
// `scroll` (§5.3). It does not let the pointer through surfaces yet (§9.3,
// `passthrough`), and does not send `hover` yet (§9.4: not in `EVENTS`).
const reported = new Set<string>(["scroll"]);

for (const vector of vectors.vectors) {
  test(vector.name, async ({ page, browserName }) => {
    const requires = vector.requires === undefined ? [] : [vector.requires].flat();
    test.skip(!requires.every((r) => reported.has(r)), `needs ${requires.join(", ")}`);
    await open(page);
    const mouse = new Mouse(page, browserName);
    for (const [i, step] of vector.steps.entries()) {
      const where = `step ${i + 1}`;
      if (step.pointer) {
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
        const names = { shift: "Shift", ctrl: "Control", alt: "Alt", meta: "Meta" } as Record<string, string>;
        const keys = [...(step.keys ?? [])];
        if (/^[A-Z~!@#$%^&*()_+{}|:"<>?]$/.test(step.key) && !keys.includes("shift")) keys.unshift("shift");
        for (const k of keys) await page.keyboard.down(names[k]!);
        await page.keyboard.press(step.key);
        for (const k of [...keys].reverse()) await page.keyboard.up(names[k]!);
        await frames(page, 2);
        const { msgs, raw } = await take(page);
        checkEvents(where, msgs, step.events);
        if (step.terminal !== undefined) expect(raw !== "", `${where}: the program got ${JSON.stringify(step.key)} (${JSON.stringify(raw)})`).toBe(step.terminal);
      } else if (step.send) {
        await take(page);
        await write(page, cmd(step.send, step.payload ?? ""));
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
        const body = (got.json ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(step.reply)) {
          expect(k === "code" || k === "detail" ? body[k] : got.get(k), `${where}: ${k}`).toBe(v);
        }
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
