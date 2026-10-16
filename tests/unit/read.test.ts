// What a peer's bytes can make the addon read or allocate (SPEC §3.3, §6.1,
// §10.7): msgpack's reader, a delta body's whole check, a menu's body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { read, Writer } from "../../src/msgpack.ts";
import { DeltaError, readDelta } from "../../src/delta.ts";
import { readMenu } from "../../src/menu.ts";

const w = (b: Record<string, never> | Record<string, unknown>) => new Writer().body(b as never);

test("read: maps are plain, strictness refuses nil, duplicate keys, trailing bytes, other extensions", () => {
  const m = read(w({ a: 1, b: "x", c: [true] })) as Record<string, unknown>;
  assert.equal(m.a, 1);
  assert.equal(m.b, "x");
  assert.deepEqual(m.c, [true]);
  assert.throws(() => read(Uint8Array.of(0xc0)));
  assert.throws(() => read(Uint8Array.of(0x82, 0xa1, 0x61, 1, 0xa1, 0x61, 2)));
  assert.throws(() => read(Uint8Array.of(0x01, 0x02)));
  assert.throws(() => read(Uint8Array.of(0xd4, 0x05, 0x00)));
});

test("read: a length longer than the bytes left is refused before it allocates; depth is capped", () => {
  assert.throws(() => read(Uint8Array.of(0xdd, 0xff, 0xff, 0xff, 0xff)));
  assert.throws(() => read(Uint8Array.of(0xdf, 0xff, 0xff, 0xff, 0xff)));
  assert.throws(() => read(Uint8Array.of(0xc6, 0xff, 0xff, 0xff, 0xff)));
  assert.throws(() => read(Uint8Array.from({ length: 100 }, () => 0x91)));
  // An integer beyond 2^53-1 is refused.
  assert.throws(() => read(Uint8Array.of(0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)));
});

const ops = (...o: unknown[]) => w({ ops: o });
const bad = (b: Uint8Array) => {
  try {
    readDelta(b);
  } catch (e) {
    assert.ok(e instanceof DeltaError);
    return e;
  }
  assert.fail("expected EINVAL");
};

test("readDelta: a body is checked whole, and i names the first op that fails", () => {
  const good = readDelta(ops({ op: "text", t: "a", v: "x" }, { op: "morph", v: "<b></b>" }));
  assert.equal(good.length, 2);
  assert.equal(bad(ops({ op: "text", t: "a", v: "x" }, { op: "frob", t: "a" })).i, 1);
  assert.equal(bad(ops({ op: "text", v: "x" })).i, 0);
  assert.equal(bad(ops({ op: "attr", t: "a" })).i, 0);
  assert.equal(bad(ops({ op: "reveal", t: "a", v: "mid" })).i, 0);
  assert.equal(bad(ops()).code, "EINVAL");
  assert.equal(bad(w({ x: 1 })).code, "EINVAL");
  assert.equal(bad(Uint8Array.of(0xc1)).code, "EINVAL");
});

test("readMenu: items and label are read, a body that is no menu throws", () => {
  const m = readMenu(w({ label: "L", items: [{ key: "a", label: "A", name: "a" }, { key: "b", enabled: true, items: [] }] }));
  assert.deepEqual(m, {
    label: "L",
    items: [
      { key: "a", label: "A", name: "a", enabled: false, items: undefined },
      { key: "b", label: "", name: "", enabled: true, items: [] },
    ],
  });
  assert.deepEqual(readMenu(w({})), { label: "", items: [] });
  assert.throws(() => readMenu(w({ items: [1] })));
  assert.throws(() => readMenu(w({ label: 1 })));
  assert.throws(() => readMenu(Uint8Array.of(0x01)));
});
