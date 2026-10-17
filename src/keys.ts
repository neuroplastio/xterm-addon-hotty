// What a text field does with a key (SPEC §10.2, §10.4): key names, the
// keys in what the terminal sends the program, keymaps (a field's, and the
// keys any focused element gives the program or scrolls with), and the
// actions on a value.
// Pure, so the conformance vectors' keys, keymap and edit sections run
// against it (tests/unit/conformance.test.ts); the surface applies its plans
// to the document's fields (surface.ts).

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
  "select-all",
  "newline",
  "submit",
  "program",
  "prefix",
  "copy",
  "cut",
  "paste",
  "undo",
  "redo",
  "scroll-up",
  "scroll-down",
  "scroll-left",
  "scroll-right",
  "scroll-page-up",
  "scroll-page-down",
  "scroll-half-page-up",
  "scroll-half-page-down",
  "scroll-start",
  "scroll-end",
]);

/** The scroll actions (SPEC §10.2, *Scrolling keys*): a focused element
 * that is not a text field scrolls with them, and a field's keymap leaves
 * them out. */
export const SCROLL_ACTIONS = new Set([...ACTIONS].filter((a) => a.startsWith("scroll-")));

/** The actions only a multi-line field has (SPEC §10.2). */
export const MULTILINE_ACTIONS = new Set(["line-previous", "line-next", "page-up", "page-down", "newline"]);

/** The moves, which select with Shift (SPEC §10.2). */
export const MOVES = new Set([
  "char-backward",
  "char-forward",
  "word-backward",
  "word-forward",
  "line-start",
  "line-end",
  "line-previous",
  "line-next",
  "page-up",
  "page-down",
  "input-start",
  "input-end",
]);

/** The actions that move the caret by rows, keeping its place along them. */
export const ROW_ACTIONS = new Set(["line-previous", "line-next", "page-up", "page-down"]);

/** The moves that go back or up: from a selection, they start at its start. */
const BACKWARD = new Set(["char-backward", "word-backward", "line-start", "line-previous", "page-up", "input-start"]);

/** What `lookup` returns for a character the field types. */
export const INSERT = "insert";

/** SDK.md §3.10's keymap: Bubble Tea's text input and text area, but
 * mod+a selects all. */
export const TERMINAL_KEYS = [
  "arrow_left=char-backward ctrl+b=char-backward arrow_right=char-forward ctrl+f=char-forward",
  "alt+arrow_left=word-backward ctrl+arrow_left=word-backward alt+b=word-backward",
  "alt+arrow_right=word-forward ctrl+arrow_right=word-forward alt+f=word-forward",
  "home=line-start end=line-end ctrl+e=line-end",
  "backspace=delete-char-backward ctrl+h=delete-char-backward",
  "delete=delete-char-forward ctrl+d=delete-char-forward",
  "alt+backspace=delete-word-backward ctrl+w=delete-word-backward ctrl+backspace=delete-word-backward",
  "alt+delete=delete-word-forward alt+d=delete-word-forward ctrl+delete=delete-word-forward",
  "ctrl+u=delete-to-line-start ctrl+k=delete-to-line-end",
  "arrow_up=line-previous ctrl+p=line-previous arrow_down=line-next ctrl+n=line-next",
  "page_up=page-up page_down=page-down",
  "alt+<=input-start ctrl+home=input-start alt+>=input-end ctrl+end=input-end",
  "mod+a=select-all",
  "ctrl+m=newline",
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

/** The modifiers, in the order a key's name writes them (myelin key names
 * §2.1). */
export const MODIFIERS = ["super", "ctrl", "alt", "shift"] as const;

/** The modifier `mod` stands for (SPEC §4, §10.4). */
export type Mod = "ctrl" | "super";

/** The modifiers' names and aliases, as the default reading takes them. */
const MODIFIER_NAMES: Record<string, string> = {
  super: "super",
  cmd: "super",
  command: "super",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
};

/** The physical keys (myelin key names, Appendix A). */
const PHYSICAL = new Set(
  (
    "backquote backslash bracket_left bracket_right comma digit_0 digit_1 digit_2 digit_3 digit_4 digit_5 digit_6 digit_7 digit_8 digit_9 equal " +
    "intl_backslash intl_ro intl_yen key_a key_b key_c key_d key_e key_f key_g key_h key_i key_j key_k key_l key_m key_n key_o key_p key_q key_r key_s key_t key_u key_v key_w key_x key_y key_z " +
    "minus period quote semicolon slash alt_left alt_right backspace caps_lock context_menu control_left control_right enter meta_left meta_right shift_left shift_right space tab " +
    "convert kana_mode non_convert delete end help home insert page_down page_up arrow_down arrow_left arrow_right arrow_up num_lock " +
    "numpad_0 numpad_1 numpad_2 numpad_3 numpad_4 numpad_5 numpad_6 numpad_7 numpad_8 numpad_9 numpad_add numpad_backspace numpad_clear numpad_clear_entry numpad_comma numpad_decimal " +
    "numpad_divide numpad_enter numpad_equal numpad_memory_add numpad_memory_clear numpad_memory_recall numpad_memory_store numpad_memory_subtract numpad_multiply numpad_paren_left " +
    "numpad_paren_right numpad_subtract numpad_separator numpad_up numpad_down numpad_right numpad_left numpad_begin numpad_home numpad_end numpad_insert numpad_delete numpad_page_up numpad_page_down " +
    "escape f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12 f13 f14 f15 f16 f17 f18 f19 f20 f21 f22 f23 f24 f25 fn fn_lock print_screen scroll_lock pause " +
    "browser_back browser_favorites browser_forward browser_home browser_refresh browser_search browser_stop eject launch_app_1 launch_app_2 launch_mail media_play_pause media_select media_stop " +
    "media_track_next media_track_previous power sleep audio_volume_down audio_volume_mute audio_volume_up wake_up copy cut paste"
  ).split(" "),
);

/** Other keymaps' names for physical keys, which the default reading takes
 * (myelin key names §4.1). */
const OTHER: Record<string, string> = {
  up: "arrow_up",
  down: "arrow_down",
  left: "arrow_left",
  right: "arrow_right",
  pageup: "page_up",
  pagedown: "page_down",
  pgup: "page_up",
  pgdn: "page_down",
  esc: "escape",
};

const ALIAS = /^<[A-Za-z0-9_-]+>$/;

/** Each code point's simple lowercase mapping. */
function lower(c: string): string {
  return Array.from(c, (x) => {
    const l = x.toLowerCase();
    return Array.from(l).length === 1 ? l : x;
  }).join("");
}

/** Each code point's simple uppercase mapping. */
function upper(c: string): string {
  return Array.from(c, (x) => {
    const u = x.toUpperCase();
    return Array.from(u).length === 1 ? u : x;
  }).join("");
}

/** A capital (myelin key names §4.3): one code point whose lowercase
 * differs and maps back to it. */
function isCapital(c: string): boolean {
  return Array.from(c).length === 1 && lower(c) !== c && upper(lower(c)) === c;
}

/** A letter: a character with case (myelin key names §2.6). */
function isLetter(c: string): boolean {
  return upper(c) !== c || isCapital(c);
}

/** One character (myelin key names §2.4): one cluster whose first code
 * point is neither a space nor a control. */
function isChar(v: string): boolean {
  if (v === "") return false;
  const cp = v.codePointAt(0)!;
  return chars(v).length === 1 && cp > 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp < 0xa0);
}

/** A physical key as the default reading takes it (a name in any case, one
 * of the other names, or a W3C code value), or null. */
function physical(part: string): string | null {
  const low = part.toLowerCase();
  if (PHYSICAL.has(low)) return low;
  if (OTHER[low] !== undefined) return OTHER[low]!;
  let out = "";
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (!/[A-Za-z0-9]/.test(c)) return null;
    if (i > 0 && (/[A-Z]/.test(c) || /[0-9]/.test(c))) out += "_";
    out += c.toLowerCase();
  }
  return PHYSICAL.has(out) ? out : null;
}

/** A key's name from its modifiers (`mod` first where a key keeps it) and
 * its value. */
function join(mods: Iterable<string>, value: string): string {
  const m = new Set(mods);
  return [...(["mod", ...MODIFIERS] as string[]).filter((x) => m.has(x)), value].join("+");
}

/**
 * A key's name as myelin key names' default reading takes it (§4.1), in its
 * canonical form, or null where the reading refuses it. `mod` stands for
 * that modifier (§4.4), and is refused when it is null. With `keep`, a key
 * written with `mod` keeps it, first.
 */
function read(text: string, mod: Mod | null, keep: boolean): string | null {
  if (text === "" || ALIAS.test(text)) return null;
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const j = text.indexOf("+", i);
    if (j < 0) {
      parts.push(text.slice(i));
      break;
    }
    parts.push(text.slice(i, j));
    i = j + 1;
    if (i === text.length) {
      if (parts[parts.length - 1] !== "") return null; // ctrl+, a+
      break;
    }
  }
  const mods = new Set<string>();
  const order: string[] = [];
  const written = new Set<string>();
  const named = new Set<string>();
  let value: string | null = null;
  for (const p of parts) {
    const low = p.toLowerCase();
    let m: string | undefined = MODIFIER_NAMES[low];
    if (low === "meta") return null;
    if (low === "mod") {
      if (mod === null) return null;
      // `mod` with `super` or `ctrl`, whichever it stands for, is refused
      // (SPEC §10.4), and `mod` twice, as any modifier is.
      if (named.has("mod") || named.has("super") || named.has("ctrl")) return null;
      named.add("mod");
      m = mod;
      written.add(m);
    } else if (m !== undefined) {
      if ((m === "super" || m === "ctrl") && named.has("mod")) return null;
      named.add(m);
    }
    if (m !== undefined) {
      if (mods.has(m)) return null;
      mods.add(m);
      order.push(m);
      continue;
    }
    if (value !== null) return null;
    if (p === "") value = "+";
    else if (isChar(p)) value = lower(p);
    else {
      value = physical(p);
      if (value === null) return null;
    }
  }
  if (value === null) {
    if (order.length === 0) return null;
    value = order[order.length - 1]!;
    mods.delete(value);
    written.delete(value);
  }
  if (keep && written.size) return join([...[...mods].filter((m) => !written.has(m)), "mod"], value);
  return join(mods, value);
}

/** A key's name in its canonical form (SPEC §10.4), or null. `mod` is
 * refused: only a Platform reads it (`readKey`). */
export function parseKey(name: string): string | null {
  return read(name, null, false);
}

/** A key taken apart (myelin key names §2.1): its modifiers, its value and
 * the kind of value. */
function splitKey(k: string): { mods: string[]; value: string; kind: "character" | "physical" | "modifier" } {
  const parts = k.split("+");
  const mods: string[] = [];
  while (parts.length > 1 && (MODIFIERS as readonly string[]).includes(parts[0]!)) mods.push(parts.shift()!);
  const value = parts.join("+");
  const kind = PHYSICAL.has(value) ? "physical" : (MODIFIERS as readonly string[]).includes(value) ? "modifier" : "character";
  return { mods, value, kind };
}

/** The text a key types in a field (SPEC §10.2; SDK.md §3.10): a
 * character's, a letter with `shift` as its capital, a space for `space`,
 * and none for any other key, or a key with `ctrl`, `alt` or `super`. */
export function keyText(key: string): string | null {
  const k = parseKey(key);
  if (k === null) return null;
  const { mods, value, kind } = splitKey(k);
  if (mods.some((m) => m !== "shift")) return null;
  if (value === "space") return " ";
  if (kind !== "character") return null;
  return mods.includes("shift") && isLetter(value) ? upper(value) : value;
}

// --- Display (myelin key names §6) -------------------------------------------

const ARROWS: Record<string, string> = { arrow_left: "←", arrow_right: "→", arrow_up: "↑", arrow_down: "↓" };

/** A key as a menu or a hint shows it (myelin key names §6): its canonical
 * name, but for the arrows, `tab` and `shift+tab`. A name that does not
 * parse is shown as it is. */
export function displayKey(name: string): string {
  const k = parseKey(name);
  if (k === null) return name;
  const { mods, value } = splitKey(k);
  if (ARROWS[value] !== undefined) return [...mods, ARROWS[value]].join("+");
  if (value === "tab") {
    const shifted = mods[mods.length - 1] === "shift";
    return [...(shifted ? mods.slice(0, -1) : mods), shifted ? "⇧⇥" : "⇥"].join("+");
  }
  return k;
}

// --- Platforms (§10.2, §10.4) ------------------------------------------------

/** How a host reads bindings: the modifier `mod` stands for, and its edit
 * shortcuts, each edit action with its keys (absent: `defaultEdit`). */
export interface Platform {
  mod?: Mod;
  edit?: Record<string, string[]>;
}

/** The edit actions, in SPEC §10.2's order. */
export const EDIT_ACTIONS = ["select-all", "copy", "cut", "paste", "undo", "redo"] as const;

/** A key's name as the platform reads it: canonical, with `mod` read; null
 * when it does not parse. */
export function readKey(p: Platform, name: string): string | null {
  return read(name, p.mod ?? "ctrl", false);
}

/** The default edit shortcuts for a `mod` (SPEC §10.2), each key read. */
export function defaultEdit(mod: Mod = "ctrl"): Record<string, string[]> {
  const e: Record<string, string[]> = {};
  EDIT_ACTIONS.slice(0, 5).forEach((a, i) => (e[a] = [`mod+${"acxvz"[i]}`]));
  e.redo = ["mod+shift+z"];
  if (mod === "ctrl") e.redo.push("ctrl+y");
  for (const a of EDIT_ACTIONS) e[a] = e[a]!.map((k) => read(k, mod, false)!);
  return e;
}

/** The platform's edit shortcuts. */
export function editOf(p: Platform): Record<string, string[]> {
  return p.edit ?? defaultEdit(p.mod);
}

/** The edit action whose shortcut a pressed key is (SPEC §10.6), or null:
 * its own binding only, so `ctrl+shift+v` is not `ctrl+v`'s paste. */
export function editAction(p: Platform, name: string): string | null {
  const m = new Keymap(false, p.mod);
  const edit = editOf(p);
  for (const a of EDIT_ACTIONS) for (const k of edit[a] ?? []) m.bind(k, a);
  return m.bindings.get(name) ?? null;
}

// --- Naming a press (§10.4) --------------------------------------------------

/** What a press needs to be named: a `KeyboardEvent`'s. */
export interface Press {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Key values that are no key a field is offered: modifiers, dead keys, an
 * input method's. */
export const NOT_KEYS = new Set(["Unidentified", "Dead", "Process", "Compose", "Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "Fn", "FnLock", "CapsLock", "NumLock", "ScrollLock", "Symbol", "SymbolLock"]);

/** The modifiers a press holds, as names. */
function held(e: Press): string[] {
  return [e.metaKey && "super", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean) as string[];
}

/**
 * A press named as pressed (SPEC §10.4; myelin key names §7): its physical
 * key (`code`, in snake case) and the character it types (`key`, when it is
 * one character; a space is `space`), each with the modifiers held. The
 * physical name comes first, which is the one looked up first. A modifier
 * on its own, a dead key and an input method's are no key: none.
 */
export function pressNames(e: Press): string[] {
  if (NOT_KEYS.has(e.key)) return [];
  const mods = held(e);
  const out: string[] = [];
  const code = e.code ? physical(e.code) : null;
  if (code !== null) out.push(join(mods, code));
  if (e.key === " ") out.push(join(mods, "space"));
  else if (isChar(e.key)) {
    // Shift is a modifier of a letter, and already in any other character
    // (myelin key names §2.6).
    const c = lower(e.key);
    out.push(join(mods.filter((m) => m !== "shift" || isLetter(e.key)), c));
  }
  return [...new Set(out)];
}

/** The modifier keys: their codes' sided names, and the modifier. */
const MODIFIER_KEYS: Record<string, [string, string]> = {
  ShiftLeft: ["shift_left", "shift"],
  ShiftRight: ["shift_right", "shift"],
  ControlLeft: ["control_left", "ctrl"],
  ControlRight: ["control_right", "ctrl"],
  AltLeft: ["alt_left", "alt"],
  AltRight: ["alt_right", "alt"],
  MetaLeft: ["meta_left", "super"],
  MetaRight: ["meta_right", "super"],
};

/**
 * Modifier keys tapped (myelin key names §2.5): a modifier pressed and
 * released with no other key pressed between. Fed every key event of one
 * keyboard, it names a tap on its release, as the sided key and as the
 * modifier key (`shift_left`, `shift`), the modifiers held before them.
 */
export class Taps {
  /** The modifier keys down, by code, and whether no key came after. */
  private readonly down = new Map<string, boolean>();

  feed(e: Press & { type: string; repeat?: boolean }): string[] {
    if (e.type === "keydown") {
      if (e.repeat) return [];
      for (const code of this.down.keys()) this.down.set(code, false);
      if (MODIFIER_KEYS[e.code]) this.down.set(e.code, true);
      return [];
    }
    const m = MODIFIER_KEYS[e.code];
    if (e.type !== "keyup" || !m) return [];
    const tap = this.down.get(e.code) === true;
    this.down.delete(e.code);
    if (!tap) return [];
    const mods = held(e).filter((x) => x !== m[1]);
    return [join(mods, m[0]), join(mods, m[1])];
  }
}

// --- Keys from the terminal's input (§10.4) ----------------------------------

const C0: Record<number, string> = {
  0x00: "ctrl+space",
  0x08: "ctrl+h",
  0x09: "tab",
  0x0d: "enter",
  0x1b: "escape",
  0x7f: "backspace",
  0x1c: "ctrl+\\",
  0x1d: "ctrl+]",
  0x1e: "ctrl+^",
  0x1f: "ctrl+_",
};
const FINAL: Record<string, string> = { A: "arrow_up", B: "arrow_down", C: "arrow_right", D: "arrow_left", H: "home", F: "end" };
const TILDE: Record<number, string> = { 1: "home", 7: "home", 4: "end", 8: "end", 2: "insert", 3: "delete", 5: "page_up", 6: "page_down" };
const CODES: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 8: "backspace", 127: "backspace", 32: "space" };
/** The kitty keyboard protocol's keypad codes, which name what a legacy
 * terminal sends for the key (SPEC §10.4). Its other codes from 57344 are
 * no key here. */
const KITTY: Record<number, string> = {
  57409: ".",
  57410: "/",
  57411: "*",
  57412: "-",
  57413: "+",
  57414: "enter",
  57415: "=",
  57417: "arrow_left",
  57418: "arrow_right",
  57419: "arrow_up",
  57420: "arrow_down",
  57421: "page_up",
  57422: "page_down",
  57423: "home",
  57424: "end",
  57425: "insert",
  57426: "delete",
};
for (let i = 0; i < 10; i++) KITTY[57399 + i] = String(i);

/** The key of a character with modifiers: a capital is `shift` with its
 * letter. */
function charKey(c: string, mods: Iterable<string>): string {
  const m = new Set(mods);
  if (c === " ") return join(m, "space");
  if (isCapital(c)) {
    m.add("shift");
    c = lower(c);
  }
  return join(m, c);
}

/** A key's name with more modifiers. */
function withMods(name: string | null, add: string[]): string | null {
  if (name === null) return null;
  const { mods, value } = splitKey(name);
  return join([...mods, ...add], value);
}

/** The modifiers in a CSI parameter `m[:e]`, or null for a release or a
 * parameter that does not parse. */
function modsOf(field: string | undefined): Set<string> | null {
  const [ms = "", es = ""] = (field ?? "").split(":");
  const m = ms === "" ? 1 : Number(ms);
  const e = es === "" ? 1 : Number(es);
  if (!Number.isInteger(m) || !Number.isInteger(e) || e === 3) return null;
  const bits = m < 2 ? 0 : m - 1;
  const out = new Set<string>();
  if (bits & 1) out.add("shift");
  if (bits & 2) out.add("alt");
  if (bits & 4) out.add("ctrl");
  if (bits & (8 | 32)) out.add("super");
  return out;
}

/** The key a kitty or modifyOtherKeys code names. */
function codeKey(code: number, mods: Set<string>, shifted?: number, text?: string): string | null {
  if (CODES[code]) return join(mods, CODES[code]!);
  if (code >= 57344) return KITTY[code] ? join(mods, KITTY[code]!) : null;
  if (code < 0x20 || code === 0x7f || code > 0x10ffff) return null;
  const c = String.fromCodePoint(code);
  if (isLetter(c)) return join(mods, lower(c));
  if (mods.has("shift")) {
    const rest = new Set(mods);
    rest.delete("shift");
    if (shifted) return charKey(String.fromCodePoint(shifted), rest);
    if (text) return charKey(text, rest);
  }
  return join(mods, c);
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
    return TILDE[n] && mods !== null ? join(mods, TILDE[n]!) : null;
  }
  if (FINAL[final]) {
    const mods = modsOf(fields[1]);
    return mods === null ? null : join(mods, FINAL[final]!);
  }
  if (final === "Z") return "shift+tab";
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
  if (c < 0x20 || c === 0x7f) return [C0[c] ?? `ctrl+${String.fromCharCode(c + 0x60)}`, 1];
  const cl = segmenter.segment(s.slice(i)).containing(0)!.segment;
  // A cluster ends at a control: CR LF is the only one that holds two.
  return [cl === " " ? "space" : isChar(cl) ? charKey(cl, []) : null, cl.length];
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
      key = "escape";
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
      key = withMods(k, ["alt"]);
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

const UNBOUND = new Set(["tab", "shift+tab", "escape"]);

/** Bindings of keys to actions, read on a platform: `mod` is its. `resolve`
 * makes the one a field uses. */
export class Keymap {
  /** By key, canonical with `mod` read. */
  readonly bindings = new Map<string, string>();
  /** Each key's last binding as written, `mod` kept. */
  readonly written = new Map<string, string>();
  readonly multiline: boolean;
  readonly mod: Mod;
  constructor(multiline = false, mod: Mod = "ctrl") {
    this.multiline = multiline;
    this.mod = mod;
  }

  /** Binds a key, which may name `mod`, to an action. */
  bind(key: string, action: string) {
    const k = read(key, this.mod, false);
    if (k === null) return;
    this.bindings.set(k, action);
    this.written.set(k, read(key, this.mod, true)!);
  }

  /** Each key once, where it was first bound, as its last binding wrote
   * it, with its last action. */
  format(): string {
    return Array.from(this.bindings, ([k, a]) => `${this.written.get(k) ?? k}=${a}`).join(" ");
  }

  /** The action a key is bound to: its own binding, or for a key with
   * `shift` that is not a character and has none, the binding of the key
   * without it (SPEC §10.2). */
  action(name: string): string | undefined {
    const k = parseKey(name);
    if (k === null || UNBOUND.has(k)) return undefined;
    const a = this.bindings.get(k);
    if (a !== undefined) return a;
    const { mods, value, kind } = splitKey(k);
    if (!mods.includes("shift") || kind === "character") return undefined;
    return this.bindings.get(join(mods.filter((m) => m !== "shift"), value));
  }

  /** Whether the keymap binds the key, with the fallback of `action`. A
   * press with two names (SPEC §10.4) is asked of its physical key first:
   * what follows is of the first name that is bound. */
  binds(name: string): boolean {
    return this.action(name) !== undefined;
  }

  /** Whether the key is the program's (SPEC §10.2, *Keys for the
   * program*): bound to `program`, or to `prefix`, which is `program` and
   * more. It reaches the program before the focused element uses it and
   * before the surface scrolls with it. */
  program(name: string): boolean {
    const a = this.action(name);
    return a === "program" || a === "prefix";
  }

  /** Whether the key begins a prefix (SPEC §10.2, §10.5): bound to
   * `prefix`. Every key after it reaches the program too. */
  prefix(name: string): boolean {
    return this.action(name) === "prefix";
  }

  /** The scroll action the key is bound to, or null (SPEC §10.2,
   * *Scrolling keys*): outside a text field, a key the element does not
   * use scrolls with it. */
  scroll(name: string): string | null {
    const a = this.action(name);
    return a !== undefined && SCROLL_ACTIONS.has(a) ? a : null;
  }

  /** What the field does with a key: an action, `INSERT` for a key it types
   * (`keyText`), or null when the key is not the field's. */
  lookup(name: string): string | null {
    const k = parseKey(name);
    if (k === null || UNBOUND.has(k)) return null;
    const a = this.action(k);
    if (a !== undefined) return a === "program" || a === "prefix" || (MULTILINE_ACTIONS.has(a) && !this.multiline) ? null : a;
    return keyText(k) !== null ? INSERT : null;
  }

  /** Whether the field selects with a key (SPEC §10.2, *Shift selects*):
   * it looks up a move, and the key's name has `shift`. The field then
   * moves its caret and keeps the selection's anchor. */
  selects(name: string): boolean {
    const k = parseKey(name);
    if (k === null) return false;
    const a = this.lookup(k);
    return a !== null && MOVES.has(a) && splitKey(k).mods.includes("shift");
  }
}

/** A `data-keys` value's bindings in order, without those a host ignores. */
function* bindingsOf(mod: Mod, value: string): Generator<[string, string]> {
  // ASCII white space, as HTML splits space-separated tokens.
  for (const b of value.split(/[ \t\n\f\r]+/)) {
    const i = b.lastIndexOf("=");
    if (i < 0) continue;
    const key = b.slice(0, i);
    const k = read(key, mod, false);
    const a = b.slice(i + 1);
    if (k === null || !ACTIONS.has(a) || UNBOUND.has(k)) continue;
    yield [key, a];
  }
}

/** A `data-keys` value's bindings, without those a host ignores. `mod`
 * reads as the platform's: where it is `ctrl`, `mod+a` and `ctrl+a` are one
 * key. */
export function parseKeymap(p: Platform, value: string, multiline = false): Keymap {
  const m = new Keymap(multiline, p.mod);
  for (const [k, a] of bindingsOf(m.mod, value)) m.bind(k, a);
  return m;
}

/** A focused element's keymap outside a text field (SPEC §10.2, *Keys for
 * the program*): each `data-keys` value, the root's first, over no default.
 * Only its `program` and `prefix` bindings (`Keymap.program`,
 * `Keymap.prefix`) and its scroll actions (`Keymap.scroll`) count there: a
 * nearer binding of a key to another action cancels a farther one. */
export function elementKeymap(p: Platform, ...values: string[]): Keymap {
  const m = new Keymap(false, p.mod);
  for (const v of values) for (const [k, a] of bindingsOf(m.mod, v)) m.bind(k, a);
  return m;
}

/** The default keymap's keys on every host (SPEC §10.2); Enter, those of
 * the platform's `mod` and its edit shortcuts follow. */
const DEFAULT_KEYS = [
  ["arrow_left", "char-backward"],
  ["arrow_right", "char-forward"],
  ["alt+arrow_left", "word-backward"],
  ["alt+arrow_right", "word-forward"],
  ["home", "line-start"],
  ["end", "line-end"],
  ["backspace", "delete-char-backward"],
  ["delete", "delete-char-forward"],
  ["alt+backspace", "delete-word-backward"],
  ["alt+delete", "delete-word-forward"],
  ["arrow_up", "line-previous"],
  ["arrow_down", "line-next"],
  ["page_up", "page-up"],
  ["page_down", "page-down"],
] as const;

/** Where `mod` is `ctrl`. */
const CTRL_KEYS = [
  ["ctrl+arrow_left", "word-backward"],
  ["ctrl+arrow_right", "word-forward"],
  ["ctrl+home", "input-start"],
  ["ctrl+end", "input-end"],
  ["ctrl+backspace", "delete-word-backward"],
  ["ctrl+delete", "delete-word-forward"],
] as const;

/** Where `mod` is `super`: macOS's, with Emacs's ctrl keys. */
const SUPER_KEYS = [
  ["super+arrow_left", "line-start"],
  ["super+arrow_right", "line-end"],
  ["super+arrow_up", "input-start"],
  ["super+arrow_down", "input-end"],
  ["super+backspace", "delete-to-line-start"],
  ["ctrl+a", "line-start"],
  ["ctrl+e", "line-end"],
  ["ctrl+b", "char-backward"],
  ["ctrl+f", "char-forward"],
  ["ctrl+p", "line-previous"],
  ["ctrl+n", "line-next"],
  ["ctrl+h", "delete-char-backward"],
  ["ctrl+d", "delete-char-forward"],
  ["ctrl+k", "delete-to-line-end"],
] as const;

/** A field's keymap: SPEC §10.2's default for the platform's `mod`, with
 * its edit shortcuts, then each `data-keys` value, the root's first. A
 * binding to a scroll action is left out where it stands, in its own value
 * too: it neither acts nor overrides an earlier binding. */
export function resolve(p: Platform, multiline: boolean, ...values: string[]): Keymap {
  const m = new Keymap(multiline, p.mod);
  for (const [k, a] of DEFAULT_KEYS) m.bind(k, a);
  m.bind("enter", multiline ? "newline" : "submit");
  for (const [k, a] of m.mod === "super" ? SUPER_KEYS : CTRL_KEYS) m.bind(k, a);
  const edit = editOf(p);
  for (const a of EDIT_ACTIONS) for (const k of edit[a] ?? []) m.bind(k, a);
  for (const v of values) for (const [k, a] of bindingsOf(m.mod, v)) if (!SCROLL_ACTIONS.has(a)) m.bind(k, a);
  return m;
}

// --- Actions on a value (§10.2) ----------------------------------------------

/** A field's text and selection, in characters (`start` = `end` when it is
 * a caret). `caret` is the selection's end the caret is at, its start or
 * its end; the other is its anchor. */
export interface Text {
  chars: string[];
  start: number;
  end: number;
  caret: number;
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

/** What an action does to a field: move its caret, to `to`, selecting
 * from `anchor` when it has one; replace a part of it (the caret then after
 * the text); or nothing it can do itself. */
export type Plan =
  | { kind: "move"; to: number; anchor?: number; goal?: number }
  | { kind: "replace"; from: number; to: number; text: string }
  | { kind: "none" };

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
 * under way, if any. With `extend`, a move is Shift's: it goes from the
 * caret, and the selection keeps its anchor. */
export function plan(t: Text, action: string, rows: Rows | null, goal: number | null = null, extend = false): Plan {
  if (MULTILINE_ACTIONS.has(action) && !t.multiline) return { kind: "none" };
  const n = t.chars.length;
  const selected = t.start < t.end;
  if (action === "select-all") return { kind: "move", anchor: 0, to: n };
  if (extend && MOVES.has(action)) {
    const anchor = t.caret === t.start ? t.end : t.start;
    const moved = plan({ ...t, start: t.caret, end: t.caret }, action, rows, goal);
    return moved.kind === "move" ? { ...moved, anchor } : moved;
  }
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

/** A text field's value, caret and selection (SDK.md §4.6), as the
 * conformance vectors' edit section has one. The selection runs from
 * `anchor` to the caret; nothing is selected when it is undefined or at the
 * caret. */
export class Field {
  value: string;
  caret: number;
  anchor: number | undefined;
  readonly multiline: boolean;
  readonly password: boolean;
  readonly rows: number;
  private goal: number | null = null;
  constructor(value: string, caret: number, multiline = false, password = false, rows = 1, anchor?: number) {
    this.value = value;
    this.caret = caret;
    this.multiline = multiline;
    this.password = password;
    this.rows = rows;
    this.anchor = anchor;
  }

  private text(): Text {
    const c = chars(this.value);
    const p = Math.min(Math.max(this.caret, 0), c.length);
    const a = this.anchor === undefined ? p : Math.min(Math.max(this.anchor, 0), c.length);
    return { chars: c, start: Math.min(a, p), end: Math.max(a, p), caret: p, multiline: this.multiline, password: this.password };
  }

  /** Selects from `anchor` to `caret`; equal, nothing is selected. It ends
   * a run of row moves. */
  select(anchor: number, caret: number) {
    this.goal = null;
    this.caret = caret;
    this.anchor = anchor === caret ? undefined : anchor;
  }

  /** Does an action; whether the value changed. */
  do(action: string): boolean {
    return this.act(action, false);
  }

  /** Does a move as Shift does: the caret moves from where it is, and the
   * selection keeps its anchor. Another action is `do`'s. */
  extend(action: string): boolean {
    return this.act(action, true);
  }

  private act(action: string, extend: boolean): boolean {
    const t = this.text();
    const goal = ROW_ACTIONS.has(action) ? this.goal : null;
    const p = plan(t, action, lineRows(t, this.rows), goal, extend);
    this.goal = p.kind === "move" && p.goal !== undefined ? p.goal : null;
    return this.apply(t, p);
  }

  /** Types text in place of the selection; whether the value changed. */
  type(text: string): boolean {
    this.goal = null;
    if (!text) return false;
    const t = this.text();
    return this.apply(t, { kind: "replace", from: t.start, to: t.end, text });
  }

  private apply(t: Text, p: Plan): boolean {
    if (p.kind === "move") {
      this.caret = p.to;
      this.anchor = p.anchor === undefined || p.anchor === p.to ? undefined : p.anchor;
    }
    if (p.kind !== "replace") return false;
    const before = t.chars.slice(0, p.from).join("") + p.text;
    this.value = before + t.chars.slice(p.to).join("");
    this.caret = chars(before).length;
    this.anchor = undefined;
    return true;
  }
}
