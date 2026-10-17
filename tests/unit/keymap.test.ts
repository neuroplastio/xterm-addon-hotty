// Keys for the program (SPEC §10.2): every focused element has a keymap,
// and a key it binds to `program` is the program's before the element or
// the scrolling use it. The shared vectors' keymap section checks
// `elementKeymap` (conformance.test.ts), and the host vectors the browser
// (conformance.spec.ts); these check what they leave out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayKey, elementKeymap, type Press, pressNames, resolve, Taps } from "../../src/keys.ts";

test("a key with Shift that is not bound is looked up again without it; a binding with Shift wins", () => {
  const m = elementKeymap({}, "arrow_down=program a=program", "shift+arrow_up=program arrow_up=line-start");
  assert.equal(m.program("shift+arrow_down"), true);
  assert.equal(m.program("shift+arrow_up"), true);
  assert.equal(m.program("arrow_up"), false);
  // shift+a is a key of its own: a character with shift is not looked up
  // without it.
  assert.equal(m.program("a"), true);
  assert.equal(m.program("shift+a"), false);
  // Other modifiers are not dropped.
  assert.equal(m.program("ctrl+arrow_down"), false);
});

test("a binding with an unknown action does not cancel program, and Escape and Tab cannot be given to it", () => {
  const m = elementKeymap({}, "arrow_down=program escape=program tab=program", "arrow_down=frobnicate");
  assert.equal(m.program("arrow_down"), true);
  assert.equal(m.program("escape"), false);
  assert.equal(m.program("tab"), false);
  assert.equal(m.program("shift+tab"), false);
});

test("in a text field a key bound to program is not the field's, and is the program's", () => {
  const m = resolve({}, false, "arrow_left=program", "shift+arrow_right=program");
  assert.equal(m.lookup("arrow_left"), null);
  assert.equal(m.program("arrow_left"), true);
  assert.equal(m.program("shift+arrow_left"), true);
  assert.equal(m.program("shift+arrow_right"), true);
  // A key the field does not use (a multi-line action in an input) is not
  // the program's first: the document may still scroll with it.
  assert.equal(m.lookup("arrow_down"), null);
  assert.equal(m.program("arrow_down"), false);
  assert.equal(m.lookup("x"), "insert");
});

// Scrolling keys (SPEC §10.2): outside a text field a key may be bound to a
// scroll action; a field's keymap leaves them out where they stand.

test("outside a text field, scroll gives the scroll action a key is bound to, with the fallback without Shift", () => {
  const m = elementKeymap({}, "j=program space=scroll-page-down shift+g=scroll-end", "j=scroll-down");
  assert.equal(m.scroll("j"), "scroll-down");
  assert.equal(m.program("j"), false);
  assert.equal(m.scroll("space"), "scroll-page-down");
  assert.equal(m.scroll("shift+space"), "scroll-page-down");
  assert.equal(m.scroll("shift+g"), "scroll-end");
  // g is a key of its own, and program is not a scroll action.
  assert.equal(m.scroll("g"), null);
  assert.equal(elementKeymap({}, "k=program").scroll("k"), null);
});

test("a text field's keymap leaves scroll actions out, in the same value too", () => {
  const m = resolve({}, true, "k=program", "j=scroll-down k=scroll-up page_down=scroll-page-down ctrl+d=delete-char-forward ctrl+d=scroll-half-page-down");
  assert.equal(m.lookup("j"), "insert");
  assert.equal(m.lookup("k"), null);
  assert.equal(m.program("k"), true);
  assert.equal(m.lookup("page_down"), "page-down");
  assert.equal(m.lookup("ctrl+d"), "delete-char-forward");
  assert.equal(m.scroll("j"), null);
});

test("a key bound to prefix is the program's and begins a prefix; a text field's lookup gives it up", () => {
  const m = resolve({}, false, "g=prefix", "arrow_left=program");
  assert.equal(m.prefix("g"), true);
  assert.equal(m.program("g"), true);
  assert.equal(m.lookup("g"), null);
  assert.equal(m.prefix("arrow_left"), false);
  assert.equal(m.program("arrow_left"), true);
  assert.equal(m.prefix("x"), false);
});

// A press has two names (SPEC §10.4): the physical key, then the character.

test("pressNames: the physical key and the character, with the modifiers held", () => {
  const press = (key: string, code: string, o: Partial<Press> = {}): Press => ({ key, code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  assert.deepEqual(pressNames(press("w", "KeyW", { ctrlKey: true })), ["ctrl+key_w", "ctrl+w"]);
  assert.deepEqual(pressNames(press("W", "KeyW", { ctrlKey: true, shiftKey: true })), ["ctrl+shift+key_w", "ctrl+shift+w"]);
  assert.deepEqual(pressNames(press("ArrowLeft", "ArrowLeft", { metaKey: true })), ["super+arrow_left"]);
  assert.deepEqual(pressNames(press("?", "Slash", { shiftKey: true })), ["shift+slash", "?"]);
  assert.deepEqual(pressNames(press("1", "Digit1", { shiftKey: true })), ["shift+digit_1", "1"]);
  assert.deepEqual(pressNames(press(" ", "Space")), ["space"]);
  assert.deepEqual(pressNames(press("F12", "F12")), ["f12"]);
  assert.deepEqual(pressNames(press("Shift", "ShiftLeft", { shiftKey: true })), []);
  assert.deepEqual(pressNames(press("Dead", "KeyE")), []);
});

test("Taps: a modifier released with no key since its press is a modifier key, sided by its code", () => {
  const ev = (type: string, code: string, key: string, o: Partial<Press> = {}) => ({ type, code, key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...o });
  const t = new Taps();
  assert.deepEqual(t.feed(ev("keydown", "ShiftLeft", "Shift", { shiftKey: true })), []);
  assert.deepEqual(t.feed(ev("keyup", "ShiftLeft", "Shift")), ["shift_left", "shift"]);
  // A chord is no tap.
  t.feed(ev("keydown", "ShiftLeft", "Shift", { shiftKey: true }));
  t.feed(ev("keydown", "KeyG", "G", { shiftKey: true }));
  t.feed(ev("keyup", "KeyG", "G", { shiftKey: true }));
  assert.deepEqual(t.feed(ev("keyup", "ShiftLeft", "Shift")), []);
  // Shift tapped while Control is held; Control, with Shift pressed since, is not a tap.
  t.feed(ev("keydown", "ControlLeft", "Control", { ctrlKey: true }));
  t.feed(ev("keydown", "ShiftRight", "Shift", { ctrlKey: true, shiftKey: true }));
  assert.deepEqual(t.feed(ev("keyup", "ShiftRight", "Shift", { ctrlKey: true })), ["ctrl+shift_right", "ctrl+shift"]);
  assert.deepEqual(t.feed(ev("keyup", "ControlLeft", "Control")), []);
  t.feed(ev("keydown", "MetaLeft", "Meta", { metaKey: true }));
  assert.deepEqual(t.feed(ev("keyup", "MetaLeft", "Meta")), ["meta_left", "super"]);
});

test("displayKey: canonical, but for the arrows, tab and shift+tab (myelin key names §6)", () => {
  const shown: Record<string, string> = { arrow_left: "←", "ctrl+arrow_left": "ctrl+←", "shift+arrow_up": "shift+↑", tab: "⇥", "shift+tab": "⇧⇥", "ctrl+shift+tab": "ctrl+⇧⇥", "ctrl+shift+a": "ctrl+shift+a", escape: "escape", page_down: "page_down", "shift+g": "shift+g", "super+x": "super+x", "+": "+", shift: "shift" };
  for (const [k, want] of Object.entries(shown)) assert.equal(displayKey(k), want, k);
});
