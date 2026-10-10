// The bodies the addon writes (SPEC §3.3): each field in a form of its type,
// read back by this repository's reader and by the reference Python client;
// and that reader, which reads them as an SDK does (SDK.md §3.9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOTTY_DIR, readVectors } from "../hotty.ts";
import { Float, float, Writer, type Body } from "../../src/msgpack.ts";
import { Control, decodeAll, encode } from "../../src/wire.ts";
import { CAPS, DETAIL, ERROR, Ext, mistyped, Timestamp, unpack, type Type } from "../msgpack.ts";

const hex = (b: Body) => Buffer.from(new Writer().body(b)).toString("hex");
/** A one-field body `{"x": v}`, without its map's and its key's bytes. */
const field = (v: Body[string]) => hex({ x: v }).slice(6);

test("an int goes out in its smallest form, signed or not", () => {
  const forms: [number, string][] = [
    [0, "00"],
    [127, "7f"],
    [128, "cc80"],
    [255, "ccff"],
    [256, "cd0100"],
    [65535, "cdffff"],
    [65536, "ce00010000"],
    [2 ** 32 - 1, "ceffffffff"],
    [2 ** 32, "cf0000000100000000"],
    [Number.MAX_SAFE_INTEGER, "cf001fffffffffffff"],
    [-1, "ff"],
    [-32, "e0"],
    [-33, "d0df"],
    [-128, "d080"],
    [-129, "d1ff7f"],
    [-32768, "d18000"],
    [-32769, "d2ffff7fff"],
    [-(2 ** 31), "d280000000"],
    [-(2 ** 31) - 1, "d3ffffffff7fffffff"],
    [-Number.MAX_SAFE_INTEGER, "d3ffe0000000000001"],
  ];
  for (const [x, want] of forms) assert.equal(field(x), want, String(x));
});

test("a Float goes out as a 64-bit float, even when whole", () => {
  assert.equal(field(float(2)), "cb4000000000000000");
  assert.equal(field(float(1.5)), "cb3ff8000000000000");
  assert.equal(field(float(-0.25)), "cbbfd0000000000000");
});

test("a number that is not an int is refused: a float goes in a Float", () => {
  for (const x of [1.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53)]) assert.throws(() => field(x), RangeError, String(x));
});

test("strings, arrays and maps take their fix forms, then 8 (strings), 16 and 32 bits", () => {
  assert.equal(field(""), "a0");
  assert.equal(field("é∑"), "a5" + Buffer.from("é∑").toString("hex"));
  assert.equal(field("x".repeat(31)).slice(0, 2), "bf");
  assert.equal(field("x".repeat(32)).slice(0, 4), "d920");
  assert.equal(field("x".repeat(256)).slice(0, 6), "da0100");
  assert.equal(field("x".repeat(65536)).slice(0, 10), "db00010000");
  assert.equal(field(Array(15).fill(true)).slice(0, 2), "9f");
  assert.equal(field(Array(16).fill(false)).slice(0, 6), "dc0010");
  const map = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
  assert.equal(field(map(15)).slice(0, 2), "8f");
  assert.equal(field(map(16)).slice(0, 6), "de0010");
  assert.equal(hex({ yes: true, no: false }), "82a3796573c3a26e6fc2");
});

test("a field with nothing (undefined, null) is left out: no nil", () => {
  assert.equal(hex({ a: 1, b: undefined, c: null, d: { e: null } }), "82a16101a16480");
  assert.throws(() => hex({ a: [1, null as unknown as number] }), TypeError);
});

test("a map is a plain object, keyed by its own strings; anything else is refused, not written", () => {
  assert.throws(() => new Writer().body(null as unknown as Body), TypeError);
  for (const x of [1n, new Map([[1, 2]]), new Date(0), Uint8Array.of(1), Symbol("x"), () => 1]) {
    assert.throws(() => field(x as unknown as Body[string]), TypeError, String(x));
  }
  // A symbol is no field; an object with no prototype is a map.
  assert.equal(hex({ a: 1, [Symbol("s")]: 2 } as Body), "81a16101");
  assert.equal(hex(Object.assign(Object.create(null) as Body, { a: 1 })), "81a16101");
});

test("a key goes out once: one with a lone surrogate, which would go out as U+FFFD, is refused", () => {
  assert.throws(() => hex({ "\ud800": 1, "�": 2 }), TypeError);
  assert.throws(() => field({ "a\udc00": 1 }), TypeError);
  assert.equal(hex({ "�": 1, "😀": 2 }), "82a3efbfbd01a4f09f988002");
});

test("the buffer grows, and is reused", () => {
  const w = new Writer();
  const long = "∑".repeat(50_000);
  assert.deepEqual(unpack(w.body({ s: long })), { s: long });
  assert.deepEqual(unpack(w.body({ s: "short" })), { s: "short" });
});

test("what it writes reads back, each value of its type", () => {
  const body = { v: "0.2", cell: { w: 16, h: 32 }, scale: float(2), keys: ["shift"], c: -3, out: true };
  const got = unpack(new Writer().body(body)) as Record<string, unknown>;
  assert.deepEqual(got, { v: "0.2", cell: { w: 16, h: 32 }, scale: new Float(2), keys: ["shift"], c: -3, out: true });
  assert.ok(got.scale instanceof Float);
  assert.equal(typeof got.c, "number");
});

test("the reader takes one map and nothing more, at most 32 deep", () => {
  assert.throws(() => unpack(Buffer.from("81a178", "hex")), /cut short/);
  assert.throws(() => unpack(Buffer.from("8000", "hex")), /bytes after/);
  assert.throws(() => unpack(Buffer.from("81a178cf0020000000000000", "hex")), /2\^53/);
  const deep = (n: number) => Buffer.from("81a178".repeat(n - 1) + "80", "hex");
  assert.doesNotThrow(() => unpack(deep(32)));
  assert.throws(() => unpack(deep(33)), /too deep/);
});

test("the reader fails a body that holds, anywhere, what no host sends (SDK.md §3.9)", () => {
  const fails: [string, RegExp][] = [
    ["81a178c0", /a nil/], // {x: nil}
    ["81a17891c0", /a nil/], // {x: [nil]}
    ["81c0a178", /a nil/], // {nil: "x"}
    ["8101a178", /not a str/], // {1: "x"}
    ["81a17881c401787f", /not a str/], // {x: {bin "x": 127}}
    ["81a178a2c328", /UTF-8/], // a broken sequence
    ["81a2c328a178", /UTF-8/], // in a key
    ["81a178a3eda080", /UTF-8/], // a surrogate
    ["81a178a4f4908080", /UTF-8/], // past U+10FFFF
    ["81a178cf0020000000000000", /2\^53/], // 2^53
    ["81a17891d3ffe0000000000000", /2\^53/], // -(2^53)
    ["81a178d5ff0000", /timestamp of 2 bytes/],
    ["81a178d7ffee6b280000000000", /nanoseconds/], // 1e9 of them
    ["81a178c70cff000000000020000000000000", /seconds/], // 2^53 of them
    ["82a17801a17801", /twice/], // {x: 1, x: 1}
    ["82a17801a178a161", /twice/], // {x: 1, x: "a"}
    ["82a17801d9017802", /twice/], // {x: 1, (str8) x: 2}
    ["81a178928082a17901a17902", /twice/], // {x: [{}, {y: 1, y: 2}]}
  ];
  for (const [b, why] of fails) assert.throws(() => unpack(Buffer.from(b, "hex")), why, b);
  // One name in two maps is two keys.
  assert.deepEqual(unpack(Buffer.from("82a17801a17981a17802", "hex")), { x: 1, y: { x: 2 } });
});

test("the reader reads bin, timestamps and extensions as an SDK does, and no field's type is one", () => {
  // {b: bin 00ff, t: 1 s (4 bytes), u: 2 s 1 ns (8), v: -(2^53 − 1) s 999999999 ns (12), e: extension 5}
  const b = "85a162c40200ffa174d6ff00000001a175d7ff0000000400000002a176c70cff3b9ac9ffffe0000000000001a165d40500";
  const got = unpack(Buffer.from(b, "hex")) as Record<string, unknown>;
  assert.deepEqual(got, {
    b: Uint8Array.of(0, 255),
    t: new Timestamp(1, 0),
    u: new Timestamp(2, 1),
    v: new Timestamp(-Number.MAX_SAFE_INTEGER, 999_999_999),
    e: new Ext(5, Uint8Array.of(0)),
  });
  const types: Type[] = ["int", "float", "str", "bool", ["int"], { "*": "int" }, {}];
  for (const v of Object.values(got)) for (const t of types) assert.notEqual(mistyped(v, t, "skip"), null, `${JSON.stringify(t)}`);
});

// The SDKs' decode vectors (conformance/README.md), each body read with its
// reply's or event's type, fields the type does not name skipped: it reads
// here exactly where an SDK fills something from it. The vectors about the
// wire alone (decode.*) are not about bodies.
const vectors = readVectors();
const needs = (v: { requires?: string | string[] }) => (v.requires === undefined ? [] : [v.requires].flat());
// Why each body of two vectors that does not decode fails: the strict one's
// hold what no host sends (a nil, a key given twice, …), which the reader
// fails whatever the field; the kinds one's are msgpack the reader takes,
// each with a known field of another kind than its type (SPEC §3.3).
const because: Record<string, "reader" | "type"> = {
  "a body that holds, anywhere, what no host sends does not decode": "reader",
  "a field a reader knows holding another kind of value than its type does not decode": "type",
};
test("the vectors whose bodies fail for one reason are there", () => {
  for (const name of Object.keys(because)) assert.ok(vectors.decode.some((v: { name: string }) => v.name.startsWith(name)), name);
});
for (const v of vectors.decode.filter((v: { bodies?: unknown; requires?: string[] }) => v.bodies && !needs(v).some((r) => r.startsWith("decode.")))) {
  const why = Object.entries(because).find(([name]) => v.name.startsWith(name))?.[1];
  test(`decode: ${v.name}`, async () => {
    const commands = await decodeAll((v.seqs as string[]).join(""));
    assert.equal(commands.length, v.messages.length);
    commands.forEach((c, i) => {
      const m = v.messages[i];
      const [a, e] = [c.control.get("a"), c.control.get("e") ?? ""];
      const type = a === "ev" ? DETAIL[e] : a === "err" ? ERROR : a === "ok" && c.control.get("re") === "q" ? CAPS : undefined;
      if (!c.payload.length || type === undefined) return;
      let fails: ["reader" | "type", string] | null = null;
      try {
        const bad = mistyped(unpack(c.payload), type, "skip");
        if (bad !== null) fails = ["type", bad];
      } catch (err) {
        fails = ["reader", (err as Error).message];
      }
      // What an SDK fills from a body (SDK.md §3.9).
      const event = ["value", "checked", "fields", "link", "size", "fit_rows", "drag", "hover", "area"];
      const filled = m.caps != null || m.reply?.code != null || m.reply?.detail != null || event.some((k) => m.event?.[k] != null);
      const at = `message ${i + 1}: ${a} ${e}${fails ? ` (${fails[1]})` : ""}`;
      assert.equal(fails === null, filled, at);
      if (fails && why) assert.equal(fails[0], why, at);
    });
  });
}

test("the reference Python client reads the details by their types", () => {
  const ev = (kind: string, detail: Body) => encode(new Control().set("a", "ev").set("s", "x").set("e", kind).set("t", "id"), new Writer().body(detail));
  const stream = [
    ev("resize", { w: float(720), h: float(48.5) }),
    ev("dragend", { c: -2, r: 300, keys: ["shift", "ctrl"], x: 3 }),
    ev("click", { href: "next", area: { c: 0, r: 1, w: 10, h: 2 } }),
    ev("change", { checked: true, value: null }),
    ev("submit", { q: "hi", theme: "dark" }),
    ev("fit", { r: 3 }),
  ].join("");
  const script = `
import json, sys; sys.path.insert(0, ${JSON.stringify(join(HOTTY_DIR, "clients", "python"))})
import hotty
d, out = hotty.Decoder(), []
for seq in sys.stdin.buffer.read().split(b"\\x1b\\\\"):
    result, m = d.feed(seq)
    if result != hotty.COMPLETE:
        continue
    e = m.event()
    name = lambda x: type(x).__name__
    out.append({
        "resize": lambda: [name(x) for x in e.size()],
        "dragend": lambda: vars(e.drag()),
        "click": lambda: [e.link(), vars(e.area())],
        "change": lambda: [e.checked(), e.value()],
        "submit": lambda: e.fields(),
        "fit": lambda: e.fit_rows(),
    }[e.kind]())
print(json.dumps(out))
`;
  const out = JSON.parse(execFileSync("python3", ["-c", script], { input: stream, encoding: "utf8" }));
  assert.deepEqual(out, [
    ["float", "float"],
    { c: -2, r: 300, keys: ["shift", "ctrl"], x: 3, y: null },
    [["next", null], { c: 0, r: 1, w: 10, h: 2 }],
    [true, null],
    { q: "hi", theme: "dark" },
    3,
  ]);
});
