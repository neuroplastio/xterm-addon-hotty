// Key sequences (SPEC §10.5): the elements with a `data-key`, which of them
// the keys typed reach, as myelin's rules have it, and the which-key menu of
// the keys that can follow them. The menu a program sends (§10.6) is read
// here too, and both are drawn by the addon (addon.ts).

import { type Platform, parseSequence } from "./keys.ts";

/** A which-key level (SPEC §10.6): the keys typed, their group's label, and
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

/** An element's sequence: the keys of the nearest element around it with
 * one, then its own. `group`: elements with sequences are inside it, and
 * its sequence leads to theirs and does nothing itself. */
export interface Seq {
  el: Element;
  keys: string[];
  group: boolean;
}

/** The elements with a `data-key` a host reads, in tree order, each with its
 * whole sequence. A value the host ignores is as if absent: the elements
 * inside it go on from the one around it. */
export function sequences(doc: Document, p: Platform, leader: string): Seq[] {
  const out: Seq[] = [];
  const by = new Map<Element, Seq>();
  for (const el of Array.from(doc.querySelectorAll("[data-key]"))) {
    const own = parseSequence(p, leader, el.getAttribute("data-key") ?? "");
    if (!own) continue;
    let around: Seq | undefined;
    for (let n = el.parentElement; n && !around; n = n.parentElement) around = by.get(n);
    if (around) around.group = true;
    const s = { el, keys: [...(around?.keys ?? []), ...own], group: false };
    by.set(el, s);
    out.push(s);
  }
  return out;
}

/** How near the focused element each element is (SPEC §10.5): the depth of
 * its nearest common ancestor with it, the root's 0. Without a focused
 * element, every element is as near as any. */
export class Nearness {
  /** The focused element and its ancestors, the root last. */
  private readonly chain: Element[] = [];
  constructor(focused: Element | null) {
    for (let n = focused; n; n = n.parentElement) this.chain.push(n);
  }

  of(el: Element): number {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const i = this.chain.indexOf(n);
      if (i >= 0) return this.chain.length - 1 - i;
    }
    return 0;
  }
}

/** What the keys typed do (SPEC §10.5): finish the sequence of an element,
 * which runs; wait for the next key, as a longer one goes on from them; or
 * nothing, as none finishes or goes on. */
export type Step = { run: Element } | "wait" | "dead";

const same = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
const startsWith = (a: string[], b: string[]) => a.length >= b.length && b.every((k, i) => k === a[i]);

/** The element whose sequence `typed` finishes: the one nearest the focus,
 * and of those the last in tree order. */
export function finished(seqs: Seq[], near: Nearness, typed: string[]): Element | null {
  let best: [number, Element] | null = null;
  for (const s of seqs) {
    if (s.group || !same(s.keys, typed)) continue;
    const n = near.of(s.el);
    if (!best || n >= best[0]) best = [n, s.el];
  }
  return best?.[1] ?? null;
}

/** What `typed` does: it runs the element whose sequence it finishes,
 * unless a longer sequence at least as near goes on from it; with none
 * finished, it waits if any does. */
export function step(seqs: Seq[], near: Nearness, typed: string[]): Step {
  const longer = seqs.filter((s) => !s.group && s.keys.length > typed.length && startsWith(s.keys, typed));
  const el = finished(seqs, near, typed);
  if (el) return longer.some((s) => near.of(s.el) >= near.of(el)) ? "wait" : { run: el };
  return longer.length ? "wait" : "dead";
}

/** The which-key menu while `typed` waits: each key that can follow it, in
 * tree order, labelled by the element its sequence there finishes (the
 * nearest), or by its group's `aria-label`. */
export function menu(seqs: Seq[], near: Nearness, typed: string[]): Menu {
  const n = typed.length;
  const label = seqs.filter((s) => s.group && same(s.keys, typed)).map((s) => ariaLabel(s.el)).find((l) => l) ?? "";
  const items: MenuItem[] = [];
  for (const s of seqs) {
    if (s.group || s.keys.length <= n || !startsWith(s.keys, typed)) continue;
    const key = s.keys[n]!;
    if (items.some((i) => i.key === key)) continue;
    const next = s.keys.slice(0, n + 1);
    const under = seqs.filter((t) => !t.group && startsWith(t.keys, next));
    const own = finished(seqs, near, next);
    items.push({
      key,
      label: own
        ? elementLabel(own)
        : (seqs.filter((t) => t.group && same(t.keys, next)).map((t) => ariaLabel(t.el)).find((l) => l) ?? `+${under.length}`),
      group: under.some((t) => t.keys.length > n + 1),
      enabled: own ? !disabled(own) : under.some((t) => !disabled(t.el)),
    });
  }
  return { seq: typed.slice(), label, items };
}

const collapse = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** An element's `aria-label`, when it has one that is not blank. */
function ariaLabel(el: Element): string {
  return collapse(el.getAttribute("aria-label") ?? "");
}

/** What a menu calls an element: its `aria-label`, or else its text, with
 * its white space collapsed. */
function elementLabel(el: Element): string {
  return ariaLabel(el) || collapse(el.textContent ?? "");
}

/** Whether an element is disabled: its sequence does nothing. */
export function disabled(el: Element): boolean {
  try {
    return el.matches(":disabled");
  } catch {
    return false;
  }
}

/** Whether a click activates an element (SPEC §10.5): a `button`, a link, a
 * `summary`, a checkbox or radio button, an `input` of type `button`,
 * `submit` or `reset`, or one with `data-on~=click`. */
export function clickActivated(el: Element): boolean {
  if ((el.getAttribute("data-on") ?? "").split(/\s+/).includes("click")) return true;
  switch (el.localName) {
    case "button":
    case "summary":
      return true;
    case "a":
      return el.hasAttribute("href");
    case "input":
      return ["button", "submit", "reset", "checkbox", "radio"].includes((el.getAttribute("type") ?? "").toLowerCase());
    default:
      return false;
  }
}

/** A program's menu (SPEC §10.6) from its msgpack body; throws on one that
 * is not a menu. Fields it does not know are left alone. */
export function readMenu(bytes: Uint8Array): Menu {
  const v = new Reader(bytes).value(0);
  if (!isMap(v)) throw new Error("a menu is a map");
  const strs = (x: unknown) => (Array.isArray(x) && x.every((k) => typeof k === "string") ? (x as string[]) : null);
  const seq = v.seq === undefined ? [] : strs(v.seq);
  if (!seq) throw new Error("a menu's seq is an array of str");
  if (v.label !== undefined && typeof v.label !== "string") throw new Error("a menu's label is a str");
  if (v.items !== undefined && !Array.isArray(v.items)) throw new Error("a menu's items are an array");
  const items = ((v.items ?? []) as unknown[]).map((i): MenuItem => {
    if (!isMap(i) || typeof i.key !== "string") throw new Error("a menu item is a map with a key");
    return { key: i.key, label: typeof i.label === "string" ? i.label : "", group: i.group === true, enabled: i.enabled !== false };
  });
  return { seq, label: (v.label as string | undefined) ?? "", items };
}

const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The deepest a menu nests. */
const MAX_DEPTH = 8;

/** Reads the msgpack a menu is: maps with str keys, arrays, str, bool, nil
 * and numbers. Its input is a message's payload, which the wire caps. */
class Reader {
  private at = 0;
  private readonly b: Uint8Array;
  private readonly view: DataView;
  constructor(b: Uint8Array) {
    this.b = b;
    this.view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }

  value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error("a menu nests too deep");
    const c = this.u(1);
    if (c < 0x80) return c;
    if (c >= 0xe0) return c - 0x100;
    if ((c & 0xf0) === 0x80) return this.map(c & 0x0f, depth);
    if ((c & 0xf0) === 0x90) return this.array(c & 0x0f, depth);
    if ((c & 0xe0) === 0xa0) return this.str(c & 0x1f);
    switch (c) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xca:
        return this.view.getFloat32(this.skip(4));
      case 0xcb:
        return this.view.getFloat64(this.skip(8));
      case 0xcc:
        return this.u(1);
      case 0xcd:
        return this.u(2);
      case 0xce:
        return this.u(4);
      case 0xcf:
        return Number(this.view.getBigUint64(this.skip(8)));
      case 0xd0:
        return this.view.getInt8(this.skip(1));
      case 0xd1:
        return this.view.getInt16(this.skip(2));
      case 0xd2:
        return this.view.getInt32(this.skip(4));
      case 0xd3:
        return Number(this.view.getBigInt64(this.skip(8)));
      case 0xd9:
        return this.str(this.u(1));
      case 0xda:
        return this.str(this.u(2));
      case 0xdb:
        return this.str(this.u(4));
      case 0xdc:
        return this.array(this.u(2), depth);
      case 0xdd:
        return this.array(this.u(4), depth);
      case 0xde:
        return this.map(this.u(2), depth);
      case 0xdf:
        return this.map(this.u(4), depth);
      default:
        throw new Error(`no menu holds msgpack 0x${c.toString(16)}`);
    }
  }

  private map(n: number, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null);
    for (let i = 0; i < n; i++) {
      const k = this.value(depth + 1);
      if (typeof k !== "string") throw new Error("a menu's keys are str");
      out[k] = this.value(depth + 1);
    }
    return out;
  }

  private array(n: number, depth: number): unknown[] {
    // Each element takes a byte at least: a count past what is left lies.
    if (n > this.b.length - this.at) throw new Error("a short menu");
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(this.value(depth + 1));
    return out;
  }

  private str(n: number): string {
    const at = this.skip(n);
    return new TextDecoder().decode(this.b.subarray(at, at + n));
  }

  private u(n: 1 | 2 | 4): number {
    const at = this.skip(n);
    return n === 1 ? this.view.getUint8(at) : n === 2 ? this.view.getUint16(at) : this.view.getUint32(at);
  }

  /** Moves past `n` bytes, and gives where they start. */
  private skip(n: number): number {
    const at = this.at;
    if (at + n > this.b.length) throw new Error("a short menu");
    this.at = at + n;
    return at;
  }
}
