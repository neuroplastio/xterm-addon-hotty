// Drives the demo page as a program would: HOTTY commands written to the
// terminal, replies and events read back from what it sends to the program.

import type { FrameLocator, Page } from "@playwright/test";
import { Control, decodeAll, encode } from "../../src/wire.ts";
import { Writer, type Float } from "../../src/msgpack.ts";
import { CAPS, DETAIL, ERROR, mistyped, show, unpack, type Type } from "../msgpack.ts";

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

export function cmd(pairs: Record<string, string>, payload: string | Uint8Array = ""): string {
  return encode(new Control(Object.entries(pairs)), payload);
}

export async function write(page: Page, data: string) {
  await page.evaluate((d) => window.hotty.write(d), data);
}

export async function send(page: Page, pairs: Record<string, string>, payload: string | Uint8Array = "") {
  await write(page, cmd(pairs, payload));
}

/** One op of a delta (SPEC §6.1). */
export type Op = { op: string; t?: string; k?: string; v?: string };

/** A delta command (SPEC §6.1): the ops are one msgpack map, `{"ops": […]}`. */
export function deltaCmd(pairs: Record<string, string>, ...ops: Op[]): string {
  return cmd({ a: "delta", ...pairs }, new Writer().body({ ops }));
}

export async function delta(page: Page, pairs: Record<string, string>, ...ops: Op[]) {
  await write(page, deltaCmd(pairs, ...ops));
}

export interface Msg {
  get(k: string): string | undefined;
  /** The body, decoded (`unpack`: a float is a `Float`); null when the
   * message has none. */
  body: unknown;
}

/**
 * Everything the terminal sent to the program, decoded; `sent` is cleared.
 * Each body must decode as an SDK reads it (SDK.md §3.9) and be one
 * msgpack map with each field of its type (SPEC §3.3), and the test fails
 * where one is not.
 */
export async function take(page: Page): Promise<{ msgs: Msg[]; raw: string }> {
  const raw = await page.evaluate(() => window.hotty.sent.splice(0).join(""));
  // A host never compresses what it sends (SPEC §3.3).
  for (const [, ctl] of raw.matchAll(/\x1b\]7279;([^;\x07\x1b]*)/g)) {
    if (Control.parse(ctl!).get("o") !== undefined) throw new Error(`the host compressed: ${ctl}`);
  }
  const msgs = (await decodeAll(raw)).map((c) => {
    const get = (k: string) => c.control.get(k);
    const body = c.payload.length ? unpack(c.payload) : null;
    const type: Type | undefined = get("a") === "ev" ? DETAIL[get("e") ?? ""] : get("a") === "err" ? ERROR : get("re") === "q" ? CAPS : undefined;
    const where = `${c.control.encode()} ${show(body)}`;
    if (body !== null && type === undefined) throw new Error(`a body where SPEC gives none: ${where}`);
    const bad = body === null ? null : mistyped(body, type!);
    if (bad) throw new Error(`${bad}: ${where}`);
    return { get, body };
  });
  return { msgs, raw: raw.replace(/\x1b\]7279;[^\x1b]*\x1b\\/g, "") };
}

export function surface(page: Page, name: string): FrameLocator {
  return page.frameLocator(`.hotty-surface[data-surface="${name}"] iframe`);
}

export async function cell(page: Page): Promise<{ w: number; h: number }> {
  await send(page, { a: "q", n: "0", v: "0.3" });
  const { msgs } = await take(page);
  const caps = msgs.find((m) => m.get("re") === "q")!.body as { cellcss: { w: Float; h: Float } };
  return { w: caps.cellcss.w.value, h: caps.cellcss.h.value };
}

/**
 * An event's detail without the `area` of a click or a press (SPEC §9),
 * for tests of other things, which leave where elements are to
 * `area.spec.ts`. The area is still checked to be whole cells, and a detail
 * with nothing else is none.
 */
export function sansArea(detail: unknown): unknown {
  if (detail === null || typeof detail !== "object" || !("area" in detail)) return detail;
  const { area, ...rest } = detail as { area: Record<string, unknown> };
  for (const k of ["c", "r", "w", "h"]) {
    if (!Number.isInteger(area[k])) throw new Error(`area.${k} is not a whole number: ${JSON.stringify(area)}`);
  }
  return Object.keys(rest).length ? rest : null;
}
