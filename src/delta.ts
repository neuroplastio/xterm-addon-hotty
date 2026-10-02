// Deltas (SPEC §6): operations on one surface's document, addressed by
// element id, and the morph that keeps element identity.
//
// SPEC §6's rules (as hotty-blitz implements them), for the browser's DOM:
// fragments parse inert in a <template>, which also accepts table rows and
// list items without a context element; only what the morph keeps or inserts
// reaches the live document, and a focused control keeps what the user typed.

import type { Resolver } from "./resolver.ts";

export class DeltaError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.code = code;
  }
}

export const OPS = ["morph", "inner", "replace", "append", "prepend", "before", "after", "remove", "attr", "unattr", "text", "var"];

export class Deltas {
  private readonly doc: Document;
  private readonly resolver: Resolver;

  constructor(doc: Document, resolver: Resolver) {
    this.doc = doc;
    this.resolver = resolver;
  }

  /** Parses a fragment inert, cleaned and resolved. */
  parse(html: string): Node[] {
    const t = this.doc.createElement("template");
    t.innerHTML = html;
    this.resolver.adopt(t.content);
    return Array.from(t.content.childNodes);
  }

  apply(op: string, target: string | undefined, key: string | undefined, payload: string): void {
    const find = (): Element => {
      if (!target) throw new DeltaError("EINVAL", `op=${op} needs t=<element id>`);
      const el = this.doc.getElementById(target);
      if (!el) throw new DeltaError("ENOTARGET", target);
      return el;
    };
    const needKey = (): string => {
      if (!key) throw new DeltaError("EINVAL", `op=${op} needs k=<name>`);
      return key;
    };
    switch (op) {
      case "":
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
        const name = needKey();
        this.resolver.set(t, name, payload);
        syncProperty(t, name, payload, this.doc.activeElement === t);
        return;
      }
      case "unattr": {
        const t = find();
        const name = needKey();
        this.resolver.remove(t, name);
        syncProperty(t, name, null, this.doc.activeElement === t);
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
        const k = needKey();
        const name = k.startsWith("--") ? k : `--${k}`;
        (t as HTMLElement).style?.setProperty(name, payload);
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
        syncProperty(old, name, value, focused);
      }
    }
    for (const [name] of oldAttrs) {
      if (!newAttrs.some(([n]) => n === name)) {
        this.resolver.remove(old, name);
        syncProperty(old, name, null, focused);
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
 * live one unless the user is editing that control (SPEC §6.2).
 */
function syncProperty(el: Element, name: string, value: string | null, focused: boolean) {
  if (focused) return;
  const n = name.toLowerCase();
  if (n === "value" && "value" in el && (el.localName === "input" || el.localName === "textarea" || el.localName === "select")) {
    (el as HTMLInputElement).value = value ?? "";
  } else if (n === "checked" && el.localName === "input") {
    (el as HTMLInputElement).checked = value !== null;
  } else if (n === "selected" && el.localName === "option") {
    (el as HTMLOptionElement).selected = value !== null;
  }
}
