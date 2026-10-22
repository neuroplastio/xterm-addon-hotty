// Deltas (SPEC §6): operations on one surface's document, addressed by
// element id, and the morph that keeps element identity.
//
// SPEC §6's rules (as hotty-blitz implements them), for the browser's DOM:
// fragments parse inert in a <template>, which also accepts table rows and
// list items without a context element; only what the morph keeps or inserts
// reaches the live document, and a focused control keeps what the user typed.

import { read } from "./msgpack.ts";
import type { Resolver } from "./resolver.ts";

/** An error of a delta (SPEC §3.6): its code, the detail, and, where one op
 * is at fault, its index `i` (§6.1). */
export class DeltaError extends Error {
  readonly code: string;
  readonly i: number | undefined;
  constructor(code: string, detail: string, i?: number) {
    super(detail);
    this.code = code;
    this.i = i;
  }
}

/** One op of a delta (SPEC §6.1), its fields as the body gave them. */
export interface Op {
  op: string;
  t?: string;
  k?: string;
  v?: string;
}

const OPS = new Set(["morph", "inner", "replace", "append", "prepend", "before", "after", "remove", "attr", "unattr", "text", "var", "reveal"]);

/** The ops that name a key `k`. */
const KEYED = new Set(["attr", "unattr", "var"]);

/**
 * A delta's ops from its body (SPEC §6.1), the whole of it checked before
 * any is applied. `EINVAL` where the body does not decode (§3.3), is not a
 * map with a list of ops, or has none; where an op is not a map or names an
 * op the table does not have; where `t` is missing (every op but `morph`
 * needs one), or `k` for `attr`, `unattr` and `var`; or where `reveal` has
 * a `v` other than `start` or `end`. The error names the first op at fault
 * by its index. A field an op does not take is ignored, whatever its type,
 * as is a key of an op that the table does not name.
 */
export function readDelta(bytes: Uint8Array): Op[] {
  let body: unknown;
  try {
    body = read(bytes);
  } catch (e) {
    throw new DeltaError("EINVAL", `the delta does not decode: ${(e as Error).message}`);
  }
  const list = isMap(body) ? body.ops : undefined;
  if (!Array.isArray(list)) throw new DeltaError("EINVAL", "a delta is a map with a list of ops");
  if (list.length === 0) throw new DeltaError("EINVAL", "a delta has no ops");
  return list.map((o, i) => {
    const bad = (why: string) => new DeltaError("EINVAL", `op ${i}: ${why}`, i);
    if (!isMap(o)) throw bad("not a map");
    const op = o.op;
    if (typeof op !== "string" || !OPS.has(op)) throw bad(`unknown op ${JSON.stringify(op)}`);
    // t, k and v are strs, whether the op takes them or not; an empty id
    // or name is none.
    const field = (name: string, need: boolean): string | undefined => {
      const x = o[name];
      if (x !== undefined && typeof x !== "string") throw bad(`${name} is not a str`);
      if (need && !x) throw bad(`op=${op} needs ${name}`);
      return x;
    };
    const t = field("t", op !== "morph") || undefined;
    const k = field("k", KEYED.has(op));
    const v = field("v", false);
    if (op === "reveal" && v !== undefined && v !== "start" && v !== "end") throw bad(`op=reveal takes start, end or nothing, not ${JSON.stringify(v)}`);
    return { op, t, k: KEYED.has(op) ? k : undefined, v: op === "remove" || op === "unattr" ? undefined : v };
  });
}

const isMap = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x) && !(x instanceof Uint8Array) && Object.getPrototypeOf(x) === null;

/** Where `reveal` puts its target in each box that holds it (SPEC §6.1):
 * its top at the top, its bottom at the bottom, or "" for the nearest. */
export type Reveal = "start" | "end" | "";

export class Deltas {
  private readonly doc: Document;
  private readonly resolver: Resolver;
  /** Scrolls an element into view: the surface's to do (`reveal`). */
  private readonly revealer: (el: Element, where: Reveal) => void;
  /** Hears that the delta set a control's value: the surface puts a text
   * field's caret at the end (SPEC §6.2). */
  private readonly valued: (el: Element) => void;

  constructor(doc: Document, resolver: Resolver, revealer: (el: Element, where: Reveal) => void, valued: (el: Element) => void = () => {}) {
    this.doc = doc;
    this.resolver = resolver;
    this.revealer = revealer;
    this.valued = valued;
  }

  /** A changed attribute's property, as `syncProperty`, told to `valued`
   * when it set the value. */
  private sync(el: Element, name: string, value: string | null, focused: boolean) {
    if (syncProperty(el, name, value, focused)) this.valued(el);
  }

  /** Parses a fragment inert, cleaned and resolved. */
  parse(html: string): Node[] {
    const t = this.doc.createElement("template");
    t.innerHTML = html;
    this.resolver.adopt(t.content);
    return Array.from(t.content.childNodes);
  }

  /**
   * Applies the ops in order, as one unit (SPEC §6.1). An op whose target
   * is missing changes nothing and the ops after it still apply; the first
   * op that failed is returned, named by its index.
   */
  apply(ops: Op[]): DeltaError | null {
    let failed: DeltaError | null = null;
    ops.forEach((o, i) => {
      try {
        this.applyOp(o.op, o.t, o.k, o.v ?? "");
      } catch (e) {
        failed ??= e instanceof DeltaError ? new DeltaError(e.code, e.message, i) : new DeltaError("EINVAL", e instanceof Error ? e.message : String(e), i);
      }
    });
    return failed;
  }

  private applyOp(op: string, target: string | undefined, key: string | undefined, payload: string): void {
    const find = (): Element => {
      const el = target ? this.doc.getElementById(target) : null;
      if (!el) throw new DeltaError("ENOTARGET", target ?? "");
      return el;
    };
    switch (op) {
      case "morph": {
        if (target === undefined) {
          const missing: string[] = [];
          for (const k of this.parse(payload)) {
            if (k.nodeType !== 1) continue;
            const id = (k as Element).getAttribute("id");
            const old = id ? this.doc.getElementById(id) : null;
            if (old) this.morphNode(old, k);
            else missing.push(id ?? "(element without id)");
          }
          if (missing.length) throw new DeltaError("ENOTARGET", missing.join(","));
          return;
        }
        const t = find();
        const frag = this.parse(payload);
        const elements = frag.filter((n) => n.nodeType === 1);
        if (elements.length === 1) {
          this.morphNode(t, elements[0]!);
        } else {
          t.before(...frag);
          t.remove();
        }
        return;
      }
      case "inner":
        this.morphChildren(find(), this.parse(payload));
        return;
      case "replace": {
        const t = find();
        t.before(...this.parse(payload));
        t.remove();
        return;
      }
      case "append":
      case "prepend": {
        const t = find();
        const fresh: Node[] = [];
        // As Turbo: a child with the same id is morphed in place, not duplicated.
        for (const k of this.parse(payload)) {
          const id = k.nodeType === 1 ? (k as Element).getAttribute("id") : null;
          const old = id ? this.doc.getElementById(id) : null;
          if (old && old.parentNode === t) this.morphNode(old, k);
          else fresh.push(k);
        }
        if (op === "append") t.append(...fresh);
        else t.prepend(...fresh);
        return;
      }
      case "before":
        find().before(...this.parse(payload));
        return;
      case "after":
        find().after(...this.parse(payload));
        return;
      case "remove":
        find().remove();
        return;
      case "attr": {
        const t = find();
        const name = key!;
        this.resolver.set(t, name, payload);
        this.sync(t, name, payload, this.doc.activeElement === t);
        return;
      }
      case "unattr": {
        const t = find();
        const name = key!;
        this.resolver.remove(t, name);
        this.sync(t, name, null, this.doc.activeElement === t);
        return;
      }
      case "text": {
        const t = find();
        if (t.localName === "style") this.resolver.setCss(t, payload);
        else if (t.childNodes.length === 1 && t.firstChild!.nodeType === 3) (t.firstChild as Text).data = payload;
        else t.textContent = payload;
        return;
      }
      case "var": {
        const t = find();
        const k = key!;
        const name = k.startsWith("--") ? k : `--${k}`;
        (t as HTMLElement).style?.setProperty(name, payload);
        return;
      }
      case "reveal": {
        // It changes no node (SPEC §6.1). The value is exact: `START` is
        // another value, and was refused with the rest (`readDelta`).
        this.revealer(find(), payload as Reveal);
        return;
      }
      default:
        throw new DeltaError("EINVAL", `unknown op=${op}`);
    }
  }

  /** Makes `old` (live) look like `neu` (parsed), keeping `old` where possible. Returns the node now in place. */
  morphNode(old: Node, neu: Node): Node {
    if (old.nodeType === 3 && neu.nodeType === 3) {
      if ((old as Text).data !== (neu as Text).data) (old as Text).data = (neu as Text).data;
      return old;
    }
    if (old.nodeType === 8 && neu.nodeType === 8) return old;
    if (old.nodeType === 1 && neu.nodeType === 1) {
      const a = old as Element;
      const b = neu as Element;
      const ia = a.getAttribute("id");
      const ib = b.getAttribute("id");
      if (a.localName === b.localName && a.namespaceURI === b.namespaceURI && (ia === ib || ia === null || ib === null)) {
        this.syncAttributes(a, b);
        if (a.localName === "style") {
          const css = this.resolver.cssOf(b);
          if (this.resolver.cssOf(a) !== css) this.resolver.setCss(a, css);
        } else {
          const kids = a.localName === "template" ? (b as HTMLTemplateElement).content.childNodes : b.childNodes;
          this.morphChildren(a.localName === "template" ? (a as HTMLTemplateElement).content : a, Array.from(kids));
        }
        return a;
      }
    }
    (old as ChildNode).replaceWith(neu);
    return neu;
  }

  private syncAttributes(old: Element, neu: Element) {
    const oldAttrs = this.resolver.attributes(old);
    const newAttrs = this.resolver.attributes(neu);
    // A control the user is editing keeps what they typed (idiomorph does the same).
    const focused = this.doc.activeElement === old;
    for (const [name, value] of newAttrs) {
      if (focused && name === "value") continue;
      const had = oldAttrs.find(([n]) => n === name);
      if (!had || had[1] !== value) {
        this.resolver.set(old, name, value);
        this.sync(old, name, value, focused);
      }
    }
    for (const [name] of oldAttrs) {
      if (!newAttrs.some(([n]) => n === name)) {
        this.resolver.remove(old, name);
        this.sync(old, name, null, focused);
      }
    }
  }

  /** Morphs the children of `parent` (live) into `kids` (parsed). */
  morphChildren(parent: Node, kids: Node[]): void {
    const oldKids = Array.from(parent.childNodes);
    const idOf = (n: Node) => (n.nodeType === 1 ? (n as Element).getAttribute("id") : null);
    const newIds = new Set(kids.map(idOf).filter((x): x is string => x !== null));
    const used = new Set<Node>();
    const plan: [Node | null, Node][] = [];
    let cursor = 0;
    for (const nk of kids) {
      const id = idOf(nk);
      let match: Node | null = null;
      if (id !== null) {
        match = oldKids.find((ok) => !used.has(ok) && idOf(ok) === id) ?? null;
      } else {
        // Positional match on the same kind of node, skipping old children
        // whose id the new list still wants.
        for (let i = cursor; i < oldKids.length; i++) {
          const ok = oldKids[i]!;
          if (used.has(ok)) continue;
          const okId = idOf(ok);
          let same = false;
          if (okId !== null && newIds.has(okId)) same = false;
          else if (ok.nodeType === 1 && nk.nodeType === 1)
            same = okId === null && (ok as Element).localName === (nk as Element).localName && (ok as Element).namespaceURI === (nk as Element).namespaceURI;
          else same = ok.nodeType === nk.nodeType && (ok.nodeType === 3 || ok.nodeType === 8);
          if (same) {
            match = ok;
            cursor = i + 1;
            break;
          }
        }
      }
      if (match) used.add(match);
      plan.push([match, nk]);
    }
    for (const ok of oldKids) if (!used.has(ok)) (ok as ChildNode).remove();
    // Morph the kept nodes, insert the new ones, and put everything in order,
    // moving (not recreating) the kept ones.
    plan.forEach(([keep, nk], i) => {
      const want = keep ? this.morphNode(keep, nk) : nk;
      const current = parent.childNodes[i] ?? null;
      if (current !== want) move(parent, want, current);
    });
  }
}

/** Moves a node, keeping focus and state where the browser can (`moveBefore`). */
function move(parent: Node, node: Node, before: Node | null) {
  const p = parent as Node & { moveBefore?: (n: Node, r: Node | null) => void };
  if (node.parentNode === parent && typeof p.moveBefore === "function") {
    try {
      p.moveBefore(node, before);
      return;
    } catch {
      /* fall through */
    }
  }
  parent.insertBefore(node, before);
}

/**
 * Attributes that only set a control's *default*: the program's value is the
 * live one unless the user is editing that control (SPEC §6.2). Whether it
 * set the value.
 */
function syncProperty(el: Element, name: string, value: string | null, focused: boolean): boolean {
  if (focused) return false;
  const n = name.toLowerCase();
  if (n === "value" && "value" in el && (el.localName === "input" || el.localName === "textarea" || el.localName === "select")) {
    (el as HTMLInputElement).value = value ?? "";
    return true;
  } else if (n === "checked" && el.localName === "input") {
    (el as HTMLInputElement).checked = value !== null;
  } else if (n === "selected" && el.localName === "option") {
    (el as HTMLOptionElement).selected = value !== null;
  }
  return false;
}
