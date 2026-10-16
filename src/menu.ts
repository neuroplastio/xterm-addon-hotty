// A program's menu (SPEC §10.7): the tree of its actions it sends with
// `a=menu`, read from its msgpack body, the level of it to show, and the
// rows of the palette. The addon draws them (addon.ts).

import { read } from "./msgpack.ts";

/** The deepest an item nests (SPEC §10.7): the top level's are one deep. */
export const MENU_DEPTH = 8;

/** The program's menu: what it is for, and its items in order. */
export interface Menu {
  label: string;
  items: MenuItem[];
}

/** An item as the program sent it. A group has `items`. */
export interface MenuItem {
  key: string;
  label: string;
  name: string;
  enabled: boolean;
  items: MenuItem[] | undefined;
}

/** How a host reads a key name against a typed one (SPEC §10.4): `Mod` read
 * as the host's mod, null when the name does not parse. */
export type ReadKey = (name: string) => string | null;

/** A program's menu from its msgpack body; throws on a body that does not
 * decode, is not a menu, has a field of another type, or nests past
 * `MENU_DEPTH`. Fields it does not know are left alone. */
export function readMenu(bytes: Uint8Array): Menu {
  const v = read(bytes);
  if (!isMap(v)) throw new Error("a menu is a map");
  const label = str(v.label, "a menu's label");
  return { label, items: items(v.items, 1) };
}

function items(v: unknown, depth: number): MenuItem[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error("items are an array");
  if (depth > MENU_DEPTH && v.length) throw new Error(`a menu nests at most ${MENU_DEPTH} deep`);
  return v.map((i): MenuItem => {
    if (!isMap(i)) throw new Error("a menu item is a map");
    if (i.enabled !== undefined && typeof i.enabled !== "boolean") throw new Error("an item's enabled is a bool");
    return {
      key: str(i.key, "an item's key"),
      label: str(i.label, "an item's label"),
      name: str(i.name, "an item's name"),
      enabled: i.enabled === true,
      items: i.items === undefined ? undefined : items(i.items, depth + 1),
    };
  });
}

/** The keys typed so far, from a `show=1` body (SPEC §10.7): `{"seq":
 * [str]}`; none for no body. */
export function readSeq(bytes: Uint8Array): string[] {
  if (!bytes.length) return [];
  const v = read(bytes);
  if (!isMap(v)) throw new Error("a show is a map");
  const seq = v.seq === undefined ? [] : v.seq;
  if (!Array.isArray(seq) || !seq.every((k) => typeof k === "string")) throw new Error("a show's seq is an array of str");
  return seq as string[];
}

/** The level `seq` reaches: at each level the first group whose key is the
 * key typed. Its label is the last group's, or the menu's at the top; null
 * when the keys reach no group. */
export function reach(menu: Menu, seq: string[], readKey: ReadKey): { label: string; items: MenuItem[] } | null {
  let label = menu.label;
  let level = menu.items;
  for (const typed of seq) {
    const k = readKey(typed);
    const next = k === null ? undefined : level.find((i) => isGroup(i) && i.key !== "" && readKey(i.key) === k);
    if (!next) return null;
    label = next.label;
    level = next.items!;
  }
  return { label, items: level };
}

/** The level to show for `seq`: its items that have a key, in order; null
 * when none does, or the keys reach no group. */
export function shownLevel(menu: Menu, seq: string[], readKey: ReadKey): { label: string; items: MenuItem[] } | null {
  const level = reach(menu, seq, readKey);
  const keyed = level?.items.filter((i) => i.key !== "");
  return level && keyed!.length ? { label: level.label, items: keyed! } : null;
}

/** Whether a typed key leaves the level shown up: only Escape, and a key
 * the level does not list, hide it (SPEC §10.7). */
export function hides(items: MenuItem[], typed: string, readKey: ReadKey): boolean {
  const k = readKey(typed);
  return k === null || k === "Escape" || !items.some((i) => i.key !== "" && readKey(i.key) === k);
}

/** Whether an item is a group: it has at least one item (SPEC §10.7). */
export const isGroup = (i: MenuItem): boolean => i.items !== undefined && i.items.length > 0;

/** The first item named `name` in depth-first order, or null. */
export function find(menu: Menu, name: string): MenuItem | null {
  if (name === "") return null;
  const walk = (level: MenuItem[]): MenuItem | null => {
    for (const i of level) {
      if (i.name === name) return i;
      const inner = i.items && walk(i.items);
      if (inner) return inner;
    }
    return null;
  };
  return walk(menu.items);
}

/** A row of the palette: an item that has a name. */
export interface Row {
  item: MenuItem;
  /** The labels of its groups, then its own (its name where it has none). */
  path: string[];
  /** The keys that reach it, space-separated and read; empty where an item
   * on its path has none. */
  keys: string;
}

/** The palette's rows (SPEC §10.7): every item that has a name, depth-first,
 * under its groups' labels, with the keys that reach it if each item on its
 * path has one, as `shown` writes a key. */
export function rows(menu: Menu, shown: (key: string) => string): Row[] {
  const out: Row[] = [];
  const walk = (level: MenuItem[], path: string[], keys: string[] | null) => {
    for (const i of level) {
      const here = [...path, i.label || i.name || i.key];
      const reached = keys && i.key !== "" ? [...keys, shown(i.key)] : null;
      if (i.name !== "") out.push({ item: i, path: here, keys: reached ? reached.join(" ") : "" });
      if (i.items) walk(i.items, here, reached);
    }
  };
  walk(menu.items, [], []);
  return out;
}

/** A row's label as the palette shows it. */
export const rowLabel = (r: Row) => r.path.join(" › ");

/** The rows that match `text`: each space-separated word is a
 * case-insensitive substring of the row's label path or its name. */
export function filter(all: Row[], text: string): Row[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((r) => {
    const label = rowLabel(r).toLowerCase();
    const name = r.item.name.toLowerCase();
    return words.every((w) => label.includes(w) || name.includes(w));
  });
}

/** The menus a host keeps (SPEC §10.7): one for each screen. Leaving the
 * alternate screen drops its menu; the main one's stays. */
export class Menus {
  normal: Menu | null = null;
  alternate: Menu | null = null;

  get(screen: "normal" | "alternate"): Menu | null {
    return this[screen];
  }

  set(screen: "normal" | "alternate", menu: Menu | null) {
    this[screen] = menu;
  }

  /** The screen changed to `screen`. */
  change(screen: "normal" | "alternate") {
    if (screen === "normal") this.alternate = null;
  }

  /** A full reset. */
  clear() {
    this.normal = this.alternate = null;
  }
}

const str = (v: unknown, what: string): string => {
  if (v !== undefined && typeof v !== "string") throw new Error(`${what} is a str`);
  return v ?? "";
};

const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === null;
