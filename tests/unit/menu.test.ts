// The program's menu (SPEC §10.7): the tree, the level a sequence reaches,
// the entries a page's own palette lists, and a menu kept for each screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writer } from "../../src/msgpack.ts";
import { readKey } from "../../src/keys.ts";
import { entries, find, hides, isGroup, type Menu, Menus, MENU_DEPTH, reach, readMenu, readSeq, shownLevel } from "../../src/menu.ts";

const w = (b: unknown) => new Writer().body(b as never);
const platform = { mod: "ctrl" } as const;
const read = (k: string) => readKey(platform, k);
const show = (k: string) => read(k) ?? k;

const menu: Menu = readMenu(
  w({
    label: "Files",
    items: [
      { key: "mod+x", label: "Leader", enabled: true, items: [
        { key: "f", label: "File", enabled: true, items: [
          { key: "n", label: "New file", name: "file-new", enabled: true },
          { key: "r", label: "Rename", name: "file-rename", enabled: false },
        ] },
        { key: "q", label: "Quit", name: "quit", enabled: true },
      ] },
      { label: "Reload", name: "reload", enabled: true },
      { key: "z", label: "Again", name: "quit", enabled: true },
    ],
  }),
);

test("reach: the first group each key names, mod read as the host's mod", () => {
  assert.equal(reach(menu, [], read)!.label, "Files");
  assert.deepEqual(reach(menu, ["ctrl+x", "f"], read)!.items.map((i) => i.key), ["n", "r"]);
  assert.equal(reach(menu, ["mod+x"], read)!.label, "Leader");
  assert.equal(reach(menu, ["ctrl+x", "q"], read), null, "q is no group");
  assert.equal(reach(menu, ["x"], read), null);
});

test("a group has an item: an empty items is none, and keys walking into it reach no group", () => {
  const m = readMenu(w({ items: [{ key: "g", label: "G", items: [] }, { key: "h", label: "H", items: [{ key: "x", label: "X" }] }] }));
  assert.equal(isGroup(m.items[0]!), false);
  assert.equal(isGroup(m.items[1]!), true);
  assert.equal(reach(m, ["g"], read), null);
  assert.equal(reach(m, ["h"], read)!.items.length, 1);
});

test("shownLevel: the keyed items only, null when none has a key or the keys reach no group", () => {
  assert.deepEqual(shownLevel(menu, [], read)!.items.map((i) => i.key), ["mod+x", "z"]);
  assert.equal(shownLevel(readMenu(w({ items: [{ label: "A", name: "a" }] })), [], read), null);
  assert.equal(shownLevel(menu, ["nope"], read), null);
});

test("hides: Escape and a key the level does not list", () => {
  const level = shownLevel(menu, [], read)!.items;
  assert.equal(hides(level, "Escape", read), true);
  assert.equal(hides(level, "q", read), true);
  assert.equal(hides(level, "z", read), false);
  assert.equal(hides([], "z", read), true, "a level that shows nothing lists no key");
  assert.equal(hides([], "Escape", read), true);
  assert.equal(hides(level, "ctrl+x", read), false);
  // A press has two names, and the level lists it if it lists either.
  assert.equal(hides(level, ["key_z", "z"], read), false);
  assert.equal(hides(level, ["key_q", "q"], read), true);
  assert.equal(hides(level, ["escape"], read), true);
  assert.equal(hides(level, [], read), true);
});

test("find: the first item of a name in depth-first order, an empty name none", () => {
  assert.equal(find(menu, "quit")!.label, "Quit");
  assert.equal(find(menu, "reload")!.key, "");
  assert.equal(find(menu, "nothing"), null);
  assert.equal(find(menu, ""), null);
});

test("nesting: eight deep is a menu, nine is not; a field of another type or a body that is no map throws", () => {
  const deep = (n: number): unknown => (n === 0 ? undefined : { key: "a", enabled: true, items: n === 1 ? [] : [deep(n - 1)] });
  assert.doesNotThrow(() => readMenu(w({ items: [deep(MENU_DEPTH)] })));
  assert.throws(() => readMenu(w({ items: [deep(MENU_DEPTH + 1)] })), /nests/);
  assert.throws(() => readMenu(w({ items: [{ key: 5 }] })));
  assert.throws(() => readMenu(w({ items: [{ enabled: "no" }] })));
  assert.throws(() => readMenu(w({ items: [{ items: {} }] })));
  assert.throws(() => readMenu(w(["Space"])));
});

test("readSeq: none is the top, anything but an array of str throws", () => {
  assert.deepEqual(readSeq(new Uint8Array()), []);
  assert.deepEqual(readSeq(w({ seq: ["Space", "f"] })), ["Space", "f"]);
  assert.throws(() => readSeq(w({ seq: "Space" })));
  assert.throws(() => readSeq(w({ seq: [1] })));
});

test("entries: named items depth-first under their groups, with the keys that reach them", () => {
  assert.deepEqual(entries(menu, show), [
    { name: "file-new", label: "Leader › File › New file", keys: "ctrl+x f n", enabled: true },
    { name: "file-rename", label: "Leader › File › Rename", keys: "ctrl+x f r", enabled: false },
    { name: "quit", label: "Leader › Quit", keys: "ctrl+x q", enabled: true },
    { name: "reload", label: "Reload", keys: "", enabled: true },
    { name: "quit", label: "Again", keys: "z", enabled: true },
  ]);
  assert.equal(entries(readMenu(w({ items: [{ name: "go" }] })), show)[0]!.label, "go", "the name stands in for a label");
  const unkeyed = readMenu(w({ items: [{ label: "G", items: [{ key: "a", label: "A", name: "a", enabled: true }] }] }));
  assert.deepEqual(entries(unkeyed, show), [{ name: "a", label: "G › A", keys: "", enabled: true }], "no keys where a group on its path has none");
});

test("Menus: one for each screen; leaving the alternate drops its menu, the main one stays", () => {
  const m = new Menus();
  m.set("normal", menu);
  m.set("alternate", readMenu(w({ label: "Alt" })));
  m.change("alternate");
  assert.equal(m.get("alternate")!.label, "Alt");
  assert.equal(m.get("normal"), menu);
  m.change("normal");
  assert.equal(m.get("alternate"), null);
  assert.equal(m.get("normal"), menu);
  m.set("alternate", menu);
  m.clear();
  assert.equal(m.get("normal"), null);
  assert.equal(m.get("alternate"), null);
});
