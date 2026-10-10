// What the addon sends, read back (SPEC §3.3): a msgpack reader that keeps
// ints and floats apart, as the vectors are read (hotty.ts), and the type
// of each body's fields, from SPEC §3.6, §4 and §9.
import { Float } from "../src/msgpack.ts";

/** A body nested deeper than this does not decode (SDK.md §3.9). */
const MAX_DEPTH = 32;

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The one msgpack value in `b`: a map is a plain object (its keys strings),
 * an array an array, an int a number, a float a `Float`, a str a string,
 * nil null. Throws when `b` is anything else: not one value, bytes after
 * it, an int a double cannot hold, nesting past 32, or a form a host never
 * sends (bin, an extension).
 */
export function unpack(b: Uint8Array): unknown {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const take = (n: number) => {
    if (i + n > b.length) throw new RangeError("msgpack: cut short");
    const at = i;
    i += n;
    return at;
  };
  // A 64-bit int, which a double holds only within 2^53 - 1 of zero.
  const big = (x: bigint) => {
    if (x > MAX || x < -MAX) throw new RangeError(`msgpack: ${x} is beyond 2^53 - 1`);
    return Number(x);
  };
  const value = (depth: number): unknown => {
    const c = b[take(1)]!;
    if (c <= 0x7f) return c;
    if (c >= 0xe0) return c - 0x100;
    if (c <= 0x8f) return map(c & 0x0f, depth);
    if (c <= 0x9f) return array(c & 0x0f, depth);
    if (c <= 0xbf) return str(c & 0x1f);
    switch (c) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xca: return new Float(d.getFloat32(take(4)));
      case 0xcb: return new Float(d.getFloat64(take(8)));
      case 0xcc: return d.getUint8(take(1));
      case 0xcd: return d.getUint16(take(2));
      case 0xce: return d.getUint32(take(4));
      case 0xcf: return big(d.getBigUint64(take(8)));
      case 0xd0: return d.getInt8(take(1));
      case 0xd1: return d.getInt16(take(2));
      case 0xd2: return d.getInt32(take(4));
      case 0xd3: return big(d.getBigInt64(take(8)));
      case 0xd9: return str(d.getUint8(take(1)));
      case 0xda: return str(d.getUint16(take(2)));
      case 0xdb: return str(d.getUint32(take(4)));
      case 0xdc: return array(d.getUint16(take(2)), depth);
      case 0xdd: return array(d.getUint32(take(4)), depth);
      case 0xde: return map(d.getUint16(take(2)), depth);
      case 0xdf: return map(d.getUint32(take(4)), depth);
    }
    throw new RangeError(`msgpack: 0x${c.toString(16)} is no form a host sends`);
  };
  const str = (n: number) => {
    const at = take(n);
    return utf8.decode(b.subarray(at, at + n));
  };
  const array = (n: number, depth: number) => {
    if (depth === MAX_DEPTH) throw new RangeError("msgpack: nested too deep");
    return Array.from({ length: n }, () => value(depth + 1));
  };
  const map = (n: number, depth: number) => {
    if (depth === MAX_DEPTH) throw new RangeError("msgpack: nested too deep");
    const out: Record<string, unknown> = {};
    for (let k = 0; k < n; k++) {
      const key = value(depth + 1);
      if (typeof key !== "string") throw new TypeError(`msgpack: a map key that is not a str: ${String(key)}`);
      if (Object.hasOwn(out, key)) throw new TypeError(`msgpack: the key ${key} twice`);
      Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  const v = value(0);
  if (i !== b.length) throw new RangeError("msgpack: bytes after the value");
  return v;
}

/**
 * A field's type (SPEC §3.3): `int`, `float`, `str` or `bool`; `[T]`, an
 * array of T; `{ "*": T }`, a map from strings to T; any other object, a
 * map with these fields.
 */
export type Type = "int" | "float" | "str" | "bool" | [Type] | { [field: string]: Type };

const AREA: Type = { c: "int", r: "int", w: "int", h: "int" };
const DRAG: Type = { c: "int", r: "int", keys: ["str"], x: "int", y: "int" };

/** SPEC §3.6: an error's body. */
export const ERROR: Type = { code: "str", detail: "str" };

/** SPEC §4: the capabilities. */
export const CAPS: Type = {
  v: "str",
  ops: ["str"],
  events: ["str"],
  cell: { w: "int", h: "int" },
  scale: "float",
  scheme: "str",
  limits: { "*": "int" },
  net: { "*": ["str"] },
  passthrough: "bool",
  scroll: "bool",
  steps: "bool",
  host: "str",
  version: "str",
};

/** SPEC §9: each event kind's detail; the kinds not here carry none. */
export const DETAIL: Record<string, Type> = {
  click: { href: "str", url: "str", value: "str", area: AREA },
  press: { area: AREA },
  change: { checked: "bool", value: "str" },
  input: { value: "str" },
  submit: { "*": "str" },
  dragstart: DRAG,
  drag: DRAG,
  dragend: DRAG,
  resize: { w: "float", h: "float" },
  fit: { r: "int" },
  hover: { c: "int", r: "int", out: "bool" },
};

/**
 * Where `v` is not of type `t`, or null when it is. A host sends no field
 * the spec does not give it, so a field `t` does not name is wrong too.
 */
export function mistyped(v: unknown, t: Type, at = "body"): string | null {
  const is = (ok: boolean) => (ok ? null : `${at}: want ${JSON.stringify(t)}, got ${show(v)}`);
  if (t === "int") return is(typeof v === "number" && Number.isSafeInteger(v));
  if (t === "float") return is(v instanceof Float);
  if (t === "str") return is(typeof v === "string");
  if (t === "bool") return is(typeof v === "boolean");
  if (Array.isArray(t)) {
    if (!Array.isArray(v)) return is(false);
    for (const [i, x] of v.entries()) {
      const bad = mistyped(x, t[0], `${at}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Float) return is(false);
  for (const [k, x] of Object.entries(v)) {
    const f = t["*"] ?? t[k];
    if (f === undefined) return `${at}.${k}: a field SPEC does not give it`;
    const bad = mistyped(x, f, `${at}.${k}`);
    if (bad) return bad;
  }
  return null;
}

/** A decoded value as text, with its floats marked: `{"w":"float(720)"}`. */
export function show(v: unknown): string {
  return JSON.stringify(v, (_, x) => (x instanceof Float ? `float(${x.value})` : x));
}
