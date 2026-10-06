// Drives the demo page as a program would: HOTTY commands written to the
// terminal, replies and events read back from what it sends to the program.

import type { FrameLocator, Page } from "@playwright/test";
import { Control, decodeAll, encode, text } from "../../src/wire.ts";

type Hotty = {
  write(data: string): Promise<void>;
  sent: string[];
  term: { focus(): void; cols: number; rows: number; buffer: { active: { cursorX: number; cursorY: number } } };
};
declare global {
  interface Window {
    hotty: Hotty;
  }
}

/** The demo page without a pty: the test is the program. */
export async function open(page: Page, query = "?pty=0") {
  await page.goto("/" + query);
  await page.waitForFunction(() => window.hotty !== undefined);
}

export function cmd(pairs: Record<string, string>, payload = ""): string {
  return encode(new Control(Object.entries(pairs)), payload);
}

export async function write(page: Page, data: string) {
  await page.evaluate((d) => window.hotty.write(d), data);
}

export async function send(page: Page, pairs: Record<string, string>, payload = "") {
  await write(page, cmd(pairs, payload));
}

export interface Msg {
  get(k: string): string | undefined;
  body: string;
  json: unknown;
}

/** Everything the terminal sent to the program, decoded; `sent` is cleared. */
export async function take(page: Page): Promise<{ msgs: Msg[]; raw: string }> {
  const raw = await page.evaluate(() => window.hotty.sent.splice(0).join(""));
  // A host never compresses what it sends (SPEC §3.3).
  for (const [, ctl] of raw.matchAll(/\x1b\]7279;([^;\x07\x1b]*)/g)) {
    if (Control.parse(ctl!).get("o") !== undefined) throw new Error(`the host compressed: ${ctl}`);
  }
  const msgs = (await decodeAll(raw)).map((c) => {
    const body = text(c.payload);
    let json: unknown = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      /* not JSON */
    }
    return { get: (k: string) => c.control.get(k), body, json };
  });
  return { msgs, raw: raw.replace(/\x1b\]7279;[^\x1b]*\x1b\\/g, "") };
}

export function surface(page: Page, name: string): FrameLocator {
  return page.frameLocator(`.hotty-surface[data-surface="${name}"] iframe`);
}

export async function cell(page: Page): Promise<{ w: number; h: number }> {
  await send(page, { a: "q", n: "0" });
  const { msgs } = await take(page);
  const caps = msgs.find((m) => m.get("re") === "q")!.json as { cell: { w: number; h: number }; scale: number };
  return { w: caps.cell.w / caps.scale, h: caps.cell.h / caps.scale };
}

/**
 * An event's detail without the `area` of a click or a press (SPEC §9),
 * for tests of other things, which leave where elements are to
 * `area.spec.ts`. The area is still checked to be whole cells, and a detail
 * with nothing else is none.
 */
export function sansArea(json: unknown): unknown {
  if (json === null || typeof json !== "object" || !("area" in json)) return json;
  const { area, ...rest } = json as { area: Record<string, unknown> };
  for (const k of ["c", "r", "w", "h"]) {
    if (!Number.isInteger(area[k])) throw new Error(`area.${k} is not a whole number: ${JSON.stringify(area)}`);
  }
  return Object.keys(rest).length ? rest : null;
}
