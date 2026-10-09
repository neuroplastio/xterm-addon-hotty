// Steps (SPEC §9.1): where in the element a drag started on the pointer is.
// An element that opts in to drags may divide its width and its height into
// steps with `data-steps="<x> [<y>]"`; each event of a drag of it then says
// at which step the pointer is, measured against its border box wherever the
// pointer is, and a drag goes out each time the step changes.

/** The counts `data-steps` gives, along x and along y (0 for none along that
 * axis), or null for no steps: a value that is not one or two whole numbers
 * from 0 up, or one whose counts are both 0. */
export function parseSteps(value: string | null): [number, number] | null {
  if (value === null) return null;
  const words = value.trim().split(/\s+/);
  if (words.length > 2 || !words.every((w) => /^[0-9]+$/.test(w))) return null;
  const [x, y = 0] = words.map(Number);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || (x === 0 && y === 0)) return null;
  return [x, y];
}

/** The step at `offset` pixels from a box's edge along a side `size` pixels
 * long, divided into `count` steps: the offset over the size, times the
 * count, rounded to the nearest whole number (a half up), and clamped to 0
 * and the count. A box with no size gives 0. */
export function stepAt(offset: number, size: number, count: number): number {
  if (!(size > 0)) return 0;
  const at = Math.min(Math.max(offset / size, 0), 1) * count;
  return Math.min(Math.floor(at + 0.5), count);
}
