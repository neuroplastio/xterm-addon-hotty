// Keys for the program (SPEC §10.2): every focused element has a keymap,
// and a key it binds to `program` is the program's before the element or
// the scrolling use it. The shared vectors' keymap section checks
// `elementKeymap` (conformance.test.ts), and the host vectors the browser
// (conformance.spec.ts); these check what they leave out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { elementKeymap, resolve } from "../../src/keys.ts";

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

// Scrolling keys (SPEC §10.2): outside a text field a key may be bound to a
// scroll action; a field's keymap leaves them out where they stand.

test("outside a text field, scroll gives the scroll action a key is bound to, with the fallback without Shift", () => {
  const m = elementKeymap("j=program Space=scroll-page-down G=scroll-end", "j=scroll-down");
  assert.equal(m.scroll("j"), "scroll-down");
  assert.equal(m.program("j"), false);
  assert.equal(m.scroll("Space"), "scroll-page-down");
  assert.equal(m.scroll("Shift+Space"), "scroll-page-down");
  assert.equal(m.scroll("G"), "scroll-end");
  // g is a key of its own, and program is not a scroll action.
  assert.equal(m.scroll("g"), null);
  assert.equal(elementKeymap("k=program").scroll("k"), null);
});

test("a text field's keymap leaves scroll actions out, in the same value too", () => {
  const m = resolve(true, "k=program", "j=scroll-down k=scroll-up PageDown=scroll-page-down Control+d=delete-char-forward Control+d=scroll-half-page-down");
  assert.equal(m.lookup("j"), "insert");
  assert.equal(m.lookup("k"), null);
  assert.equal(m.program("k"), true);
  assert.equal(m.lookup("PageDown"), "page-down");
  assert.equal(m.lookup("Control+d"), "delete-char-forward");
  assert.equal(m.scroll("j"), null);
});
