// A program's menu (SPEC §10.5): the which-key level it sends with `a=menu`,
// read from its msgpack body. The addon draws it (addon.ts).

import { read } from "./msgpack.ts";

/** A which-key level (SPEC §10.5): the keys typed, their group's label, and
 * each key that can follow them. */
export interface Menu {
  seq: string[];
  label: string;
  items: MenuItem[];
}

export interface MenuItem {
  key: string;
  label: string;
  group: boolean;
  enabled: boolean;
}

/** A program's menu from its msgpack body; throws on a body that does not
 * decode or is not a menu. Fields it does not know are left alone. */
export function readMenu(bytes: Uint8Array): Menu {
  const v = read(bytes);
  if (!isMap(v)) throw new Error("a menu is a map");
  const seq = v.seq === undefined ? [] : v.seq;
  if (!Array.isArray(seq) || !seq.every((k) => typeof k === "string")) throw new Error("a menu's seq is an array of str");
  if (v.label !== undefined && typeof v.label !== "string") throw new Error("a menu's label is a str");
  if (v.items !== undefined && !Array.isArray(v.items)) throw new Error("a menu's items are an array");
  const items = ((v.items ?? []) as unknown[]).map((i): MenuItem => {
    if (!isMap(i) || typeof i.key !== "string") throw new Error("a menu item is a map with a key");
    return { key: i.key, label: typeof i.label === "string" ? i.label : "", group: i.group === true, enabled: i.enabled !== false };
  });
  return { seq: seq as string[], label: (v.label as string | undefined) ?? "", items };
}

const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === null;
