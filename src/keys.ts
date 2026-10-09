// What a text field does with a key (SPEC §10.2, §10.4): key names, the
// keys in what the terminal sends the program, keymaps (a field's, and the
// keys any focused element gives the program), and the actions on a value.
// Pure, so the conformance vectors' keys, keymap and edit sections run
// against it (tests/unit/conformance.test.ts); the surface applies its plans
// to the document's fields (surface.ts).

const MODIFIERS = ["Control", "Alt", "Meta", "Shift"] as const;

export const ACTIONS = new Set([
  "char-backward",
  "char-forward",
  "word-backward",
  "word-forward",
  "line-start",
  "line-end",
  "delete-char-backward",
  "delete-char-forward",
  "delete-word-backward",
  "delete-word-forward",
  "delete-to-line-start",
  "delete-to-line-end",
  "line-previous",
  "line-next",
  "page-up",
  "page-down",
  "input-start",
  "input-end",
  "newline",
  "submit",
  "program",
]);

/** The actions only a multi-line field has (SPEC §10.2). */
export const MULTILINE_ACTIONS = new Set(["line-previous", "line-next", "page-up", "page-down", "input-start", "input-end", "newline"]);

/** The actions that move the caret by rows, keeping its place along them. */
export const ROW_ACTIONS = new Set(["line-previous", "line-next", "page-up", "page-down"]);

/** The moves that go back or up: from a selection, they start at its start. */
const BACKWARD = new Set(["char-backward", "word-backward", "line-start", "line-previous", "page-up", "input-start"]);

/** What `lookup` returns for a character the field types. */
export const INSERT = "insert";

/** SDK.md §3.10's keymap: Bubble Tea's text input and text area. */
export const TERMINAL_KEYS = [
  "ArrowLeft=char-backward Control+b=char-backward ArrowRight=char-forward Control+f=char-forward",
  "Alt+ArrowLeft=word-backward Control+ArrowLeft=word-backward Alt+b=word-backward",
  "Alt+ArrowRight=word-forward Control+ArrowRight=word-forward Alt+f=word-forward",
  "Home=line-start Control+a=line-start End=line-end Control+e=line-end",
  "Backspace=delete-char-backward Control+h=delete-char-backward",
  "Delete=delete-char-forward Control+d=delete-char-forward",
  "Alt+Backspace=delete-word-backward Control+w=delete-word-backward Control+Backspace=delete-word-backward",
  "Alt+Delete=delete-word-forward Alt+d=delete-word-forward Control+Delete=delete-word-forward",
  "Control+u=delete-to-line-start Control+k=delete-to-line-end",
  "ArrowUp=line-previous Control+p=line-previous ArrowDown=line-next Control+n=line-next",
  "PageUp=page-up PageDown=page-down",
  "Alt+<=input-start Control+Home=input-start Alt+>=input-end Control+End=input-end",
  "Control+m=newline",
].join(" ");

// --- Characters --------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A text's characters: grapheme clusters (SPEC §10.2). */
export function chars(s: string): string[] {
  return Array.from(segmenter.segment(s), (g) => g.segment);
}

const WHITE_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);

/** A space (SPEC §10.2): its first code point has White_Space. */
export function isSpace(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return WHITE_SPACE.has(cp) || (cp >= 0x2000 && cp <= 0x200a);
}

/** A line break: CR LF, LF or CR. */
export function isBreak(c: string): boolean {
  return c === "\n" || c === "\r" || c === "\r\n";
}

// --- Key names (§10.4) -------------------------------------------------------

const NAMED = /^[A-Z][A-Za-z0-9]+$/;

/** A printable character as a key's value: one cluster, not a control. */
function isChar(v: string): boolean {
  if (v === "") return false;
  const cp = v.codePointAt(0)!;
  return chars(v).length === 1 && cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0);
}

/** A key's name as its modifiers and its value (" " for Space), or null
 * when it does not parse. */
function splitKey(name: string): [string[], string] | null {
  let head: string;
  let value: string;
  if (name.endsWith("++") && name.length > 2) [head, value] = [name.slice(0, -2), "+"];
  else if (name === "+") [head, value] = ["", "+"];
  else {
    const i = name.lastIndexOf("+");
    [head, value] = i >= 0 ? [name.slice(0, i), name.slice(i + 1)] : ["", name];
  }
  const mods = head ? head.split("+") : [];
  if (mods.some((m) => !(MODIFIERS as readonly string[]).includes(m)) || new Set(mods).size !== mods.length) return null;
  if (value === "Space") value = " ";
  if (!isChar(value) && !NAMED.test(value)) return null;
  return [mods, value];
}

/** The canonical name: modifiers in order, Shift shown in a letter where it
 * can be, `Space` for a space. */
function keyName(mods: string[], value: string): string {
  const m = new Set(mods);
  if (m.has("Shift") && isChar(value) && [...value].length === 1) {
    const up = value.toUpperCase();
    const low = value.toLowerCase();
    if ([...up].length === 1 && up !== value) {
      value = up;
      m.delete("Shift");
    } else if ([...low].length === 1 && low !== value) m.delete("Shift");
  }
  return [...MODIFIERS.filter((x) => m.has(x)), value === " " ? "Space" : value].join("+");
}

/** A key's name in its canonical form (SPEC §10.4), or null. */
export function parseKey(name: string): string | null {
  const k = splitKey(name);
  return k ? keyName(...k) : null;
}

// --- Keys from the terminal's input (§10.4) ----------------------------------

const C0: Record<number, string> = {
  0x00: "Control+Space",
  0x08: "Control+h",
  0x09: "Tab",
  0x0d: "Enter",
  0x1b: "Escape",
  0x7f: "Backspace",
  0x1c: "Control+\\",
  0x1d: "Control+]",
  0x1e: "Control+^",
  0x1f: "Control+_",
};
const FINAL: Record<string, string> = { A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft", H: "Home", F: "End" };
const TILDE: Record<number, string> = { 1: "Home", 7: "Home", 4: "End", 8: "End", 2: "Insert", 3: "Delete", 5: "PageUp", 6: "PageDown" };
const CODES: Record<number, string> = { 9: "Tab", 13: "Enter", 27: "Escape", 8: "Backspace", 127: "Backspace" };
/** The kitty keyboard protocol's codes from 57344 that name keys. */
const KITTY: Record<number, string> = {
  57409: ".",
  57410: "/",
  57411: "*",
  57412: "-",
  57413: "+",
  57414: "Enter",
  57415: "=",
  57417: "ArrowLeft",
  57418: "ArrowRight",
  57419: "ArrowUp",
  57420: "ArrowDown",
  57421: "PageUp",
  57422: "PageDown",
  57423: "Home",
  57424: "End",
  57425: "Insert",
  57426: "Delete",
  57441: "Shift",
  57442: "Control",
  57443: "Alt",
  57444: "Meta",
  57447: "Shift",
  57448: "Control",
  57449: "Alt",
  57450: "Meta",
};
for (let i = 0; i < 10; i++) KITTY[57399 + i] = String(i);

/** A key's name with more modifiers. */
function withMods(name: string | null, add: string[]): string | null {
  if (name === null) return null;
  const [mods, value] = splitKey(name)!;
  return keyName([...mods, ...add.filter((m) => !mods.includes(m))], value);
}

/** The modifiers in a CSI parameter `m[:e]`, or null for a release or a
 * parameter that does not parse. */
function modsOf(field: string | undefined): string[] | null {
  const [ms = "", es = ""] = (field ?? "").split(":");
  const m = ms === "" ? 1 : Number(ms);
  const e = es === "" ? 1 : Number(es);
  if (!Number.isInteger(m) || !Number.isInteger(e) || e === 3) return null;
  const bits = m < 2 ? 0 : m - 1;
  const out: string[] = [];
  if (bits & 1) out.push("Shift");
  if (bits & 2) out.push("Alt");
  if (bits & 4) out.push("Control");
  if (bits & (8 | 32)) out.push("Meta");
  return out;
}

/** The key a kitty or modifyOtherKeys code names. */
function codeKey(code: number, mods: string[], shifted?: number, text?: string): string | null {
  if (CODES[code]) return keyName(mods, CODES[code]);
  if (code >= 57344) return KITTY[code] ? keyName(mods, KITTY[code]) : null;
  if (code < 0x20 || code === 0x7f || code > 0x10ffff) return null;
  const base = String.fromCodePoint(code);
  let value = base;
  if (mods.includes("Shift")) {
    if (shifted) value = String.fromCodePoint(shifted);
    else if (text) value = text;
    else if ([...base.toUpperCase()].length === 1) value = base.toUpperCase();
    if (value !== base) mods = mods.filter((m) => m !== "Shift");
  }
  return [...MODIFIERS.filter((x) => mods.includes(x)), value === " " ? "Space" : value].join("+");
}

function csi(params: string, final: string): string | null {
  if (/^[<=>?]/.test(params)) return null;
  const fields = params.split(";");
  const num = (s: string | undefined) => (s === undefined || s === "" ? 0 : Number(s));
  if (final === "u") {
    const codes = fields[0]!.split(":").map(num);
    const mods = modsOf(fields[1]);
    if (mods === null || codes.some((c) => !Number.isInteger(c))) return null;
    const text = fields[2]
      ?.split(":")
      .filter(Boolean)
      .map((x) => String.fromCodePoint(Number(x)))
      .join("");
    return codeKey(codes[0]!, mods, codes[1] || undefined, text || undefined);
  }
  if (final === "~") {
    const n = num(fields[0]);
    if (n === 27 && fields.length >= 3) {
      const mods = modsOf(fields[1]);
      const c = num(fields[2]);
      return mods === null || !Number.isInteger(c) ? null : codeKey(c, mods);
    }
    const mods = modsOf(fields[1]);
    return TILDE[n] && mods !== null ? keyName(mods, TILDE[n]) : null;
  }
  if (FINAL[final]) {
    const mods = modsOf(fields[1]);
    return mods === null ? null : keyName(mods, FINAL[final]);
  }
  if (final === "Z") return "Shift+Tab";
  return null;
}

/** One key of the input: its canonical name (null for input that is no
 * key), and the input it came from. */
export interface InputKey {
  key: string | null;
  data: string;
}

/** The key of a control or a character at `s[i]`, and its length. */
function one(s: string, i: number): [string | null, number] {
  const c = s.charCodeAt(i);
  if (c < 0x20 || c === 0x7f) return [C0[c] ?? `Control+${String.fromCharCode(c + 0x60)}`, 1];
  const cl = segmenter.segment(s.slice(i)).containing(0)!.segment;
  // A cluster ends at a control: CR LF is the only one that holds two.
  return [isChar(cl) ? (cl === " " ? "Space" : cl) : null, cl.length];
}

/** The keys in what the terminal sends the program (SPEC §10.4), each with
 * the input it came from. */
export function inputKeys(s: string): InputKey[] {
  const out: InputKey[] = [];
  let i = 0;
  while (i < s.length) {
    const start = i;
    let key: string | null;
    if (s.charCodeAt(i) !== 0x1b) {
      let n: number;
      [key, n] = one(s, i);
      i += n;
    } else if (i + 1 === s.length) {
      key = "Escape";
      i += 1;
    } else if ((s[i + 1] === "[" || s[i + 1] === "O") && i + 2 < s.length) {
      if (s[i + 1] === "O") {
        key = "ABCDHF".includes(s[i + 2]!) ? FINAL[s[i + 2]!]! : null;
        i += 3;
      } else {
        let j = i + 2;
        while (j < s.length && s.charCodeAt(j) >= 0x30 && s.charCodeAt(j) <= 0x3f) j++;
        const params = s.slice(i + 2, j);
        while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
        if (j === s.length) {
          key = null;
          i = j;
        } else {
          key = s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e ? csi(params, s[j]!) : null;
          i = j + 1;
        }
      }
    } else {
      const [k, n] = one(s, i + 1);
      key = withMods(k, ["Alt"]);
      i += 1 + n;
    }
    out.push({ key, data: s.slice(start, i) });
  }
  return out;
}

/** The keys' names (SDK.md §3.10: `DecodeKeys`). */
export function decodeKeys(s: string): (string | null)[] {
  return inputKeys(s).map((k) => k.key);
}

// --- Keymaps (§10.2) ---------------------------------------------------------

const UNBOUND = new Set(["Tab", "Shift+Tab", "Escape"]);

/** Bindings of keys to actions. `resolve` makes the one a field uses. */
export class Keymap {
  readonly bindings = new Map<string, string>();
  readonly multiline: boolean;
  constructor(multiline = false) {
    this.multiline = multiline;
  }

  bind(key: string, action: string) {
    this.bindings.set(key, action);
  }

  format(): string {
    return Array.from(this.bindings, ([k, a]) => `${k}=${a}`).join(" ");
  }

  /** The action a key is bound to: its own binding, or for a key with
   * Shift that has none, the binding of the key without it (SPEC §10.2). */
  action(name: string): string | undefined {
    const k = parseKey(name);
    if (k === null || UNBOUND.has(k)) return undefined;
    const [mods, value] = splitKey(k)!;
    const a = this.bindings.get(k);
    if (a !== undefined || !mods.includes("Shift")) return a;
    return this.bindings.get(
      keyName(
        mods.filter((m) => m !== "Shift"),
        value,
      ),
    );
  }

  /** Whether the key is the program's (SPEC §10.2, *Keys for the
   * program*): bound to `program`. It reaches the program before the
   * focused element uses it and before the surface scrolls with it. */
  program(name: string): boolean {
    return this.action(name) === "program";
  }

  /** What the field does with a key: an action, `INSERT` for a character it
   * types, or null when the key is not the field's. */
  lookup(name: string): string | null {
    const k = parseKey(name);
    if (k === null || UNBOUND.has(k)) return null;
    const a = this.action(k);
    if (a !== undefined) return a === "program" || (MULTILINE_ACTIONS.has(a) && !this.multiline) ? null : a;
    const [mods, value] = splitKey(k)!;
    if (isChar(value) && !mods.some((m) => m !== "Shift")) return INSERT;
    return null;
  }
}

/** A `data-keys` value's bindings, without those a host ignores. */
export function parseKeymap(value: string, multiline = false): Keymap {
  const m = new Keymap(multiline);
  // ASCII white space, as HTML splits space-separated tokens.
  for (const b of value.split(/[ \t\n\f\r]+/)) {
    const i = b.lastIndexOf("=");
    if (i < 0) continue;
    const k = parseKey(b.slice(0, i));
    const a = b.slice(i + 1);
    if (k === null || !ACTIONS.has(a) || UNBOUND.has(k)) continue;
    m.bind(k, a);
  }
  return m;
}

/** A focused element's keymap outside a text field (SPEC §10.2, *Keys for
 * the program*): each `data-keys` value, the root's first, over no default.
 * Only its `program` bindings count there (`Keymap.program`): a nearer
 * binding of a key to another action cancels a farther one to `program`. */
export function elementKeymap(...values: string[]): Keymap {
  const m = new Keymap();
  for (const v of values) for (const [k, a] of parseKeymap(v).bindings) m.bind(k, a);
  return m;
}

/** A field's keymap: SPEC §10.2's default, then each `data-keys` value, the
 * root's first. */
export function resolve(multiline: boolean, ...values: string[]): Keymap {
  const m = new Keymap(multiline);
  for (const [k, a] of [
    ["ArrowLeft", "char-backward"],
    ["ArrowRight", "char-forward"],
    ["Home", "line-start"],
    ["End", "line-end"],
    ["Backspace", "delete-char-backward"],
    ["Delete", "delete-char-forward"],
    ["ArrowUp", "line-previous"],
    ["ArrowDown", "line-next"],
    ["PageUp", "page-up"],
    ["PageDown", "page-down"],
    ["Enter", multiline ? "newline" : "submit"],
  ] as const)
    m.bind(k, a);
  for (const v of values) for (const [k, a] of parseKeymap(v).bindings) m.bind(k, a);
  return m;
}

// --- Actions on a value (§10.2) ----------------------------------------------

/** A field's text and selection, in characters (`start` = `end` when it is
 * a caret). */
export interface Text {
  chars: string[];
  start: number;
  end: number;
  multiline: boolean;
  password: boolean;
}

/** How the field lays its rows out: `move` is where a run of row moves
 * goes from `from`, `by` rows, keeping `goal` (null at a run's start), the
 * place along the row it began at; `page` is the rows the field shows. */
export interface Rows {
  move(from: number, by: number, goal: number | null): { to: number; goal: number };
  page: number;
}

/** What an action does to a field: move its caret, replace a part of it
 * (the caret then after the text), or nothing it can do itself. */
export type Plan = { kind: "move"; to: number; goal?: number } | { kind: "replace"; from: number; to: number; text: string } | { kind: "none" };

function lineOf(t: Text, p: number): [number, number] {
  if (!t.multiline) return [0, t.chars.length];
  let s = p;
  while (s > 0 && !isBreak(t.chars[s - 1]!)) s--;
  let e = p;
  while (e < t.chars.length && !isBreak(t.chars[e]!)) e++;
  return [s, e];
}

function wordBack(t: Text, p: number): number {
  if (t.password) return 0;
  while (p > 0 && isSpace(t.chars[p - 1]!)) p--;
  while (p > 0 && !isSpace(t.chars[p - 1]!)) p--;
  return p;
}

function wordForward(t: Text, p: number): number {
  if (t.password) return t.chars.length;
  while (p < t.chars.length && isSpace(t.chars[p]!)) p++;
  while (p < t.chars.length && !isSpace(t.chars[p]!)) p++;
  return p;
}

/** What `action` does to `t` (SPEC §10.2). `goal` is the run of row moves
 * under way, if any. */
export function plan(t: Text, action: string, rows: Rows | null, goal: number | null = null): Plan {
  if (MULTILINE_ACTIONS.has(action) && !t.multiline) return { kind: "none" };
  const n = t.chars.length;
  const selected = t.start < t.end;
  if (action.startsWith("delete-")) {
    if (selected) return { kind: "replace", from: t.start, to: t.end, text: "" };
    const p = t.start;
    const [s, e] = lineOf(t, p);
    const [from, to] = {
      "delete-char-backward": [Math.max(p - 1, 0), p],
      "delete-char-forward": [p, Math.min(p + 1, n)],
      "delete-word-backward": [wordBack(t, p), p],
      "delete-word-forward": [p, wordForward(t, p)],
      "delete-to-line-start": [s, p],
      "delete-to-line-end": [p, e],
    }[action] ?? [p, p];
    return from < to ? { kind: "replace", from, to, text: "" } : { kind: "none" };
  }
  if (action === "newline") return { kind: "replace", from: t.start, to: t.end, text: "\n" };
  // A move starts from the selection's start when it goes back or up, and
  // from its end otherwise; char-backward and char-forward stop there.
  const p = BACKWARD.has(action) ? t.start : t.end;
  if (selected && (action === "char-backward" || action === "char-forward")) return { kind: "move", to: p };
  const [s, e] = lineOf(t, p);
  switch (action) {
    case "char-backward":
      return { kind: "move", to: Math.max(p - 1, 0) };
    case "char-forward":
      return { kind: "move", to: Math.min(p + 1, n) };
    case "word-backward":
      return { kind: "move", to: wordBack(t, p) };
    case "word-forward":
      return { kind: "move", to: wordForward(t, p) };
    case "line-start":
      return { kind: "move", to: s };
    case "line-end":
      return { kind: "move", to: e };
    case "input-start":
      return { kind: "move", to: 0 };
    case "input-end":
      return { kind: "move", to: n };
    case "line-previous":
    case "line-next":
    case "page-up":
    case "page-down": {
      if (!rows) return { kind: "none" };
      const by = { "line-previous": -1, "line-next": 1, "page-up": -rows.page, "page-down": rows.page }[action];
      const r = rows.move(p, by, goal);
      return { kind: "move", to: r.to, goal: r.goal };
    }
  }
  return { kind: "none" };
}

/** Rows that are lines, the place along them a count of characters: a field
 * that does not wrap (SDK.md §4.6). */
export function lineRows(t: Text, page = 1): Rows {
  const starts = [0];
  t.chars.forEach((c, i) => {
    if (t.multiline && isBreak(c)) starts.push(i + 1);
  });
  const endOf = (r: number) => (r + 1 < starts.length ? starts[r + 1]! - 1 : t.chars.length);
  return {
    page: Math.max(page, 1),
    move(from, by, goal) {
      let r = starts.length - 1;
      while (starts[r]! > from) r--;
      const g = goal ?? from - starts[r]!;
      const to = r + by;
      if (to < 0) return { to: 0, goal: g };
      if (to >= starts.length) return { to: t.chars.length, goal: g };
      return { to: starts[to]! + Math.min(g, endOf(to) - starts[to]!), goal: g };
    },
  };
}

/** A text field's value and caret (SDK.md §4.6), as the conformance
 * vectors' edit section has one. */
export class Field {
  value: string;
  caret: number;
  readonly multiline: boolean;
  readonly password: boolean;
  readonly rows: number;
  private goal: number | null = null;
  constructor(value: string, caret: number, multiline = false, password = false, rows = 1) {
    this.value = value;
    this.caret = caret;
    this.multiline = multiline;
    this.password = password;
    this.rows = rows;
  }

  private text(): Text {
    const c = chars(this.value);
    const p = Math.min(Math.max(this.caret, 0), c.length);
    return { chars: c, start: p, end: p, multiline: this.multiline, password: this.password };
  }

  /** Does an action; whether the value changed. */
  do(action: string): boolean {
    const t = this.text();
    const goal = ROW_ACTIONS.has(action) ? this.goal : null;
    const p = plan(t, action, lineRows(t, this.rows), goal);
    this.goal = p.kind === "move" && p.goal !== undefined ? p.goal : null;
    return this.apply(t, p);
  }

  /** Types text at the caret; whether the value changed. */
  type(text: string): boolean {
    this.goal = null;
    if (!text) return false;
    const t = this.text();
    return this.apply(t, { kind: "replace", from: t.start, to: t.end, text });
  }

  private apply(t: Text, p: Plan): boolean {
    if (p.kind === "move") this.caret = p.to;
    if (p.kind !== "replace") return false;
    const before = t.chars.slice(0, p.from).join("") + p.text;
    this.value = before + t.chars.slice(p.to).join("");
    this.caret = chars(before).length;
    return true;
  }
}
