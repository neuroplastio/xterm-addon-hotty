// What the addon sends, read back (SPEC §3.3): a msgpack reader that keeps
// ints and floats apart, as the vectors are read (hotty.ts), and fails what
// an SDK fails (SDK.md §3.9); and the type of each body's fields, from SPEC
// §3.6, §4 and §9.
import { Float } from "../src/msgpack.ts";

/** A body nested deeper than this does not decode (SDK.md §3.9). */
const MAX_DEPTH = 32;

const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A msgpack timestamp (extension −1): seconds from 1970, and nanoseconds. */
export class Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
}

/** An extension of another type: no one defines one. */
export class Ext {
  readonly type: number;
  readonly data: Uint8Array;
  constructor(type: number, data: Uint8Array) {
    this.type = type;
    this.data = data;
  }
}

/**
 * The one msgpack value in `b`, read as an SDK reads a body: a map is a
 * plain object (its keys strings), an array an array, an int a number, a
 * float a `Float`, a str a string, a bool a boolean, bin a `Uint8Array`, a
 * timestamp a `Timestamp` and another extension an `Ext`. Throws where an
 * SDK's body does not decode (SPEC §3.3, SDK.md §3.9), anywhere in it: not
 * one value, bytes after it, nesting past 32, a nil, a map key that is not
 * a str, a key given twice in one map (keys compared as the strings they
 * are, so a fixstr and a str8 of one name are one key), a str that is not
 * UTF-8, an int further than 2^53 − 1 from zero, or a timestamp of another
 * size, with a second's nanoseconds or more, or with seconds further than
 * 2^53 − 1 from 1970.
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
      case 0xc0: throw new TypeError("msgpack: a nil");
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bytes(d.getUint8(take(1)));
      case 0xc5: return bytes(d.getUint16(take(2)));
      case 0xc6: return bytes(d.getUint32(take(4)));
      case 0xc7: return ext(d.getUint8(take(1)));
      case 0xc8: return ext(d.getUint16(take(2)));
      case 0xc9: return ext(d.getUint32(take(4)));
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
      case 0xd4: return ext(1);
      case 0xd5: return ext(2);
      case 0xd6: return ext(4);
      case 0xd7: return ext(8);
      case 0xd8: return ext(16);
      case 0xd9: return str(d.getUint8(take(1)));
      case 0xda: return str(d.getUint16(take(2)));
      case 0xdb: return str(d.getUint32(take(4)));
      case 0xdc: return array(d.getUint16(take(2)), depth);
      case 0xdd: return array(d.getUint32(take(4)), depth);
      case 0xde: return map(d.getUint16(take(2)), depth);
      case 0xdf: return map(d.getUint32(take(4)), depth);
    }
    throw new RangeError(`msgpack: 0x${c.toString(16)} is no msgpack form`);
  };
  const str = (n: number) => {
    const at = take(n);
    try {
      return utf8.decode(b.subarray(at, at + n));
    } catch {
      throw new TypeError("msgpack: a str that is not UTF-8");
    }
  };
  const bytes = (n: number) => {
    const at = take(n);
    return new Uint8Array(b.subarray(at, at + n));
  };
  // An extension of n bytes: a timestamp, 4, 8 or 12 of them, or another.
  const ext = (n: number) => {
    const type = d.getInt8(take(1));
    const at = take(n);
    if (type !== -1) return new Ext(type, new Uint8Array(b.subarray(at, at + n)));
    let s: bigint, ns: number;
    if (n === 4) [s, ns] = [BigInt(d.getUint32(at)), 0];
    else if (n === 8) {
      const x = d.getBigUint64(at);
      [s, ns] = [x & 0x3ffffffffn, Number(x >> 34n)];
    } else if (n === 12) [s, ns] = [d.getBigInt64(at + 4), d.getUint32(at)];
    else throw new RangeError(`msgpack: a timestamp of ${n} bytes`);
    if (ns >= 1e9) throw new RangeError(`msgpack: a timestamp's ${ns} nanoseconds`);
    if (s > MAX || s < -MAX) throw new RangeError(`msgpack: a timestamp's ${s} seconds are beyond 2^53 - 1`);
    return new Timestamp(Number(s), ns);
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
      if (typeof key !== "string") throw new TypeError(`msgpack: a map key that is not a str: ${show(key)}`);
      // The key as decoded, whatever its form: a fixstr "v" and a str8 "v" are one.
      if (Object.hasOwn(out, key)) throw new TypeError(`msgpack: a key given twice: ${show(key)}`);
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
 * map with these fields. The same as a vector's `types`
 * (conformance/README.md). No field is bin, a timestamp or an extension.
 */
export type Type = "int" | "float" | "str" | "bool" | [Type] | { [field: string]: Type };

const AREA: Type = { c: "int", r: "int", w: "int", h: "int" };
const DRAG: Type = { c: "int", r: "int", keys: ["str"], x: "int", y: "int", tx: "int", ty: "int" };

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
  drop: "bool",
  count: "bool",
  mod: "str",
  edit: { "*": ["str"] },
  keys: { leader: "str", timeout: "int" },
  menu: "bool",
  host: "str",
  version: "str",
};

/** SPEC §9: each event kind's detail; the kinds not here carry none. */
export const DETAIL: Record<string, Type> = {
  click: { href: "str", url: "str", value: "str", area: AREA, count: "int" },
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
  view: { in: { "*": AREA }, end: "bool" },
  command: { name: "str", key: "str", text: "str" },
  caps: CAPS,
};

/** A map as `unpack` reads one: a plain object. */
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Where `v` is not of type `t`, or null when it is. A host sends no field
 * the spec does not give it, so a field `t` does not name is wrong too;
 * with `others` "skip", it is not checked, as a vector's `types` checks
 * only the fields it names (conformance/README.md).
 */
export function mistyped(v: unknown, t: Type, others: "fail" | "skip" = "fail", at = "body"): string | null {
  const is = (ok: boolean) => (ok ? null : `${at}: want ${JSON.stringify(t)}, got ${show(v)}`);
  if (t === "int") return is(typeof v === "number" && Number.isSafeInteger(v));
  if (t === "float") return is(v instanceof Float);
  if (t === "str") return is(typeof v === "string");
  if (t === "bool") return is(typeof v === "boolean");
  if (Array.isArray(t)) {
    if (!Array.isArray(v)) return is(false);
    for (const [i, x] of v.entries()) {
      const bad = mistyped(x, t[0], others, `${at}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (!isMap(v)) return is(false);
  for (const [k, x] of Object.entries(v)) {
    const f = t["*"] ?? (Object.hasOwn(t, k) ? (t as Record<string, Type>)[k] : undefined);
    if (f === undefined) {
      if (others === "skip") continue;
      return `${at}.${k}: a field SPEC does not give it`;
    }
    const bad = mistyped(x, f, others, `${at}.${k}`);
    if (bad) return bad;
  }
  return null;
}

/** A decoded value as text, with its floats and what JSON has not marked:
 * `{"w":"float(720)"}`, `bin(00ff)`, `timestamp(0, 0)`, `ext(5, 00)`. */
export function show(v: unknown): string {
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const text = JSON.stringify(v, (_, x) => {
    if (x instanceof Float) return `float(${x.value})`;
    if (x instanceof Uint8Array) return `bin(${hex(x)})`;
    if (x instanceof Timestamp) return `timestamp(${x.seconds}, ${x.nanoseconds})`;
    if (x instanceof Ext) return `ext(${x.type}, ${hex(x.data)})`;
    return x;
  });
  return text ?? String(v);
}
