// Reveal and view (SPEC §6.1, §9.5): the boxes that hold an element,
// scrolling it into view in each of them, and whether some of it is shown.
//
// The browser's own scrollIntoView is no use here: it scrolls every box up
// to the page, the terminal's and the page's own included, and boxes that
// do not scroll (§5.3) too, such as `overflow: hidden` ones.

import type { Reveal } from "./delta.ts";

export type Axis = "x" | "y";

/** A rectangle in the frame's viewport, in CSS pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const style = (el: Element) => el.ownerDocument.defaultView!.getComputedStyle(el);

/**
 * How far an edge may be from where the user sees it, in CSS pixels: half a
 * device pixel, which the user cannot see, plus what layout loses on the
 * way there. Layout keeps lengths in fixed units (1/64 px in Chromium, 1/60
 * in Firefox) and cuts each box's to them, so with a cell a fraction of a
 * pixel, a row 29 boxes of one cell down starts up to 29/64 px short of its
 * cell.
 */
export function slack(edge: number, cell: number, dpr: number): number {
  return 0.5 / dpr + Math.abs(edge / cell) / 60;
}

/** Whether a box with this style is the containing block of a descendant
 * positioned `pos` (`absolute` or `fixed`), as CSS has it. */
function containsPositioned(s: CSSStyleDeclaration, pos: string): boolean {
  if (pos === "absolute" && s.position !== "static") return true;
  const v = (p: string) => s.getPropertyValue(p);
  return (
    v("transform") !== "none" ||
    v("perspective") !== "none" ||
    v("filter") !== "none" ||
    /\b(layout|paint|strict|content)\b/.test(v("contain")) ||
    /\b(transform|perspective|filter)\b/.test(v("will-change")) ||
    /\b(size|inline-size)\b/.test(v("container-type"))
  );
}

/**
 * The boxes whose overflow holds `el`, innermost first: each ancestor that
 * its containing blocks pass through (an absolutely positioned element
 * leaves the boxes between it and its containing block, a fixed one
 * everything up to the viewport), but the root, and the body where its
 * overflow is the viewport's. `viewport`: the root's scrolling moves it, as
 * it moves all but an element fixed to the viewport.
 */
function holders(el: Element): { boxes: Element[]; viewport: boolean } {
  const doc = el.ownerDocument;
  const root = doc.documentElement;
  const rs = style(root);
  // The viewport takes the root's overflow, or the body's where the root's
  // is visible both ways.
  const fromBody = rs.overflowX === "visible" && rs.overflowY === "visible";
  const boxes: Element[] = [];
  let pos = style(el).position;
  for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
    const s = style(a);
    if (s.display === "contents") continue; // no box of its own
    if ((pos === "absolute" || pos === "fixed") && !containsPositioned(s, pos)) continue;
    pos = s.position;
    if (a === doc.body && fromBody) continue;
    boxes.push(a);
  }
  return { boxes, viewport: pos !== "fixed" };
}

/** Whether a box with this style clips its content along `axis`: overflow
 * other than `visible`, or paint containment. Overflow does not apply to an
 * inline box. */
function clips(s: CSSStyleDeclaration, axis: Axis): boolean {
  if (s.display === "inline") return false;
  return (axis === "x" ? s.overflowX : s.overflowY) !== "visible" || /\b(paint|strict|content)\b/.test(s.getPropertyValue("contain"));
}

/** A box's scrollport, where it shows its content: its padding box without
 * scrollbars; the root's, the viewport's. */
function port(el: Element): Rect {
  const root = el.ownerDocument.documentElement;
  if (el === root) return { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight };
  const r = el.getBoundingClientRect();
  const left = r.left + el.clientLeft;
  const top = r.top + el.clientTop;
  return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
}

/**
 * Whether `box` scrolls along `axis` in a document that scrolls along
 * `axes` (SPEC §5.1, §5.3): the root unless its overflow there (the body's,
 * where the viewport takes it) is `hidden` or `clip`, and any other element
 * whose overflow there is `auto` or `scroll`.
 */
function scrolls(box: Element, axis: Axis, axes: number): boolean {
  if (!(axes & (axis === "y" ? 1 : 2))) return false;
  const doc = box.ownerDocument;
  const prop = axis === "y" ? "overflowY" : "overflowX";
  if (box !== doc.documentElement) return /auto|scroll/.test(style(box)[prop]);
  const rs = style(box);
  const fromBody = rs.overflowX === "visible" && rs.overflowY === "visible";
  return !/hidden|clip/.test((fromBody ? style(doc.body) : rs)[prop]);
}

/** The scroll offsets a box takes along `axis`: across a right-to-left box,
 * scrollLeft runs from minus its span to 0. */
function range(box: Element, axis: Axis): [number, number] {
  const span = Math.max(0, axis === "y" ? box.scrollHeight - box.clientHeight : box.scrollWidth - box.clientWidth);
  return axis === "x" && style(box).direction === "rtl" ? [-span, 0] : [0, span];
}

/**
 * How far a box scrolls to bring an element in by as little as it takes,
 * as `scrollIntoView` does with `block: "nearest"` (CSSOM View): not at all
 * when the element is inside the scrollport, or covers it both ways; else
 * its near edge to the box's, or its far edge where it is larger than the
 * box. `e0`, `e1` are the element's edges along the axis, `p0`, `p1` the
 * scrollport's, `tol` how far an edge may be off.
 */
function nearest(e0: number, e1: number, p0: number, p1: number, tol: number): number {
  const before = e0 < p0 - tol;
  const after = e1 > p1 + tol;
  if (before === after) return 0; // inside, or over all of it
  const fits = e1 - e0 <= p1 - p0;
  return before === fits ? e0 - p0 : e1 - p1;
}

/**
 * `reveal` (SPEC §6.1): scrolls each box that holds `el` and scrolls, the
 * innermost first and the root last, so that its border box is in view:
 * its top at the top with `start`, its bottom at the bottom with `end`,
 * and by as little as it takes with neither; across, always by as little
 * as it takes. Only along the axes the document scrolls (`axes`, §5.3).
 *
 * Each box's offset is worked out from where the element will be once the
 * boxes inside it have scrolled, so that every box can scroll as the
 * document's `scroll-behavior` has it, smoothly too, at once.
 */
export function reveal(el: Element, where: Reveal, axes: number, tol: number) {
  const doc = el.ownerDocument;
  const { boxes, viewport } = holders(el);
  if (viewport) boxes.push(doc.documentElement);
  const b = el.getBoundingClientRect();
  // How far the scrolls worked out so far move the element.
  let dx = 0;
  let dy = 0;
  for (const box of boxes) {
    const along = (["y", "x"] as const).filter((axis) => scrolls(box, axis, axes));
    if (!along.length) continue;
    const p = port(box);
    const to = { left: box.scrollLeft, top: box.scrollTop };
    let moves = false;
    for (const axis of along) {
      const [e0, e1, p0, p1] = axis === "y" ? [b.top - dy, b.bottom - dy, p.top, p.bottom] : [b.left - dx, b.right - dx, p.left, p.right];
      const by = axis === "y" && where === "start" ? e0 - p0 : axis === "y" && where === "end" ? e1 - p1 : nearest(e0, e1, p0, p1, tol);
      if (Math.abs(by) <= tol) continue;
      const [min, max] = range(box, axis);
      const at = axis === "y" ? box.scrollTop : box.scrollLeft;
      const next = Math.min(max, Math.max(min, at + by));
      if (next === at) continue;
      if (axis === "y") [to.top, dy] = [next, dy + next - at];
      else [to.left, dx] = [next, dx + next - at];
      moves = true;
    }
    if (moves) box.scrollTo({ left: to.left, top: to.top, behavior: "auto" });
  }
}

/** Whether `el` is rendered: not `display: none`, in itself or an ancestor,
 * nor `visibility: hidden` (SPEC §9.5). */
export function rendered(el: Element): boolean {
  const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
  if (check) return check.call(el, { visibilityProperty: true, checkVisibilityCSS: true });
  return el.getClientRects().length > 0 && style(el).visibility === "visible";
}

/**
 * Whether some of `el`'s border box is shown (SPEC §9.5): inside `shown`,
 * the placement's window within the viewport, and inside the scrollport of
 * every box that holds it and clips it. An edge `tol` off is where the user
 * sees it. An element thinner than that along an axis, an empty one, is
 * shown along it where it lies inside, as a cell's top edge is the cell's.
 */
export function shows(el: Element, shown: Rect, tol: (edge: number, axis: Axis) => number): boolean {
  const clip = { ...shown };
  for (const box of holders(el).boxes) {
    const s = style(box);
    const [x, y] = [clips(s, "x"), clips(s, "y")];
    if (!x && !y) continue;
    const p = port(box);
    if (x) [clip.left, clip.right] = [Math.max(clip.left, p.left), Math.min(clip.right, p.right)];
    if (y) [clip.top, clip.bottom] = [Math.max(clip.top, p.top), Math.min(clip.bottom, p.bottom)];
  }
  const b = el.getBoundingClientRect();
  const along = (axis: Axis, e0: number, e1: number, c0: number, c1: number) => {
    const t = Math.max(tol(e0, axis), tol(e1, axis));
    if (e1 - e0 > 2 * t) return Math.min(e1, c1) - Math.max(e0, c0) > t;
    const m = (e0 + e1) / 2;
    return m >= c0 - t && m < c1 - t;
  };
  return along("x", b.left, b.right, clip.left, clip.right) && along("y", b.top, b.bottom, clip.top, clip.bottom);
}

/** `end` (SPEC §9.5): the root is scrolled as far down as it goes, as one
 * that does not scroll down always is. */
export function atEnd(doc: Document, axes: number): boolean {
  const root = doc.documentElement;
  if (!scrolls(root, "y", axes)) return true;
  return root.scrollTop >= root.scrollHeight - root.clientHeight - 1;
}
