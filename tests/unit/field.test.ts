// `a=field` (SPEC §6.4): its body, checked without the control, and the
// positions the wire counts in bytes of UTF-8. The control's side, and the
// vectors, are in the e2e tests (conformance.spec.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { byteAt, clusterStart, FieldError, readField, unitAt, wireSel } from "../../src/field.ts";
import { float, Writer, type Body } from "../../src/msgpack.ts";

const body = (b: Body) => new Writer().body(b).slice();

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof FieldError, String(e));
    return e.code;
  }
  return "ok";
};

test("a=field's body: rev and the fields given, in the table's types; one it does not have is ignored", () => {
  assert.deepEqual(readField(body({ rev: 3, value: "Ada" })), { rev: 3, value: "Ada" });
  assert.deepEqual(readField(body({ rev: 0, from: 1, to: 2, text: "é", sel: [0, 3] })), { rev: 0, from: 1, to: 2, text: "é", sel: [0, 3] });
  assert.deepEqual(readField(body({ rev: 1, text: "x" })), { rev: 1, text: "x" });
  assert.deepEqual(readField(body({ rev: 1, value: "", sel: [0, 0] })), { rev: 1, value: "", sel: [0, 0] });
  assert.deepEqual(readField(body({ rev: 2, checked: false, later: "x" })), { rev: 2, checked: false });
});

test("a=field's body is EINVAL where it is not such a map", () => {
  const bad: Body[] = [
    { value: "x" }, // no rev
    { rev: "1", value: "x" },
    { rev: float(1), value: "x" },
    { rev: 1 }, // no field but rev
    { rev: 1, value: 2 },
    { rev: 1, text: true },
    { rev: 1, from: 0, to: float(1), text: "" },
    { rev: 1, from: -1, to: 0, text: "" },
    { rev: 1, sel: [0] },
    { rev: 1, sel: [0, 1, 2] },
    { rev: 1, sel: [0, "1"] },
    { rev: 1, sel: [-1, 0] },
    { rev: 1, checked: 1 },
    { rev: 1, value: "x", text: "y" },
    { rev: 1, value: "x", from: 0, to: 0 },
    { rev: 1, from: 0, text: "y" }, // from without to
    { rev: 1, to: 0, text: "y" },
    { rev: 1, from: 0, to: 0 }, // without text
    { rev: 1, from: 2, to: 1, text: "y" },
  ];
  for (const b of bad) assert.equal(code(() => readField(body(b))), "EINVAL", JSON.stringify(b));
  for (const bytes of [new Uint8Array(), Uint8Array.of(0xc0), Uint8Array.of(0x93, 1, 2, 3), Uint8Array.of(0xa1, 0x78), Uint8Array.of(0xc1)]) {
    assert.equal(code(() => readField(bytes)), "EINVAL", String(bytes));
  }
});

test("positions: a byte of UTF-8 at a code point boundary is a code unit; past the end or inside a code point, none", () => {
  const s = "aé😀b"; // bytes 1 + 2 + 4 + 1, units 1 + 1 + 2 + 1
  assert.deepEqual([0, 1, 3, 7, 8].map((b) => unitAt(s, b)), [0, 1, 2, 4, 5]);
  assert.deepEqual([2, 4, 5, 6, 9].map((b) => unitAt(s, b)), [null, null, null, null, null]);
  assert.deepEqual([0, 1, 2, 4, 5].map((u) => byteAt(s, u)), [0, 1, 3, 7, 8]);
  assert.equal(unitAt("", 0), 0);
  assert.equal(unitAt("", 1), null);
  // A textarea's line break is one byte.
  assert.equal(byteAt("a\nb", 2), 2);
});

test("an end inside a character (a grapheme cluster) moves to its start", () => {
  const s = "aéb👍🏽"; // e + combining acute is one character, and so is the thumb with its tone
  assert.equal(clusterStart(s, 2), 1);
  assert.equal(clusterStart(s, 1), 1);
  assert.equal(clusterStart(s, 3), 3);
  assert.equal(clusterStart(s, 6), 4);
  assert.equal(clusterStart(s, s.length), s.length);
});

test("a selection goes out as its anchor, then its caret, in bytes", () => {
  assert.deepEqual(wireSel("héllo", { start: 1, end: 3, backward: false }), [1, 4]);
  assert.deepEqual(wireSel("héllo", { start: 1, end: 3, backward: true }), [4, 1]);
  assert.deepEqual(wireSel("héllo", { start: 5, end: 5, backward: false }), [6, 6]);
});
