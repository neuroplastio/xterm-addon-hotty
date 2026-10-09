// Keys for the program (SPEC §10.2): every focused element has a keymap,
// and a key it binds to `program` is the program's before the element or
// the scrolling use it. The shared vectors check it in the browser
// (conformance.spec.ts); these check the keymap the surface reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { elementKeymap, resolve } from "../../src/keys.ts";

test("outside a text field the keymap is the data-keys alone, root first, and only program counts", () => {
  const m = elementKeymap("ArrowDown=program End=program", "End=line-end");
  assert.equal(m.program("ArrowDown"), true);
  // A nearer binding to another action cancels the farther one to program.
  assert.equal(m.program("End"), false);
  assert.equal(m.action("End"), "line-end");
  // No default keymap: nothing else is bound.
  assert.equal(m.action("ArrowUp"), undefined);
  assert.equal(m.program("ArrowUp"), false);
  assert.equal(elementKeymap().program("ArrowDown"), false);
});

test("a key with Shift that is not bound is looked up again without it; a binding with Shift wins", () => {
  const m = elementKeymap("ArrowDown=program a=program", "Shift+ArrowUp=program ArrowUp=line-start");
  assert.equal(m.program("Shift+ArrowDown"), true);
  assert.equal(m.program("Shift+ArrowUp"), true);
  assert.equal(m.program("ArrowUp"), false);
  // Shift+a is A, a key of its own.
  assert.equal(m.program("a"), true);
  assert.equal(m.program("A"), false);
  // Other modifiers are not dropped.
  assert.equal(m.program("Control+ArrowDown"), false);
});

test("a binding with an unknown action does not cancel program, and Escape and Tab cannot be given to it", () => {
  const m = elementKeymap("ArrowDown=program Escape=program Tab=program", "ArrowDown=frobnicate");
  assert.equal(m.program("ArrowDown"), true);
  assert.equal(m.program("Escape"), false);
  assert.equal(m.program("Tab"), false);
  assert.equal(m.program("Shift+Tab"), false);
});

test("in a text field a key bound to program is not the field's, and is the program's", () => {
  const m = resolve(false, "ArrowLeft=program", "Shift+ArrowRight=program");
  assert.equal(m.lookup("ArrowLeft"), null);
  assert.equal(m.program("ArrowLeft"), true);
  assert.equal(m.program("Shift+ArrowLeft"), true);
  assert.equal(m.program("Shift+ArrowRight"), true);
  // A key the field does not use (a multi-line action in an input) is not
  // the program's first: the document may still scroll with it.
  assert.equal(m.lookup("ArrowDown"), null);
  assert.equal(m.program("ArrowDown"), false);
  assert.equal(m.lookup("x"), "insert");
});
