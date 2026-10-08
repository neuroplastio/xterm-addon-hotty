// The shared vectors' wire, keys, keymap and edit sections
// (conformance/README.md) against this addon's code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOTTY_DIR } from "../hotty.ts";
import { Assembler, text, type Command } from "../../src/wire.ts";
import { decodeKeys, Field, parseKey, parseKeymap, resolve, TERMINAL_KEYS } from "../../src/keys.ts";

const vectors = JSON.parse(readFileSync(join(HOTTY_DIR, "conformance", "vectors.json"), "utf8"));

for (const w of vectors.wire) {
  test(`wire: ${w.name}`, async () => {
    const a = new Assembler();
    const commands: Command[] = [];
    let invalid = 0;
    for (const m of (w.stream as string).matchAll(/\x1b\]7279;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      for (const d of await a.feed(m[1]!)) {
        if (d.kind === "command") commands.push(d.command);
        if (d.kind === "invalid") invalid++;
      }
    }
    assert.equal(commands.length, w.commands.length);
    assert.equal(invalid, w.invalid);
    commands.forEach((c, i) => {
      const want = w.commands[i];
      for (const [k, v] of Object.entries(want.control)) assert.equal(c.control.get(k), v, k);
      assert.equal(c.control.get("m"), undefined);
      assert.equal(c.control.get("o"), undefined);
      assert.equal(text(c.payload), want.payload);
    });
  });
}

// What a text field does with a key (SPEC §10.2, §10.4; SDK.md §3.10,
// §4.6): the code the surfaces use.

for (const v of vectors.keys) {
  test(`keys: ${v.name}`, () => {
    if ("input" in v) assert.deepEqual(decodeKeys(v.input), v.keys);
    else assert.equal(parseKey(v.key), v.canon);
  });
}

for (const v of vectors.keymap) {
  test(`keymap: ${v.name}`, () => {
    if (!("lookup" in v)) {
      assert.equal(parseKeymap(v.parse ?? TERMINAL_KEYS).format(), v.format);
      return;
    }
    const m = resolve(v.multiline, ...(v.terminal_keys ? [TERMINAL_KEYS] : []), ...v.keys);
    for (const [key, want] of Object.entries(v.lookup)) assert.equal(m.lookup(key), want, key);
  });
}

for (const v of vectors.edit) {
  test(`edit: ${v.name}`, () => {
    const f = v.field;
    const field = new Field(f.value, f.caret, f.multiline ?? false, f.password ?? false, f.rows ?? 1);
    v.steps.forEach((st: Record<string, unknown>, i: number) => {
      const changed = "do" in st ? field.do(st.do as string) : field.type(st.type as string);
      const where = `step ${i} (${String(st.do ?? st.type)})`;
      if ("value" in st) assert.equal(field.value, st.value, `${where}: value`);
      if ("caret" in st) assert.equal(field.caret, st.caret, `${where}: caret`);
      if ("changed" in st) assert.equal(changed, st.changed, `${where}: changed`);
    });
  });
}
