// The bodies the addon writes (SPEC §3.3): each field in a form of its type,
// read back by this repository's reader and by the reference Python client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOTTY_DIR } from "../hotty.ts";
import { Float, float, Writer, type Body } from "../../src/msgpack.ts";
import { Control, encode } from "../../src/wire.ts";
import { unpack } from "../msgpack.ts";

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
