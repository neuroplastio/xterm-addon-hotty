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
  pointer?: "move" | "down" | "up";
  s?: string;
  at?: string | [number, number];
  keys?: string[];
  events?: Expected[];
};
const vectors = JSON.parse(readFileSync(join(HOTTY_DIR, "conformance", "vectors.json"), "utf8")) as {
  vectors: { name: string; requires?: string; steps: Step[] }[];
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
 * The vectors' mouse (pointer steps), in the page's coordinates. In
 * Chromium through CDP: Playwright's own mouse stalls on a press that moves
 * inside a frame without scripts (detach.spec.ts). Keys are held as the
 * event's modifiers there, and pressed on the keyboard in Firefox, whose
 * mouse events carry the keyboard's modifiers.
 */
class Mouse {
  x = 0;
  y = 0;
  down = false;
  constructor(
    private readonly page: Page,
    private readonly browser: string,
  ) {}

  async step(step: Step) {
    if (step.pointer === "move") [this.x, this.y] = await point(this.page, step.s!, step.at!);
    const keys = step.keys ?? [];
    if (this.browser === "chromium") {
      const bits = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as Record<string, number>;
      const modifiers = keys.reduce((m, k) => m | (bits[k] ?? 0), 0);
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
    else await this.page.mouse.up();
    for (const k of [...keys].reverse()) await this.page.keyboard.up(names[k]!);
  }
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

// Capabilities this addon reports that vectors may require (SPEC §4): it
// does not let the pointer through surfaces yet (§9.3, `passthrough`).
const reported = new Set<string>();

for (const vector of vectors.vectors) {
  test(vector.name, async ({ page, browserName }) => {
    test.skip(vector.requires !== undefined && !reported.has(vector.requires), `needs ${vector.requires}`);
    await open(page);
    const mouse = new Mouse(page, browserName);
    for (const [i, step] of vector.steps.entries()) {
      const where = `step ${i + 1}`;
      if (step.pointer) {
        await take(page);
        await mouse.step(step);
        checkEvents(where, (await take(page)).msgs, step.events);
      } else if (step.send) {
        await take(page);
        await write(page, cmd(step.send, step.payload ?? ""));
        const { msgs } = await take(page);
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
