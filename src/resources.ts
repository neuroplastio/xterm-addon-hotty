// Resources (PROTOCOL §6): named bytes a document refers to as `cid:<name>`.
//
// The browser cannot load `cid:` URLs, so every reference is resolved to a
// `blob:` URL before it reaches a live document, and the program's original
// value is remembered so that morph compares against what the program wrote.
// Stylesheets are rewritten too (their own `url(cid:…)`), so a stylesheet's
// blob depends on the resources it names; changing one re-resolves both.

import { allows, type Directive, type Policy } from "./network.ts";

export const INVALID = "about:invalid";

/** The base URL no document declared (SPEC §7.3): nothing under it loads. */
export const NO_BASE = "https://hotty.invalid/";

/** What a document's references resolve against (SPEC §7.2, §7.3). */
export interface UrlContext {
  /** The document's base URL. */
  base: string;
  /** The effective network policy: the host's half and the document's. */
  policy: Policy;
}

/** A fetch the policy allows, as an absolute URL, or INVALID. Never relative:
 * a relative URL would resolve against the base in the browser, and reach
 * whatever the host's half (the CSP) allows, asked for or not. */
function network(value: string, ctx: UrlContext | undefined, d: Directive): string {
  if (!ctx) return INVALID;
  let abs: string;
  try {
    abs = new URL(value, ctx.base).href;
  } catch {
    return INVALID;
  }
  return !abs.startsWith(NO_BASE) && allows(ctx.policy, d, abs) ? abs : INVALID;
}

/** Attributes that hold a URL, per element or globally. */
const URL_ATTRS = new Set(["src", "href", "poster", "background", "data", "action", "formaction", "xlink:href", "srcset", "cite", "longdesc", "lowsrc", "manifest", "codebase", "usemap", "ping"]);

export function isUrlAttr(name: string): boolean {
  return URL_ATTRS.has(name.toLowerCase());
}

interface Entry {
  mime: string;
  bytes: Uint8Array;
  url: string | null;
  /** Resources this one's text names (stylesheets). */
  deps: Set<string>;
}

export class Store {
  private entries = new Map<string, Entry>();
  private used = 0;
  readonly quota: number;
  /** Called with the names whose URL changed, so surfaces can re-resolve. */
  onChange: (names: Set<string>) => void = () => {};

  constructor(quota = 64 << 20) {
    this.quota = quota;
  }

  put(name: string, mime: string, bytes: Uint8Array): void {
    const old = this.entries.get(name);
    const next = this.used - (old?.bytes.length ?? 0) + bytes.length;
    if (next > this.quota) throw new Error(`resource store over quota (${next} > ${this.quota} bytes)`);
    this.used = next;
    this.entries.set(name, { mime, bytes, url: null, deps: new Set() });
    this.changed(name, old);
  }

  remove(name: string): boolean {
    const old = this.entries.get(name);
    if (!old) return false;
    this.used -= old.bytes.length;
    this.entries.delete(name);
    this.changed(name, old);
    return true;
  }

  /** The `blob:` URL for a resource, or `null` if there is none (yet). */
  url(name: string): string | null {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.url === null) {
      let bytes: Uint8Array = e.bytes;
      if (e.mime.startsWith("text/css")) {
        e.deps.clear();
        const css = new TextDecoder().decode(e.bytes);
        bytes = new TextEncoder().encode(this.rewriteCss(css, e.deps));
      }
      e.url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: e.mime }));
    }
    return e.url;
  }

  /** CSS text with every reference resolved; `names` collects the resources.
   * Without a context (a stylesheet resource, shared by surfaces with
   * different policies) nothing from the network is allowed. */
  rewriteCss(css: string, names: Set<string>, ctx?: UrlContext): string {
    const one = (raw: string, d: Directive[]): string => {
      const v = raw.trim();
      if (/^cid:/i.test(v)) {
        names.add(v.slice(4));
        return this.url(v.slice(4)) ?? INVALID;
      }
      if (/^data:/i.test(v) || /^blob:/i.test(v) || v.startsWith("#")) return raw;
      // CSS does not say what a url() is for: an image or a font. The
      // resolver allows either; the CSP holds each to its own directive.
      for (const dir of d) {
        const r = network(v, ctx, dir);
        if (r !== INVALID) return r;
      }
      return INVALID;
    };
    return css
      .replace(/@import\s+(?:url\(\s*)?(['"])([^'"]*)\1\s*\)?/gi, (_m, _q, u: string) => `@import "${one(u, ["style-src"])}"`)
      .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_m, _q, u: string) => `url("${one(u, ["img-src", "font-src"])}")`);
  }

  /** Resolves one attribute value; `names` collects the resources it names.
   * `d` is the directive that covers the attribute, if it fetches. */
  resolveUrl(value: string, names: Set<string>, ctx?: UrlContext, d?: Directive | null): string {
    const v = value.trim();
    if (/^cid:/i.test(v)) {
      const name = v.slice(4);
      names.add(name);
      return this.url(name) ?? INVALID;
    }
    if (/^data:/i.test(v) || /^blob:/i.test(v) || v === "" || v.startsWith("#")) return value;
    if (d) return network(v, ctx, d);
    // An attribute that does not fetch (cite, longdesc, a form's action):
    // relative stays relative, and an absolute URL fails closed.
    return /^[a-z][a-z0-9+.-]*:/i.test(v) ? INVALID : value;
  }

  private changed(name: string, old: Entry | undefined) {
    const names = new Set([name]);
    // Stylesheets naming this resource get new blobs too.
    for (const [other, e] of this.entries) {
      if (e.deps.has(name)) {
        if (e.url) URL.revokeObjectURL(e.url);
        e.url = null;
        names.add(other);
      }
    }
    this.onChange(names);
    // Revoked after surfaces moved to the new URL.
    if (old?.url) URL.revokeObjectURL(old.url);
  }
}
