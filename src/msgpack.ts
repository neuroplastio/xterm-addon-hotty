// The bodies the host sends (SPEC §3.3): each reply's and event's is one
// msgpack map, and each field has a type, int, float, str or bool. Only
// writing is here: what a program sends is text, not msgpack.
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
