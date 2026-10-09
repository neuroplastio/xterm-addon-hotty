// Touch drags (SPEC §9.1): which pans a touch-action value allows, and how a
// Touch hands a drag its host claims to the host, from the move that claims
// it to the lift, or to a second finger. The browser's side, and the vectors,
// are in the e2e tests (drag.spec.ts, conformance.spec.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { panBlocked, Touch, touchPans, type TouchBegin, type TouchHost } from "../../src/touch.ts";

test("touch-action: auto and manipulation allow both pans, a pan- keyword its axis, anything else neither", () => {
  assert.deepEqual(touchPans("auto"), [true, true]);
  assert.deepEqual(touchPans("manipulation"), [true, true]);
  assert.deepEqual(touchPans("pan-x"), [true, false]);
  assert.deepEqual(touchPans("pan-left pinch-zoom"), [true, false]);
  assert.deepEqual(touchPans("pan-y"), [false, true]);
  assert.deepEqual(touchPans("pan-up"), [false, true]);
  assert.deepEqual(touchPans("pan-x pan-y"), [true, true]);
  assert.deepEqual(touchPans("none"), [false, false]);
  assert.deepEqual(touchPans("pinch-zoom"), [false, false]);
});

test("a touch drags when its first move goes the way its touch-action allows no pan: the larger delta, a tie a pan", () => {
  const panX = { x: true, y: false }, panY = { x: false, y: true }, none = { x: false, y: false }, auto = { x: true, y: true };
  assert.equal(panBlocked(panX, 2, 9), true);
  assert.equal(panBlocked(panX, -9, 2), false);
  assert.equal(panBlocked(panY, 9, -2), true);
  assert.equal(panBlocked(panY, 2, 9), false);
  assert.equal(panBlocked(none, 9, 0), true);
  assert.equal(panBlocked(none, 0, -9), true);
  assert.equal(panBlocked(auto, 9, 0), false);
  assert.equal(panBlocked(auto, 0, 9), false);
  // A diagonal is a pan, whatever the touch-action.
  assert.equal(panBlocked(none, 6, 6), false);
  assert.equal(panBlocked(panX, -6, 6), false);
});

/** A touch event as a Touch reads it. */
function touchEvent(type: string, points: { id: number; x: number; y: number }[], changed = points, time = 0): Event {
  const e = new Event(type, { cancelable: true });
  const list = (ps: typeof points) => ps.map((p) => ({ identifier: p.id, clientX: p.x, clientY: p.y }));
  Object.defineProperty(e, "touches", { value: type === "touchend" ? [] : list(points) });
  Object.defineProperty(e, "changedTouches", { value: list(changed) });
  Object.defineProperty(e, "timeStamp", { value: time });
  for (const k of ["shiftKey", "ctrlKey", "altKey", "metaKey"]) Object.defineProperty(e, k, { value: false });
  return e;
}

/** A Touch on a fake document whose host claims a drag that goes across,
 * and records what it hears. */
function setup() {
  const target = new EventTarget();
  const heard: string[] = [];
  const win = { performance: { now: () => 0 }, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} } as unknown as Window;
  const host: TouchHost = {
    toPage: (x, y) => [x, y],
    scroll: (dx, dy) => heard.push(`scroll ${dx},${dy}`),
    claim: (dx, dy, _e, begin: TouchBegin) => {
      heard.push(`claim at ${begin.x},${begin.y}`);
      return Math.abs(dx) > Math.abs(dy) ? "drag" : true;
    },
    dragMove: (x, y) => heard.push(`move ${x},${y}`),
    dragEnd: (x, y) => heard.push(`end ${x},${y}`),
    dragCancel: () => heard.push("cancel"),
  };
  new Touch(target, win, host);
  const fire = (e: Event) => (target.dispatchEvent(e), e);
  return { heard, fire };
}

test("a drag the host claims gets every move and the lift, never a scroll, and the browser none of them", () => {
  const { heard, fire } = setup();
  fire(touchEvent("touchstart", [{ id: 1, x: 10, y: 10 }]));
  // Within the slop: nothing yet.
  assert.equal(fire(touchEvent("touchmove", [{ id: 1, x: 14, y: 10 }], undefined, 10)).defaultPrevented, false);
  const claimed = fire(touchEvent("touchmove", [{ id: 1, x: 30, y: 12 }], undefined, 20));
  assert.equal(claimed.defaultPrevented, true);
  assert.equal(fire(touchEvent("touchmove", [{ id: 1, x: 40, y: 15 }], undefined, 30)).defaultPrevented, true);
  const lift = fire(touchEvent("touchend", [], [{ id: 1, x: 42, y: 15 }], 40));
  assert.equal(lift.defaultPrevented, true);
  assert.deepEqual(heard, ["claim at 10,10", "move 40,15", "end 42,15"]);
});

test("a second finger cancels a claimed drag, and nothing more of the gesture reaches the host", () => {
  const { heard, fire } = setup();
  fire(touchEvent("touchstart", [{ id: 1, x: 10, y: 10 }]));
  fire(touchEvent("touchmove", [{ id: 1, x: 30, y: 10 }]));
  fire(touchEvent("touchstart", [{ id: 1, x: 30, y: 10 }, { id: 2, x: 80, y: 10 }], [{ id: 2, x: 80, y: 10 }]));
  fire(touchEvent("touchmove", [{ id: 1, x: 40, y: 10 }, { id: 2, x: 90, y: 10 }]));
  fire(touchEvent("touchend", [], [{ id: 1, x: 40, y: 10 }]));
  assert.deepEqual(heard, ["claim at 10,10", "cancel"]);
});

test("a drag the host claims as a pan scrolls, as before", () => {
  const { heard, fire } = setup();
  fire(touchEvent("touchstart", [{ id: 1, x: 10, y: 10 }]));
  fire(touchEvent("touchmove", [{ id: 1, x: 10, y: 30 }], undefined, 10));
  assert.deepEqual(heard, ["claim at 10,10", "scroll 0,-20"]);
});
