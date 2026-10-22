// `a=field` (SPEC §6.4): its body, checked as far as it can be without the
// control, and positions, which the wire counts in bytes of UTF-8 and the
// DOM in UTF-16 code units.

import { read } from "./msgpack.ts";

/** An error of `a=field` (SPEC §6.4): `EINVAL`, `ENOTARGET`, `EDETACHED`
 * or `ESTALE`, whose detail is the control's `rev`. */
export class FieldError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** The body of `a=field`, its fields as it gave them. */
export interface FieldChange {
  rev: number;
  value?: string;
  text?: string;
  from?: number;
  to?: number;
  /** The anchor, then the caret. */
  sel?: [number, number];
  checked?: boolean;
}

/** A selection in a field's value, in code units: `start` to `end`, the
 * caret at `start` when `backward`. */
export interface Sel {
  start: number;
  end: number;
  backward: boolean;
}

const invalid = (why: string) => new FieldError("EINVAL", why);

const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) && !(x instanceof Uint8Array) && Object.getPrototypeOf(x) === null;

/** An int as the reader gives one: a float is a `Float`, never a number. */
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);

/**
 * The body of `a=field` (SPEC §6.4), checked as far as it can be without
 * the control: `EINVAL` where it does not decode or is not a map; where
 * `rev` is missing; where a field has another type than the table's;
 * where no field but `rev` is there; where `value` comes with `text`,
 * `from` or `to`; where `from` or `to` comes without the other, or without
 * `text`; and where `from` is past `to`. A field the table does not have
 * is ignored. A position, negative too, is checked last, against the
 * control's value and only when the command is not stale (`unitAt`).
 */
export function readField(bytes: Uint8Array): FieldChange {
  let body: unknown;
  try {
    body = read(bytes);
  } catch (e) {
    throw invalid(`the body does not decode: ${(e as Error).message}`);
  }
  if (!isMap(body)) throw invalid("the body is a map");
  const { rev, value, text, from, to, sel, checked } = body;
  if (rev === undefined) throw invalid("rev is missing");
  if (!isInt(rev)) throw invalid("rev is not an int");
  if (value !== undefined && typeof value !== "string") throw invalid("value is not a str");
  if (text !== undefined && typeof text !== "string") throw invalid("text is not a str");
  for (const [name, x] of [["from", from], ["to", to]] as const) {
    if (x !== undefined && !isInt(x)) throw invalid(`${name} is not an int`);
  }
  if (sel !== undefined && !(Array.isArray(sel) && sel.length === 2 && sel.every(isInt))) throw invalid("sel is not two ints");
  if (checked !== undefined && typeof checked !== "boolean") throw invalid("checked is not a bool");
  if ([value, text, from, to, sel, checked].every((x) => x === undefined)) throw invalid("no field but rev");
  if (value !== undefined && (text !== undefined || from !== undefined || to !== undefined)) throw invalid("value comes with text, from or to");
  if ((from === undefined) !== (to === undefined)) throw invalid("from and to come together");
  if (from !== undefined && text === undefined) throw invalid("from and to come with text");
  if (from !== undefined && (from as number) > (to as number)) throw invalid("from is past to");
  const change: FieldChange = { rev };
  if (value !== undefined) change.value = value as string;
  if (text !== undefined) change.text = text as string;
  if (from !== undefined) [change.from, change.to] = [from as number, to as number];
  if (sel !== undefined) change.sel = [(sel as number[])[0]!, (sel as number[])[1]!];
  if (checked !== undefined) change.checked = checked as boolean;
  return change;
}

/** The bytes of a code point in UTF-8. A lone surrogate is U+FFFD's three,
 * as it is sent. */
const utf8Length = (c: number) => (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4);

/** The code unit of `s` at UTF-8 byte `b`; null when `b` is negative, past
 * the end of `s`, or inside a code point. */
export function unitAt(s: string, b: number): number | null {
  if (b < 0) return null;
  let bytes = 0;
  let i = 0;
  while (bytes < b) {
    if (i >= s.length) return null;
    const c = s.codePointAt(i)!;
    bytes += utf8Length(c);
    i += c > 0xffff ? 2 : 1;
  }
  return bytes === b ? i : null;
}

/** The UTF-8 byte of `s` at code unit `u`. */
export function byteAt(s: string, u: number): number {
  let bytes = 0;
  for (let i = 0; i < u && i < s.length; ) {
    const c = s.codePointAt(i)!;
    bytes += utf8Length(c);
    i += c > 0xffff ? 2 : 1;
  }
  return bytes;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Code unit `u` of `s`, moved to the start of the character (grapheme
 * cluster, SPEC §10.2) it falls inside, if it falls inside one. */
export function clusterStart(s: string, u: number): number {
  const g = u < s.length ? segmenter.segment(s).containing(u) : undefined;
  return g ? g.index : u;
}

/** A selection as events report it (SPEC §9): its anchor, then its caret,
 * in bytes of `value`'s UTF-8. */
export function wireSel(value: string, s: Sel): [number, number] {
  const [anchor, caret] = s.backward ? [s.end, s.start] : [s.start, s.end];
  return [byteAt(value, anchor), byteAt(value, caret)];
}
