// Bodies (SPEC §3.3): each reply's and event's is one msgpack map, and each
// field has a type, int, float, str or bool. The Writer writes what the host
// sends; `read` reads what a program sends, a delta's ops (SPEC §6.1) and a
// menu (§10.5).
//
// JavaScript has one kind of number and msgpack two, and a field's type is
// the spec's, not its value's: `scale` is a float at 2 as at 1.5. So a
// number is written as an int, and must be a whole one, and a float is
// wrapped, `float(2)`, and written as a 64-bit float whatever its value.

/** A number that goes out as a float (float 64), even when whole. */
export class Float {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export const float = (value: number): Float => new Float(value);

/**
 * What a body holds. A number is an int, a Float a float, an array an
 * array, and a plain object a map. A field that is undefined or null is left
 * out: a host never sends nil (SPEC §3.3).
 */
export type Value = string | number | boolean | Float | readonly Value[] | Body;
export type Body = { readonly [field: string]: Value | null | undefined };

const utf8 = new TextEncoder();

/** Writes bodies into one buffer it keeps and grows. */
export class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private n = 0;

  /** `b` as msgpack: a view of the buffer, good until the next call. */
  body(b: Body): Uint8Array {
    this.n = 0;
    this.value(b);
    return this.buf.subarray(0, this.n);
  }

  private value(v: Value) {
    if (typeof v === "string") this.str(v);
    else if (typeof v === "number") this.int(v);
    else if (typeof v === "boolean") this.byte(v ? 0xc3 : 0xc2);
    else if (v instanceof Float) this.float(v.value);
    else if (Array.isArray(v)) {
      this.head(0x90, 0, 0xdc, 0xdd, v.length);
      for (const x of v as readonly Value[]) {
        if (x == null) throw new TypeError("an array holds no nil");
        this.value(x);
      }
    } else {
      // A map's keys are strings: a plain object's own, never its symbols.
      // Anything else that is an object (a Map, a Date, bytes) is a bug
      // where it was made, not an empty map.
      const proto = v === null || typeof v !== "object" ? undefined : Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`${String(v)} is no value a body holds`);
      // An object's keys differ, and each goes out once (SPEC §3.3), as
      // long as each is its own UTF-8: a lone surrogate goes out as U+FFFD,
      // so "\uD800" and "�" would be one key given twice.
      const fields = Object.entries(v as Body).filter((f): f is [string, Value] => f[1] != null);
      this.head(0x80, 0, 0xde, 0xdf, fields.length);
      for (const [k, x] of fields) {
        if (!k.isWellFormed()) throw new TypeError(`the key ${JSON.stringify(k)} holds a lone surrogate`);
        this.str(k);
        this.value(x);
      }
    }
  }

  /** An int in its smallest form. Only whole numbers within 2^53 − 1 of
   * zero are ints (SPEC §3.3): anything else is a bug where it was made. */
  private int(x: number) {
    if (!Number.isSafeInteger(x)) throw new RangeError(`${x} is not an int (a float goes in a Float)`);
    this.room(9);
    const d = this.view;
    if (x >= -0x20 && x < 0x80) this.buf[this.n++] = x & 0xff; // a fixint
    else if (x >= 0) {
      if (x < 0x100) d.setUint8(this.tag(0xcc, 1), x);
      else if (x < 0x10000) d.setUint16(this.tag(0xcd, 2), x);
      else if (x < 0x100000000) d.setUint32(this.tag(0xce, 4), x);
      else d.setBigUint64(this.tag(0xcf, 8), BigInt(x));
    } else if (x >= -0x80) d.setInt8(this.tag(0xd0, 1), x);
    else if (x >= -0x8000) d.setInt16(this.tag(0xd1, 2), x);
    else if (x >= -0x80000000) d.setInt32(this.tag(0xd2, 4), x);
    else d.setBigInt64(this.tag(0xd3, 8), BigInt(x));
  }

  private float(x: number) {
    this.room(9);
    this.view.setFloat64(this.tag(0xcb, 8), x);
  }

  private str(s: string) {
    // UTF-8 takes at most 3 bytes for each UTF-16 unit: encoded past the
    // largest header, then moved back behind the one it needs.
    this.room(5 + 3 * s.length);
    const at = this.n + 5;
    const { written } = utf8.encodeInto(s, this.buf.subarray(at));
    this.head(0xa0, 0xd9, 0xda, 0xdb, written, 31);
    this.buf.copyWithin(this.n, at, at + written);
    this.n += written;
  }

  /** A string's, an array's or a map's header: its fix form up to `fixMax`,
   * then 8 bits (strings only), 16 and 32. */
  private head(fix: number, c8: number, c16: number, c32: number, len: number, fixMax = 15) {
    this.room(5);
    if (len <= fixMax) this.buf[this.n++] = fix | len;
    else if (c8 && len < 0x100) this.view.setUint8(this.tag(c8, 1), len);
    else if (len < 0x10000) this.view.setUint16(this.tag(c16, 2), len);
    else this.view.setUint32(this.tag(c32, 4), len);
  }

  private byte(x: number) {
    this.room(1);
    this.buf[this.n++] = x;
  }

  /** A form's first byte, `code`, and `size` bytes after it, where the
   * caller writes them: it has made room for both. */
  private tag(code: number, size: number): number {
    this.buf[this.n] = code;
    const at = this.n + 1;
    this.n = at + size;
    return at;
  }

  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
    this.view = new DataView(b.buffer);
  }
}

/** A body nested more than this does not decode (SDK.md §3.9). */
const MAX_DEPTH = 32;
const MAX_INT = BigInt(Number.MAX_SAFE_INTEGER);
const strict = new TextDecoder("utf-8", { fatal: true });

/** A msgpack timestamp (extension type −1), as a body may hold one. */
export class Timestamp {
  readonly seconds: number;
  readonly nanoseconds: number;
  constructor(seconds: number, nanoseconds: number) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
  }
}

/**
 * The one msgpack value in `bytes`, as a body of a program (SPEC §3.3): a map
 * is an object with no prototype, keyed by strings; an array an array; an int
 * a number, a float a `Float`, a str a string, a bool a boolean, bin a
 * `Uint8Array` and a timestamp a `Timestamp`. It throws where the body does
 * not decode (SDK.md §3.9): it is not one value, or bytes follow it; it
 * nests deeper than 32 levels; it holds, anywhere, a nil, a map key that is
 * not a str, a key given twice in a map, a str that is not UTF-8, an int
 * further than 2^53 − 1 from zero, an extension that is not a timestamp, or
 * a timestamp of another size, with a second's nanoseconds or more, or with
 * seconds further than 2^53 − 1 from 1970.
 *
 * What a peer can make it allocate is bounded by the bytes it sends: a
 * length is checked against the bytes left before anything is made of it,
 * and every element takes a byte at least.
 */
export function read(bytes: Uint8Array): unknown {
  const b = bytes;
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  const take = (n: number): number => {
    if (n > b.length - at) throw new RangeError("msgpack: cut short");
    const i = at;
    at += n;
    return i;
  };
  const big = (x: bigint): number => {
    if (x > MAX_INT || x < -MAX_INT) throw new RangeError(`msgpack: ${x} is beyond 2^53 - 1`);
    return Number(x);
  };
  const str = (n: number): string => {
    const i = take(n);
    try {
      return strict.decode(b.subarray(i, i + n));
    } catch {
      throw new TypeError("msgpack: a str that is not UTF-8");
    }
  };
  const bin = (n: number): Uint8Array => {
    const i = take(n);
    return b.slice(i, i + n);
  };
  const ext = (n: number): Timestamp => {
    const type = d.getInt8(take(1));
    const i = take(n);
    if (type !== -1) throw new TypeError(`msgpack: the extension ${type}`);
    let seconds: bigint;
    let nanoseconds: number;
    if (n === 4) [seconds, nanoseconds] = [BigInt(d.getUint32(i)), 0];
    else if (n === 8) {
      const x = d.getBigUint64(i);
      [seconds, nanoseconds] = [x & 0x3ffffffffn, Number(x >> 34n)];
    } else if (n === 12) [seconds, nanoseconds] = [d.getBigInt64(i + 4), d.getUint32(i)];
    else throw new RangeError(`msgpack: a timestamp of ${n} bytes`);
    if (nanoseconds >= 1e9) throw new RangeError(`msgpack: a timestamp's ${nanoseconds} nanoseconds`);
    return new Timestamp(big(seconds), nanoseconds);
  };
  const array = (n: number, depth: number): unknown[] => {
    if (depth === MAX_DEPTH) throw new RangeError("msgpack: nested too deep");
    // Each element takes a byte at least: a count past what is left lies.
    if (n > b.length - at) throw new RangeError("msgpack: cut short");
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(value(depth + 1));
    return out;
  };
  const map = (n: number, depth: number): Record<string, unknown> => {
    if (depth === MAX_DEPTH) throw new RangeError("msgpack: nested too deep");
    if (2 * n > b.length - at) throw new RangeError("msgpack: cut short");
    const out: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < n; i++) {
      const k = value(depth + 1);
      if (typeof k !== "string") throw new TypeError("msgpack: a map key that is not a str");
      // The key as decoded, whatever its form: a fixstr and a str8 of one name are one key.
      if (k in out) throw new TypeError(`msgpack: the key ${JSON.stringify(k)} is given twice`);
      out[k] = value(depth + 1);
    }
    return out;
  };
  const value = (depth: number): unknown => {
    const c = d.getUint8(take(1));
    if (c <= 0x7f) return c;
    if (c >= 0xe0) return c - 0x100;
    if (c <= 0x8f) return map(c & 0x0f, depth);
    if (c <= 0x9f) return array(c & 0x0f, depth);
    if (c <= 0xbf) return str(c & 0x1f);
    switch (c) {
      case 0xc0:
        throw new TypeError("msgpack: a nil");
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return bin(d.getUint8(take(1)));
      case 0xc5:
        return bin(d.getUint16(take(2)));
      case 0xc6:
        return bin(d.getUint32(take(4)));
      case 0xc7:
        return ext(d.getUint8(take(1)));
      case 0xc8:
        return ext(d.getUint16(take(2)));
      case 0xc9:
        return ext(d.getUint32(take(4)));
      case 0xca:
        return new Float(d.getFloat32(take(4)));
      case 0xcb:
        return new Float(d.getFloat64(take(8)));
      case 0xcc:
        return d.getUint8(take(1));
      case 0xcd:
        return d.getUint16(take(2));
      case 0xce:
        return d.getUint32(take(4));
      case 0xcf:
        return big(d.getBigUint64(take(8)));
      case 0xd0:
        return d.getInt8(take(1));
      case 0xd1:
        return d.getInt16(take(2));
      case 0xd2:
        return d.getInt32(take(4));
      case 0xd3:
        return big(d.getBigInt64(take(8)));
      case 0xd4:
        return ext(1);
      case 0xd5:
        return ext(2);
      case 0xd6:
        return ext(4);
      case 0xd7:
        return ext(8);
      case 0xd8:
        return ext(16);
      case 0xd9:
        return str(d.getUint8(take(1)));
      case 0xda:
        return str(d.getUint16(take(2)));
      case 0xdb:
        return str(d.getUint32(take(4)));
      case 0xdc:
        return array(d.getUint16(take(2)), depth);
      case 0xdd:
        return array(d.getUint32(take(4)), depth);
      case 0xde:
        return map(d.getUint16(take(2)), depth);
      case 0xdf:
        return map(d.getUint32(take(4)), depth);
    }
    throw new RangeError(`msgpack: 0x${c.toString(16)} is no msgpack form`);
  };
  const v = value(0);
  if (at !== b.length) throw new RangeError("msgpack: bytes after the value");
  return v;
}
