// The shared vectors' wire, keys, keymap and edit sections, and the menu
// steps of the protocol ones
// (conformance/README.md) against this addon's code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readVectors } from "../hotty.ts";
import { Assembler, text, type Command } from "../../src/wire.ts";
import { Writer, type Body } from "../../src/msgpack.ts";
import { find, hides, isGroup, Menus, readMenu, readSeq, shownLevel } from "../../src/menu.ts";
import { decodeKeys, elementKeymap, Field, parseKey, parseKeymap, resolve, TERMINAL_KEYS } from "../../src/keys.ts";

const vectors = readVectors();

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
    if ("program" in v || "prefix" in v || "scroll" in v) {
      // An element's keymap outside a text field: no default; program,
      // prefix and the scroll actions.
      const m = elementKeymap(v.platform ?? {}, ...v.keys);
      for (const [key, want] of Object.entries(v.program ?? {})) assert.equal(m.program(key), want, key);
      for (const [key, want] of Object.entries(v.prefix ?? {})) assert.equal(m.prefix(key), want, key);
      for (const [key, want] of Object.entries(v.scroll ?? {})) assert.equal(m.scroll(key), want, key);
      return;
    }
    if (!("lookup" in v)) {
      assert.equal(parseKeymap(v.platform ?? {}, v.parse ?? TERMINAL_KEYS).format(), v.format);
      return;
    }
    const m = resolve(v.platform ?? {}, v.multiline, ...(v.terminal_keys ? [TERMINAL_KEYS] : []), ...v.keys);
    for (const [key, want] of Object.entries(v.lookup)) assert.equal(m.lookup(key), want, key);
    for (const [key, want] of Object.entries(v.selects ?? {})) assert.equal(m.selects(key), want, `${key}: selects`);
  });
}

for (const v of vectors.edit) {
  test(`edit: ${v.name}`, () => {
    const f = v.field;
    const field = new Field(f.value, f.caret, f.multiline ?? false, f.password ?? false, f.rows ?? 1, f.anchor);
    v.steps.forEach((st: Record<string, unknown>, i: number) => {
      let changed = false;
      if ("do" in st) changed = field.do(st.do as string);
      else if ("extend" in st) changed = field.extend(st.extend as string);
      else if ("select" in st) field.select(...(st.select as [number, number]));
      else changed = field.type(st.type as string);
      const where = `step ${i} (${String(st.do ?? st.extend ?? st.select ?? st.type)})`;
      if ("value" in st) assert.equal(field.value, st.value, `${where}: value`);
      if ("caret" in st) assert.equal(field.caret, st.caret, `${where}: caret`);
      // Nothing selected is an anchor at the caret (conformance/README.md).
      if ("anchor" in st) assert.equal(field.anchor ?? field.caret, st.anchor, `${where}: anchor`);
      if ("changed" in st) assert.equal(changed, st.changed, `${where}: changed`);
    });
  });
}

// The menu steps (conformance/README.md) of the protocol vectors, against the
// menu code alone: the browser runner (tests/e2e/conformance.spec.ts) runs
// the vectors whole, these steps through the addon.

type MenuStep = { send?: Record<string, string>; body?: unknown; reply?: Record<string, string>; key?: string; menu?: "shown" | "pick"; expect?: unknown; name?: string; events?: unknown[] };
const readKey = (k: string) => parseKey(k.replace(/^Mod/, "Control"));

for (const v of (vectors.vectors as { name: string; requires?: string | string[]; steps: MenuStep[] }[]).filter((v) => [v.requires ?? []].flat().includes("menu"))) {
  test(`menu: ${v.name}`, () => {
    const menus = new Menus();
    let seq: string[] | null = null;
    v.steps.forEach((st, i) => {
      const where = `step ${i + 1}`;
      if (st.send) {
        let code: string | undefined;
        try {
          if (st.send.show !== undefined && st.send.show !== "0" && st.send.show !== "1") throw new Error("show is 0 or 1");
          const bytes = st.body === undefined ? new Uint8Array() : new Writer().body(st.body as Body);
          if (st.send.show === "1") seq = readSeq(bytes);
          else if (st.send.show === "0") seq = null;
          else menus.set("normal", bytes.length ? readMenu(bytes) : null);
        } catch {
          code = "EINVAL";
        }
        if (st.reply) assert.equal(st.reply.code, code, `${where}: code`);
      } else if (st.key !== undefined) {
        const m = menus.get("normal");
        const level = m && seq && shownLevel(m, seq, readKey);
        if (seq && hides(level ? level.items : [], st.key, readKey)) seq = null;
      } else if (st.menu === "shown") {
        const m = menus.get("normal");
        const level = m && seq ? shownLevel(m, seq, readKey) : null;
        const got = level && level.items.map((i) => ({ key: i.key, label: i.label, group: isGroup(i), enabled: i.enabled }));
        assert.deepEqual(got, st.expect, `${where}: shown`);
      } else if (st.menu === "pick") {
        const m = menus.get("normal");
        const item = m && find(m, st.name!);
        const got = item?.enabled ? [{ e: "command", s: null, t: null, detail: { name: item.name } }] : [];
        assert.deepEqual(got, st.events, `${where}: events`);
      }
    });
  });
}
