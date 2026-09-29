// What may enter a surface's document, and what its URLs become.
//
// Everything the program sends is parsed inert (a <template>, or DOMParser
// for whole documents), cleaned and resolved here, and only then adopted
// (never cloned: the resolver remembers elements) into the live, sandboxed
// document. The sandbox and the CSP already stop
// scripts and requests; this is the first line, and it keeps the live DOM
// free of things that could navigate, load or steal focus.

import { INVALID, isUrlAttr, type Store } from "./resources.ts";

/** Elements that never enter a surface. */
const DROP = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "portal", "fencedframe"]);

/** Attributes that never enter a surface (besides `on*` handlers). */
const DROP_ATTRS = new Set(["srcdoc", "autofocus", "http-equiv", "ping", "nonce", "integrity"]);

export class Resolver {
  /** The program's value of each attribute the resolver rewrote. */
  private orig = new WeakMap<Element, Map<string, string>>();
  /** The program's text of each `<style>` whose CSS names a resource. */
  private css = new WeakMap<Element, string>();
  /** Elements that name resources, and which. */
  private refs = new Map<Element, Set<string>>();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Cleans and resolves an inert subtree, in place. */
  adopt(root: Node): void {
    const walk = (node: Node) => {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (!this.allowed(el)) {
          el.remove();
          return;
        }
        this.cleanAttributes(el);
        if (el.localName === "style") this.setCss(el, el.textContent ?? "");
      }
      for (const child of Array.from(node.childNodes)) walk(child);
      if (node.nodeType === 1 && (node as Element).localName === "template") {
        walk((node as HTMLTemplateElement).content);
      }
    };
    walk(root);
  }

  private allowed(el: Element): boolean {
    const name = el.localName;
    if (DROP.has(name)) return false;
    if (name === "link") {
      const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      return rel.includes("stylesheet");
    }
    return true;
  }

  private cleanAttributes(el: Element) {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on") || DROP_ATTRS.has(n)) {
        el.removeAttribute(a.name);
      } else if (isUrlAttr(n) || n === "style") {
        this.set(el, a.name, a.value);
      }
    }
  }

  /** An attribute as the program wrote it. */
  get(el: Element, name: string): string | null {
    return this.orig.get(el)?.get(name) ?? el.getAttribute(name);
  }

  /** Every attribute as the program wrote it, in order. */
  attributes(el: Element): [string, string][] {
    const o = this.orig.get(el);
    return Array.from(el.attributes, (a): [string, string] => [a.name, o?.get(a.name) ?? a.value]);
  }

  /** Sets an attribute to the program's value, resolving URLs and CSS. */
  set(el: Element, name: string, value: string): void {
    const n = name.toLowerCase();
    if (n.startsWith("on") || DROP_ATTRS.has(n)) return;
    const names = new Set<string>();
    let live = value;
    if (n === "style") live = this.store.rewriteCss(value, names);
    else if (isUrlAttr(n)) live = n === "srcset" ? this.srcset(value, names) : this.store.resolveUrl(value, names);
    // Links keep their href: they never navigate (clicks are intercepted and
    // the CSP blocks every scheme but data: and blob:), and the program hears
    // it back in `click` events.
    if (el.localName === "a" && n === "href") live = value;
    try {
      el.setAttribute(name, live);
    } catch {
      return; // an invalid attribute name from the parser's point of view
    }
    this.remember(el, name, value, live, names);
  }

  remove(el: Element, name: string): void {
    el.removeAttribute(name);
    this.orig.get(el)?.delete(name);
  }

  /** A `<style>`'s CSS as the program wrote it. */
  cssOf(el: Element): string {
    return this.css.get(el) ?? el.textContent ?? "";
  }

  setCss(el: Element, text: string): void {
    const names = new Set<string>();
    const live = this.store.rewriteCss(text, names);
    if (el.textContent !== live) el.textContent = live;
    if (names.size > 0) {
      this.css.set(el, text);
      this.track(el, names);
    } else {
      this.css.delete(el);
    }
  }

  /** Re-resolves everything that names one of `names` (a resource changed). */
  refresh(names: Set<string>): void {
    for (const [el, uses] of Array.from(this.refs)) {
      if (!el.isConnected) {
        this.refs.delete(el);
        continue;
      }
      if (![...uses].some((u) => names.has(u))) continue;
      this.refs.delete(el);
      const o = this.orig.get(el);
      if (o) for (const [attr, value] of Array.from(o)) this.set(el, attr, value);
      const css = this.css.get(el);
      if (css !== undefined) this.setCss(el, css);
    }
  }

  private srcset(value: string, names: Set<string>): string {
    return value
      .split(",")
      .map((part) => {
        const [url, ...rest] = part.trim().split(/\s+/);
        return [this.store.resolveUrl(url ?? "", names), ...rest].join(" ");
      })
      .join(", ");
  }

  private remember(el: Element, name: string, value: string, live: string, names: Set<string>) {
    let o = this.orig.get(el);
    if (value !== live) {
      if (!o) this.orig.set(el, (o = new Map()));
      o.set(name, value);
    } else {
      o?.delete(name);
    }
    if (names.size > 0) this.track(el, names);
  }

  private track(el: Element, names: Set<string>) {
    const uses = this.refs.get(el) ?? new Set<string>();
    for (const n of names) uses.add(n);
    this.refs.set(el, uses);
  }
}

export { INVALID };
