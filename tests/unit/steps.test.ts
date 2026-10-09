// Steps (SPEC §9.1): what `data-steps` gives, and the step at a point of the
// dragged element's box. The browser's side, and the vectors, are in the e2e
// tests (drag.spec.ts, conformance.spec.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSteps, stepAt } from "../../src/steps.ts";

test("data-steps: one or two whole numbers from 0 up, 0 for none along that axis", () => {
  assert.deepEqual(parseSteps("20"), [20, 0]);
  assert.deepEqual(parseSteps("0 20"), [0, 20]);
  assert.deepEqual(parseSteps(" 8\t4 "), [8, 4]);
  assert.deepEqual(parseSteps("007"), [7, 0]);
});

test("data-steps: anything else gives no steps, and so does none along either axis", () => {
  for (const v of [null, "", " ", "2.5", "2.0", "-3", "+3", "1e3", "a", "1 2 3", "1,2", "0", "0 0", "99999999999999999999"]) {
    assert.equal(parseSteps(v), null, JSON.stringify(v));
  }
});

test("the step: the offset over the size, times the count, rounded to the nearest (a half up)", () => {
  assert.equal(stepAt(0, 80, 16), 0);
  assert.equal(stepAt(80, 80, 16), 16);
  assert.equal(stepAt(5, 80, 16), 1); // the centre of the first of 8 cells of 10 px
  assert.equal(stepAt(35, 80, 16), 7);
  assert.equal(stepAt(2.5, 80, 16), 1); // 0.5 rounds up
  assert.equal(stepAt(2.4, 80, 16), 0);
  assert.equal(stepAt(40, 80, 1), 1);
  assert.equal(stepAt(39, 80, 1), 0);
});

test("the step is clamped to 0 and the count, wherever the pointer is; a box with no size gives 0", () => {
  assert.equal(stepAt(-500, 80, 16), 0);
  assert.equal(stepAt(9000, 80, 16), 16);
  assert.equal(stepAt(10, 0, 16), 0);
  assert.equal(stepAt(-10, 0, 16), 0);
});

test("cell centres land on whole steps when a box n cells wide has 2n of them, at any cell width", () => {
  for (const w of [7, 8.4, 9, 9.6, 11.2, 16.8]) {
    for (let k = 0; k < 8; k++) assert.equal(stepAt((k + 0.5) * w, 8 * w, 16), 2 * k + 1, `${w} px, cell ${k}`);
  }
});
