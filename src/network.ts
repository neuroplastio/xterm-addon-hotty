// The network policy (SPEC §7.2): what a surface may fetch from the network.
//
// The host's half is the embedder's `network` option; the document's half is
// its `<meta name="hotty-network">`. A URL may be fetched only when a source
// in each half matches it, for the directive that covers it. The resolver
// enforces the intersection per document; the iframe's CSP holds the host's
// half on its own, so a reference the resolver misses can still reach
// nothing the embedder did not grant.

export type Directive = "img-src" | "media-src" | "font-src" | "style-src";
export const DIRECTIVES: readonly Directive[] = ["img-src", "media-src", "font-src", "style-src"];

/** Directive → sources: origins (`https://example.com`) or `https:`. */
export type Policy = Partial<Record<Directive, string[]>>;

/** A source in canonical form, or null if it is not one HOTTY allows. */
export function source(s: string): string | null {
  const v = s.trim().toLowerCase();
  if (v === "https:") return v;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // An origin: nothing after the host and port.
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) return null;
  if (!/^https?:\/\/[^/]+\/?$/.test(v)) return null;
  return u.origin;
}

/** A policy with only valid directives and sources. */
export function clean(p: Policy | undefined): Policy {
  const out: Policy = {};
  for (const d of DIRECTIVES) {
    const srcs = (p?.[d] ?? []).map(source).filter((s): s is string => s !== null);
    if (srcs.length) out[d] = [...new Set(srcs)];
  }
  return out;
}

/** A document's request, from its `<meta name="hotty-network">` content (CSP syntax). */
export function parse(content: string): Policy {
  const p: Policy = {};
  for (const part of content.split(";")) {
    const [name, ...srcs] = part.trim().split(/\s+/);
    const d = (name ?? "").toLowerCase() as Directive;
    if (DIRECTIVES.includes(d)) p[d] = [...(p[d] ?? []), ...srcs];
  }
  return clean(p);
}

function matches(src: string, url: URL): boolean {
  if (src === "https:") return url.protocol === "https:";
  return url.origin === src;
}

/** What both halves allow: sources of the document that the host's cover. */
export function intersect(host: Policy, doc: Policy): Policy {
  const out: Policy = {};
  for (const d of DIRECTIVES) {
    const h = host[d] ?? [];
    const res = new Set<string>();
    for (const s of doc[d] ?? []) {
      if (s === "https:") {
        // The document asks for any HTTPS origin: it gets the host's HTTPS ones.
        for (const hs of h) if (hs === "https:" || hs.startsWith("https://")) res.add(hs);
      } else if (h.some((hs) => matches(hs, new URL(s)))) {
        res.add(s);
      }
    }
    if (res.size) out[d] = [...res];
  }
  return out;
}

/** Whether a policy allows fetching an absolute URL for a directive. */
export function allows(p: Policy, d: Directive, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (p[d] ?? []).some((s) => matches(s, u));
}

/** A directive's sources as CSP source expressions. */
export function cspSources(p: Policy, d: Directive): string {
  return (p[d] ?? []).join(" ");
}

/** The directive that covers an attribute of an element, if it fetches at all. */
export function directiveFor(tag: string, attr: string, rel = ""): Directive | null {
  if (attr === "srcset") return "img-src";
  if (attr === "poster") return "img-src";
  if (attr === "src") {
    if (tag === "img" || tag === "input" || tag === "image") return "img-src";
    if (tag === "video" || tag === "audio" || tag === "source" || tag === "track") return "media-src";
  }
  if ((attr === "href" || attr === "xlink:href") && (tag === "image" || tag === "use" || tag === "feimage")) return "img-src";
  if (attr === "href" && tag === "link" && rel.split(/\s+/).includes("stylesheet")) return "style-src";
  return null;
}
