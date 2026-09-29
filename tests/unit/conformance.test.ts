// The shared wire vectors (conformance/README.md) against this addon's decoder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOTTY_DIR } from "../hotty.ts";
import { Assembler, text, type Command } from "../../src/wire.ts";

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
