// Touch drags (SPEC §9.1): which pans a touch-action value allows, and how a
// Touch hands a drag its host claims to the host, from the move that claims
// it to the lift, or to a second finger. Touch in the cells (§9.6): the
// areas a program names, which decides at a cell, and which way each drags.
// The browser's side, and the vectors, are in the e2e tests (drag.spec.ts,
// touch.spec.ts, conformance.spec.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { float, Writer } from "../../src/msgpack.ts";
import { areaAt, areaDrags, MAX_TOUCH_AREAS, panBlocked, readTouchAreas, Touch, type TouchArea, touchPans, type TouchBegin, type TouchHost } from "../../src/touch.ts";

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

// --- Touch in the cells (SPEC §9.6) ---------------------------------------

const body = (b: unknown) => new Writer().body(b as never);
const area = (c: number, r: number, w: number, h: number, drag: string) => ({ c, r, w, h, drag });

test("a=touch's body is a map of areas, each with c, r, w, h and drag; no body is none", () => {
  assert.deepEqual(readTouchAreas(new Uint8Array()), []);
  assert.deepEqual(readTouchAreas(body({ areas: [] })), []);
  const got = readTouchAreas(body({ areas: [area(2, 3, 10, 1, "x"), area(0, 0, 1, 1, "y"), area(5, 5, 2, 2, "xy")], more: 1 }));
  assert.deepEqual(got, [
    { c: 2, r: 3, w: 10, h: 1, x: true, y: false },
    { c: 0, r: 0, w: 1, h: 1, x: false, y: true },
    { c: 5, r: 5, w: 2, h: 2, x: true, y: true },
  ]);
  // A field it does not know, in the body or an area, is left alone.
  assert.equal(readTouchAreas(body({ areas: [{ ...area(0, 0, 1, 1, "x"), z: "z" }] })).length, 1);
  // Past the screen's edge is not wrong: it covers what of it is there.
  assert.equal(readTouchAreas(body({ areas: [area(9000, 9000, 9000, 9000, "x")] })).length, 1);
});

test("a=touch's body is EINVAL where it is no such map, or names more than 256 areas", () => {
  const bad: unknown[] = [
    ["x"],
    {},
    { areas: { c: 0 } },
    { areas: ["x"] },
    { areas: [{ c: 0, r: 0, w: 1, drag: "x" }] },
    { areas: [{ ...area(0, 0, 1, 1, "x"), c: float(1) }] },
    { areas: [{ ...area(0, 0, 1, 1, "x"), w: "1" }] },
    { areas: [area(0, 0, 1, 1, 1 as unknown as string)] },
    { areas: [area(-1, 0, 1, 1, "x")] },
    { areas: [area(0, -1, 1, 1, "x")] },
    { areas: [area(0, 0, 0, 1, "x")] },
    { areas: [area(0, 0, 1, 0, "x")] },
    { areas: [area(0, 0, 1, 1, "yx")] },
    { areas: [area(0, 0, 1, 1, "")] },
    { areas: Array.from({ length: MAX_TOUCH_AREAS + 1 }, (_, i) => area(i, 0, 1, 1, "x")) },
  ];
  for (const b of bad) assert.throws(() => readTouchAreas(body(b)), `${JSON.stringify(b)}`);
  assert.equal(readTouchAreas(body({ areas: Array.from({ length: MAX_TOUCH_AREAS }, (_, i) => area(i, 0, 1, 1, "x")) })).length, MAX_TOUCH_AREAS);
  // A body that does not decode: bytes after the map, a nil.
  const map = body({ areas: [] });
  assert.throws(() => readTouchAreas(new Uint8Array([...map, 0])));
  assert.throws(() => readTouchAreas(new Uint8Array([0x81, 0xa5, ...new TextEncoder().encode("areas"), 0xc0])));
});

test("at a cell, the last listed area that covers it decides", () => {
  const areas: TouchArea[] = readTouchAreas(body({ areas: [area(0, 0, 20, 4, "y"), area(5, 1, 5, 1, "x")] }));
  assert.equal(areaAt(areas, 6, 1), areas[1]);
  assert.equal(areaAt(areas, 9, 1), areas[1]);
  assert.equal(areaAt(areas, 10, 1), areas[0]);
  assert.equal(areaAt(areas, 4, 1), areas[0]);
  assert.equal(areaAt(areas, 19, 3), areas[0]);
  assert.equal(areaAt(areas, 20, 3), null);
  assert.equal(areaAt(areas, 0, 4), null);
  assert.equal(areaAt([], 0, 0), null);
});

test("a touch drags in an area when its first move goes a way the area drags: the larger delta, a tie a pan", () => {
  const [x, y, xy] = readTouchAreas(body({ areas: [area(0, 0, 1, 1, "x"), area(0, 0, 1, 1, "y"), area(0, 0, 1, 1, "xy")] }));
  assert.equal(areaDrags(x!, -9, 2), true);
  assert.equal(areaDrags(x!, 2, 9), false);
  assert.equal(areaDrags(y!, 2, -9), true);
  assert.equal(areaDrags(y!, 9, 2), false);
  assert.equal(areaDrags(xy!, 9, 0), true);
  assert.equal(areaDrags(xy!, 0, 9), true);
  for (const a of [x!, y!, xy!]) assert.equal(areaDrags(a, 6, -6), false);
});

/** A Touch on fake cells (exclusive, with taps), whose host claims a drag
 * across as its own, as the addon claims one in an area. */
function cells() {
  const target = new EventTarget();
  const heard: string[] = [];
  const win = { performance: { now: () => 0 }, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} } as unknown as Window;
  const host: TouchHost = {
    toPage: (x, y) => [x, y],
    scroll: (dx, dy) => heard.push(`scroll ${dx},${dy}`),
    tap: (x, y) => heard.push(`tap ${x},${y}`),
    claim: (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? "drag" : true),
    dragMove: (x, y) => heard.push(`move ${x},${y}`),
    dragEnd: (x, y) => heard.push(`end ${x},${y}`),
    dragCancel: () => heard.push("cancel"),
  };
  new Touch(target, win, host, true);
  const fire = (e: Event) => (target.dispatchEvent(e), e);
  return { heard, fire };
}

test("on the cells, a touch that lifts within the slop is a tap, once, and one the host claims is no tap", () => {
  const { heard, fire } = cells();
  fire(touchEvent("touchstart", [{ id: 1, x: 10, y: 10 }]));
  fire(touchEvent("touchmove", [{ id: 1, x: 13, y: 11 }], undefined, 10));
  assert.equal(fire(touchEvent("touchend", [], [{ id: 1, x: 13, y: 11 }], 20)).defaultPrevented, true);
  fire(touchEvent("touchstart", [{ id: 2, x: 10, y: 10 }], undefined, 100));
  fire(touchEvent("touchmove", [{ id: 2, x: 40, y: 10 }], undefined, 110));
  fire(touchEvent("touchmove", [{ id: 2, x: 50, y: 12 }], undefined, 120));
  fire(touchEvent("touchend", [], [{ id: 2, x: 50, y: 12 }], 130));
  assert.deepEqual(heard, ["tap 10,10", "move 50,12", "end 50,12"]);
});

test("on the cells, the browser losing a claimed drag's touch cancels it", () => {
  const { heard, fire } = cells();
  fire(touchEvent("touchstart", [{ id: 1, x: 10, y: 10 }]));
  fire(touchEvent("touchmove", [{ id: 1, x: 40, y: 10 }], undefined, 10));
  fire(touchEvent("touchcancel", [], [{ id: 1, x: 40, y: 10 }], 20));
  fire(touchEvent("touchend", [], [{ id: 1, x: 40, y: 10 }], 30));
  assert.deepEqual(heard, ["cancel"]);
});

test("on the cells, a second finger before a touch drags makes it no drag, and no tap", () => {
  const { heard, fire } = cells();
  fire(touchEvent("touchstart", [{ id: 1, x: 10, y: 10 }]));
  fire(touchEvent("touchstart", [{ id: 1, x: 10, y: 10 }, { id: 2, x: 80, y: 10 }], [{ id: 2, x: 80, y: 10 }]));
  fire(touchEvent("touchmove", [{ id: 1, x: 40, y: 10 }, { id: 2, x: 90, y: 10 }]));
  fire(touchEvent("touchend", [], [{ id: 1, x: 40, y: 10 }]));
  assert.deepEqual(heard, []);
});
