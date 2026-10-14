// A text field's history of edits (SPEC §10.2, undo). Browsers keep one,
// but each groups edits its own way and the editing commands join theirs,
// so the addon keeps its own: every browser then undoes as the spec has it.

/** Edits that run together into one: typing, or deleting characters one at
 * a time. */
export type Run = "typing" | "deleting" | null;

/** A field's value and its selection, in code units. */
export interface FieldState {
  value: string;
  start: number;
  end: number;
  backward: boolean;
}

/** The edits a field's history keeps, the oldest dropped first. */
const LIMIT = 100;

export class History {
  /** The states to go back to, the latest last. */
  undo: FieldState[] = [];
  /** The states undone, to go forward to. */
  redo: FieldState[] = [];
  /** The run the last edit made, which an edit of the same kind goes on
   * with while the field is as that edit left it. */
  run: Run = null;
  /** The field as the last edit, undo or redo left it. A value that
   * differs was set by the program, which clears the history. */
  after: FieldState | null = null;
}

export function stateOf(el: HTMLInputElement | HTMLTextAreaElement): FieldState {
  const n = el.value.length;
  return { value: el.value, start: el.selectionStart ?? n, end: el.selectionEnd ?? n, backward: el.selectionDirection === "backward" };
}

const same = (a: FieldState, b: FieldState) => a.value === b.value && a.start === b.start && a.end === b.end;

function clear(h: History) {
  h.undo = [];
  h.redo = [];
  h.run = null;
  h.after = null;
}

/** After an action that found the field `before` and left it `after`: an
 * edit goes into the history, as one with the last when both are of the
 * `run` and nothing moved in between; any other action ends the run. */
export function edited(h: History, before: FieldState, after: FieldState, run: Run) {
  if (after.value === before.value) {
    if (run === null) h.run = null;
    return;
  }
  if (h.after !== null && h.after.value !== before.value) clear(h);
  // Deleting a selection starts an edit of its own.
  const r = run === "deleting" && before.start !== before.end ? null : run;
  if (r === null || h.run !== r || h.after === null || !same(h.after, before)) {
    h.undo.push(before);
    if (h.undo.length > LIMIT) h.undo.shift();
  }
  h.redo = [];
  h.run = r;
  h.after = after;
}

/** Undoes the last edit, or with `redo` redoes the one last undone: the
 * state to put the field in, or null when there is none. The field is
 * `now`; a value the program set clears the history. */
export function step(h: History, now: FieldState, redo: boolean): FieldState | null {
  if (h.after === null || h.after.value !== now.value) {
    clear(h);
    return null;
  }
  const [from, to] = redo ? [h.redo, h.undo] : [h.undo, h.redo];
  const s = from.pop();
  if (s === undefined) return null;
  to.push(h.after);
  h.after = s;
  h.run = null;
  return s;
}

/** The run an edit the browser makes is in, by its `inputType`. */
export function runOf(inputType: string): Run {
  if (inputType === "insertText" || inputType === "insertLineBreak" || inputType === "insertParagraph") return "typing";
  if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") return "deleting";
  return null;
}
