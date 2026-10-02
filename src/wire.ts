// The HOTTY envelope (PROTOCOL §2): OSC 7279 ; <control> ; <base64 payload> ST.
//
// xterm.js hands an OSC handler everything after `7279;`, so this module sees
// `<control>[;<payload>]` strings. It parses controls, reassembles chunked
// commands (`m=1`), decodes base64 and zlib (`o=z`), and encodes replies.

export const OSC = 7279;
/** Largest base64 chunk a host sends (VTE ignores longer strings). */
export const CHUNK = 4096;
/** Largest reassembled command, in base64 bytes. */
export const MAX_COMMAND = 16 << 20;

/** `key=value` pairs separated by `:`, in order. */
export class Control {
  readonly pairs: [string, string][];

  constructor(pairs: [string, string][] = []) {
    this.pairs = pairs;
  }

  static parse(text: string): Control {
    const pairs: [string, string][] = [];
    if (text === "") return new Control(pairs);
    for (const part of text.split(":")) {
      const eq = part.indexOf("=");
      if (eq <= 0) throw new Error(`bad control pair ${JSON.stringify(part)}`);
      pairs.push([part.slice(0, eq), part.slice(eq + 1)]);
    }
    return new Control(pairs);
  }

  get(key: string): string | undefined {
    for (const [k, v] of this.pairs) if (k === key) return v;
    return undefined;
  }

  set(key: string, value: string): this {
    const i = this.pairs.findIndex(([k]) => k === key);
    if (i >= 0) this.pairs[i] = [key, value];
    else this.pairs.push([key, value]);
    return this;
  }

  delete(key: string): this {
    const i = this.pairs.findIndex(([k]) => k === key);
    if (i >= 0) this.pairs.splice(i, 1);
    return this;
  }

  /** A continuation chunk carries nothing but `m` and `q`. */
  onlyChunkKeys(): boolean {
    return this.pairs.every(([k]) => k === "m" || k === "q");
  }

  encode(): string {
    return this.pairs.map(([k, v]) => `${k}=${clean(v)}`).join(":");
  }
}

/**
 * A control value is printable ASCII (SPEC §3.2): each character it may not
 * hold (`:`, `;`, `=`, a control character, anything outside ASCII) becomes
 * one `_`, one per code point.
 */
export function clean(value: string): string {
  return value.replace(/[^\x20-\x7e]|[:;=]/gu, "_");
}

export interface Command {
  control: Control;
  payload: Uint8Array;
}

export type Decoded =
  | { kind: "command"; command: Command }
  | { kind: "invalid"; reason: string }
  | { kind: "partial" };

/**
 * Reassembles chunked commands. Decoding is synchronous unless the payload is
 * zlib (`o=z`), which the browser only inflates asynchronously; the caller
 * then gets a Promise, and xterm's parser waits for it.
 */
export class Assembler {
  private partial: { control: Control; b64: string[]; size: number } | null = null;

  /** Feeds the data of one OSC 7279 sequence. */
  feed(data: string): Decoded[] | Promise<Decoded[]> {
    const semi = data.indexOf(";");
    const ctlText = semi < 0 ? data : data.slice(0, semi);
    const b64 = semi < 0 ? "" : data.slice(semi + 1);
    let control: Control;
    try {
      control = Control.parse(ctlText);
    } catch (e) {
      this.partial = null;
      return [{ kind: "invalid", reason: String((e as Error).message) }];
    }
    const more = control.get("m") === "1";
    const partial = this.partial;
    this.partial = null;
    if (partial && control.onlyChunkKeys()) {
      partial.b64.push(b64);
      partial.size += b64.length;
      if (partial.size > MAX_COMMAND) return [{ kind: "invalid", reason: "command too large" }];
      if (more) {
        this.partial = partial;
        return [{ kind: "partial" }];
      }
      return settle([], emit(partial.control, partial.b64.join("")));
    }
    const out: Decoded[] = [];
    if (partial) out.push({ kind: "invalid", reason: "chunked command interrupted" });
    if (more) {
      this.partial = { control, b64: [b64], size: b64.length };
      out.push({ kind: "partial" });
      return out;
    }
    return settle(out, emit(control, b64));
  }
}

function settle(out: Decoded[], d: Decoded | Promise<Decoded>): Decoded[] | Promise<Decoded[]> {
  if (d instanceof Promise) return d.then((x) => [...out, x]);
  out.push(d);
  return out;
}

function emit(control: Control, b64: string): Decoded | Promise<Decoded> {
  const fail = (e: unknown): Decoded => ({ kind: "invalid", reason: `bad payload: ${(e as Error).message}` });
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(b64);
  } catch (e) {
    return fail(e);
  }
  const done = (payload: Uint8Array): Decoded => {
    control.delete("m").delete("o");
    return { kind: "command", command: { control, payload } };
  };
  if (control.get("o") === "z") return inflate(bytes).then(done, fail);
  return done(bytes);
}

export function fromBase64(b64: string): Uint8Array {
  const s = b64.replace(/\s+/g, "");
  if (s === "") return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** zlib (RFC 1950), which `DecompressionStream` calls "deflate". */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = new TextDecoder("utf-8", { fatal: false });
const utf8Encoder = new TextEncoder();

export function text(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/**
 * Encodes one message for the program: base64, chunked at `CHUNK`, each chunk
 * a complete OSC terminated by ST. Replies are small, so they are never
 * compressed (`o=z` is optional in both directions).
 */
export function encode(control: Control, payload: Uint8Array | string = new Uint8Array(0)): string {
  const bytes = typeof payload === "string" ? utf8Encoder.encode(payload) : payload;
  const b64 = toBase64(bytes);
  const osc = (ctl: string, chunk: string | null) =>
    `\x1b]${OSC};${ctl}${chunk === null ? "" : `;${chunk}`}\x1b\\`;
  if (b64.length <= CHUNK) return osc(control.encode(), b64 === "" ? null : b64);
  const quiet = control.get("q");
  let out = "";
  for (let i = 0; i < b64.length; i += CHUNK) {
    const last = i + CHUNK >= b64.length;
    let ctl: Control;
    if (i === 0) {
      ctl = new Control([...control.pairs]).set("m", "1");
    } else {
      ctl = new Control([["m", last ? "0" : "1"]]);
      if (quiet !== undefined) ctl.set("q", quiet);
    }
    out += osc(ctl.encode(), b64.slice(i, i + CHUNK));
  }
  return out;
}

/** Decodes messages the host sent (for tests and for programs written in JS). */
export async function decodeAll(stream: string): Promise<Command[]> {
  const a = new Assembler();
  const out: Command[] = [];
  const re = /\x1b\]7279;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  for (const m of stream.matchAll(re)) {
    for (const d of await a.feed(m[1]!)) if (d.kind === "command") out.push(d.command);
  }
  return out;
}
