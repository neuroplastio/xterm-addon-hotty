import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeKey } from "../../src/keys.ts";

const k = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) => ({
  key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});

test("printable keys, control and alt", () => {
  assert.equal(encodeKey(k("q"), false), "q");
  assert.equal(encodeKey(k("c", { ctrlKey: true }), false), "\x03");
  assert.equal(encodeKey(k("x", { altKey: true }), false), "\x1bx");
  assert.equal(encodeKey(k("Shift"), false), null);
});

test("cursor keys follow DECCKM, modified keys use CSI 1;m", () => {
  assert.equal(encodeKey(k("ArrowUp"), false), "\x1b[A");
  assert.equal(encodeKey(k("ArrowUp"), true), "\x1bOA");
  assert.equal(encodeKey(k("ArrowLeft", { ctrlKey: true }), true), "\x1b[1;5D");
});

test("editing and function keys", () => {
  assert.equal(encodeKey(k("Enter"), false), "\r");
  assert.equal(encodeKey(k("Backspace"), false), "\x7f");
  assert.equal(encodeKey(k("Escape"), false), "\x1b");
  assert.equal(encodeKey(k("Tab", { shiftKey: true }), false), "\x1b[Z");
  assert.equal(encodeKey(k("Delete"), false), "\x1b[3~");
  assert.equal(encodeKey(k("F1"), false), "\x1bOP");
  assert.equal(encodeKey(k("F5"), false), "\x1b[15~");
});
