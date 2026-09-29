// A surface (PROTOCOL §4): one document in one sandboxed iframe.
//
// The iframe is same-origin without scripts (`sandbox="allow-same-origin
// allow-forms"`), so the addon can change its document directly and nothing
// inside it can run. Its CSP allows `data:` and `blob:` resources, inline
// styles, and from the network only what the embedder granted (the host's
// half of the network policy, SPEC §7.2). `allow-forms` is there only so that
// `submit` fires (a sandbox without it cancels submission before the event);
// the submission itself is cancelled here and blocked by `form-action 'none'`.
//
// The iframe never moves in the DOM (moving an iframe reloads it): it sits
// in the addon's layer, and placement only changes the position of its box.

import { Patcher } from "./patch.ts";
import { Resolver } from "./resolver.ts";
import { encodeKey } from "./keys.ts";
import { cspSources, intersect, parse, type Policy } from "./network.ts";
import { NO_BASE, type Store } from "./resources.ts";

/** A surface's CSP: nothing from the network but what the host grants. The
 * `<base>` is the addon's own (a document's is read, then dropped), so any
 * http(s) base is allowed. */
export function csp(host: Policy): string {
  const with_ = (fixed: string, d: keyof Policy) => [fixed, cspSources(host, d)].filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    with_("img-src data: blob:", "img-src"),
    with_("media-src data: blob:", "media-src"),
    with_("font-src data: blob:", "font-src"),
    with_("style-src 'unsafe-inline' blob:", "style-src"),
    "form-action 'none'",
    "base-uri http: https:",
  ].join("; ");
}

/** A document's base URL (SPEC §7.3): its first <base href>, if absolute http(s). */
function baseOf(doc: Document): string {
  const href = doc.querySelector("base[href]")?.getAttribute("href") ?? "";
  try {
    const u = new URL(href);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    /* not absolute */
  }
  return NO_BASE;
}

/** What a surface needs from the addon. */
export interface SurfaceHost {
  layer: HTMLElement;
  store: Store;
  /** Sends a HOTTY message (an event) to the program. */
  event(surface: string, kind: string, target: string, detail?: unknown): void;
  /** Sends key bytes to the program, as if typed in the terminal. */
  input(bytes: string): void;
  /** Gives the keyboard back to the terminal. */
  focusTerminal(): void;
  /** The host's half of the network policy (SPEC §7.2). */
  policy: Policy;
  /** Opens a link outside the surface (SPEC §9); false if it did not. */
  openLink(url: string): boolean;
  /** A wheel event the surface has no use for, at a point in the page. */
  wheel(e: WheelEvent, pageX: number, pageY: number): void;
  applicationCursor(): boolean;
}

type Control = "none" | "text" | "textarea" | "select" | "activatable";

const TEXT_TYPES = new Set(["text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "time", "week"]);

export class Surface {
  readonly name: string;
  readonly box: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
  readonly doc: Document;
  readonly resolver: Resolver;
  readonly patcher: Patcher;
  cols = 80;
  rows = 24;
  autoRows = false;
  private readonly host: SurfaceHost;
  private readonly hostStyle: HTMLStyleElement;
  /** Set while the program moves focus, so no `focus` event echoes back. */
  private programFocus = false;
  /** The document's base URL (SPEC §7.3). */
  private base = NO_BASE;
  private keyboard = false;

  constructor(name: string, host: SurfaceHost, hostCss: string) {
    this.name = name;
    this.host = host;
    this.box = document.createElement("div");
    this.box.className = "hotty-surface";
    this.box.dataset.surface = name;
    Object.assign(this.box.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      overflow: "hidden",
      pointerEvents: "auto",
      visibility: "hidden",
    });
    this.frame = document.createElement("iframe");
    this.frame.setAttribute("sandbox", "allow-same-origin allow-forms");
    this.frame.setAttribute("title", `HOTTY surface ${name}`);
    Object.assign(this.frame.style, { border: "0", width: "100%", height: "100%", display: "block", colorScheme: "normal" });
    this.box.append(this.frame);
    host.layer.append(this.box);

    // The initial about:blank document exists as soon as the iframe is
    // connected; writing it through the parser makes the CSP <meta> a
    // parser-inserted policy, in force before any program markup arrives.
    const doc = this.frame.contentDocument;
    if (!doc) throw new Error("surface iframe has no document");
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<meta http-equiv="Content-Security-Policy" content="${csp(host.policy)}">` +
        `<base href="${NO_BASE}"><style id="hotty-host"></style></head><body></body></html>`,
    );
    doc.close();
    this.doc = doc;
    this.hostStyle = doc.getElementById("hotty-host") as HTMLStyleElement;
    this.hostStyle.textContent = hostCss;
    this.resolver = new Resolver(host.store);
    this.patcher = new Patcher(doc, this.resolver);
    this.listen();
  }

  setHostCss(css: string) {
    if (this.hostStyle.textContent !== css) this.hostStyle.textContent = css;
  }

  /** Replaces the whole document (`a=doc`): its head's styles and its body. */
  setDocument(html: string) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    // The document's base and its network request (SPEC §7.2, §7.3) are read
    // before the resolver drops its <base> and <meta> elements; patches can
    // add neither, so both hold until the next a=doc.
    this.base = baseOf(parsed);
    const request = parse(parsed.querySelector('meta[name="hotty-network" i]')?.getAttribute("content") ?? "");
    this.resolver.ctx = { base: this.base, policy: intersect(this.host.policy, request) };
    const ours = this.doc.head.querySelector("base");
    if (ours && ours.getAttribute("href") !== this.base) ours.setAttribute("href", this.base);
    this.resolver.adopt(parsed.documentElement);
    const head = this.doc.head;
    for (const n of Array.from(head.childNodes)) {
      const el = n as Element;
      const ours = el.nodeType === 1 && (el.id === "hotty-host" || el.localName === "meta" || el.localName === "base");
      if (!ours) n.remove();
    }
    head.append(...Array.from(parsed.head.childNodes));
    this.copyAttributes(parsed.documentElement, this.doc.documentElement);
    this.copyAttributes(parsed.body, this.doc.body);
    this.doc.body.replaceChildren(...Array.from(parsed.body.childNodes));
  }

  private copyAttributes(from: Element, to: Element) {
    for (const [name] of this.resolver.attributes(to)) {
      if (!from.hasAttribute(name)) this.resolver.remove(to, name);
    }
    for (const [name, value] of this.resolver.attributes(from)) this.resolver.set(to, name, value);
  }

  /** Rows the content needs at `cols` columns (`r=auto`). */
  contentRows(cols: number, cellW: number, cellH: number): number {
    this.box.style.width = `${cols * cellW}px`;
    this.box.style.height = "1px";
    const h = this.doc.documentElement.scrollHeight;
    return Math.max(1, Math.min(1000, Math.ceil(h / cellH)));
  }

  setSize(cols: number, rows: number, cellW: number, cellH: number) {
    this.cols = cols;
    this.rows = rows;
    this.box.style.width = `${Math.round(cols * cellW)}px`;
    this.box.style.height = `${rows * cellH}px`;
  }

  /** Shows the surface with its top-left corner at (x, y) in the screen's pixels. */
  show(x: number, y: number) {
    this.box.style.left = `${x}px`;
    this.box.style.top = `${y}px`;
    this.box.style.visibility = "visible";
    this.box.style.display = "block";
  }

  hide() {
    this.box.style.display = "none";
  }

  /** Off screen but laid out, for a surface with no placement. */
  park() {
    this.box.style.visibility = "hidden";
    this.box.style.display = "block";
  }

  destroy() {
    if (this.keyboard) this.host.focusTerminal();
    this.box.remove();
  }

  // --- Keyboard (PROTOCOL §8, Q-0005) -------------------------------------

  hasKeyboard(): boolean {
    return this.keyboard;
  }

  /** `a=focus`: the surface takes the keyboard, at `target` if given. */
  focus(target?: string) {
    const el = target ? this.doc.getElementById(target) : null;
    if (target && !el) throw new Error(target);
    this.programFocus = true;
    try {
      this.frame.focus();
      this.frame.contentWindow?.focus();
      if (el) (el as HTMLElement).focus();
      else if (!this.focusedControl()) this.tabbable()[0]?.focus();
      this.keyboard = true;
    } finally {
      setTimeout(() => (this.programFocus = false), 0);
    }
  }

  /** `a=blur`, or the keyboard leaving: the edited control commits first. */
  blur() {
    this.commit();
    if (this.keyboard) this.host.focusTerminal();
  }

  private commit() {
    const active = this.focusedControl();
    if (active) active.blur(); // fires `change` if the value changed
  }

  private focusedControl(): HTMLElement | null {
    const a = this.doc.activeElement;
    return a && a !== this.doc.body && a !== this.doc.documentElement ? (a as HTMLElement) : null;
  }

  private tabbable(): HTMLElement[] {
    const all = this.doc.querySelectorAll<HTMLElement>(
      "a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=''], [contenteditable=true]",
    );
    return Array.from(all).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
  }

  private controlKind(el: Element | null): Control {
    if (!el) return "none";
    const tag = el.localName;
    if (tag === "textarea" || (el as HTMLElement).isContentEditable) return "textarea";
    if (tag === "select") return "select";
    if (tag === "input") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (TEXT_TYPES.has(type)) return "text";
      return "activatable";
    }
    if (tag === "button" || tag === "a" || tag === "summary") return "activatable";
    return "none";
  }

  /** Whether the focused element uses the key; if not, the program gets it. */
  private consumes(e: KeyboardEvent, kind: Control): boolean {
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    const k = e.key;
    const printable = [...k].length === 1;
    if (k === "Escape") return false;
    switch (kind) {
      case "text":
        return (plain || (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey)) &&
          (printable || ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(k));
      case "textarea":
        return (plain || (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey)) &&
          (printable || ["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter"].includes(k));
      case "select":
        return plain && (printable || ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter", " "].includes(k));
      case "activatable":
        return plain && (k === " " || k === "Enter");
      default:
        return false;
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Tab moves between controls; past the last one it leaves the surface.
      const order = this.tabbable();
      const at = order.indexOf(this.doc.activeElement as HTMLElement);
      const leaving = order.length === 0 || (e.shiftKey ? at <= 0 : at === order.length - 1 || at < 0);
      if (leaving) {
        e.preventDefault();
        this.blur();
      }
      return;
    }
    if (this.consumes(e, this.controlKind(this.doc.activeElement))) return;
    const bytes = encodeKey(e, this.host.applicationCursor());
    e.preventDefault();
    e.stopPropagation();
    if (bytes !== null) this.host.input(bytes);
  }

  // --- Events for the program (PROTOCOL §8) --------------------------------

  private listen() {
    const d = this.doc;
    const win = this.frame.contentWindow!;
    d.addEventListener("click", (e) => this.onClick(e), true);
    d.addEventListener("auxclick", (e) => this.onAuxClick(e), true);
    d.addEventListener("submit", (e) => this.onSubmit(e as SubmitEvent), true);
    d.addEventListener("change", (e) => this.onChange(e), true);
    d.addEventListener("input", (e) => this.onInput(e), true);
    d.addEventListener("keydown", (e) => this.onKey(e), true);
    d.addEventListener("dragstart", (e) => e.preventDefault(), true);
    d.addEventListener("wheel", (e) => this.onWheel(e), { capture: true, passive: false });
    win.addEventListener("focus", () => {
      this.keyboard = true;
      if (!this.programFocus) this.emit("focus", "");
    });
    win.addEventListener("blur", () => {
      this.commit();
      if (this.keyboard) {
        this.keyboard = false;
        this.emit("blur", "");
      }
    });
  }

  /**
   * Wheel events never leave an iframe, so without this the terminal's
   * scrollback (or, on the alternate screen, the program's wheel input) would
   * stall under the pointer. A surface keeps a wheel event only when an
   * element under the pointer can scroll that way.
   */
  private onWheel(e: WheelEvent) {
    if (e.ctrlKey || this.canScroll(e.target, e.deltaX, e.deltaY)) return;
    e.preventDefault();
    const r = this.frame.getBoundingClientRect();
    this.host.wheel(e, r.left + e.clientX, r.top + e.clientY);
  }

  private canScroll(target: EventTarget | null, dx: number, dy: number): boolean {
    for (let n = target as Node | null; n && n.nodeType === 1; n = n.parentNode) {
      const el = n as Element;
      if (el === this.doc.documentElement || el === this.doc.body) return false;
      const style = this.frame.contentWindow!.getComputedStyle(el);
      const scrolls = (o: string) => o === "auto" || o === "scroll";
      if (dy !== 0 && scrolls(style.overflowY) && el.scrollHeight > el.clientHeight) {
        if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
      }
      if (dx !== 0 && scrolls(style.overflowX) && el.scrollWidth > el.clientWidth) {
        if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
      }
    }
    return false;
  }

  private emit(kind: string, target: string, detail?: unknown) {
    this.host.event(this.name, kind, target, detail);
  }

  private linkIn(e: Event): Element | null {
    for (const n of e.composedPath()) {
      if (isElement(n) && n.localName === "a" && n.hasAttribute("href")) return n;
    }
    return null;
  }

  /** A link's click (SPEC §9): reported with or without an id; opened
   * outside the surface when the user asked for that. */
  private onLink(link: Element, e: MouseEvent) {
    e.preventDefault();
    const href = this.resolver.get(link, "href") ?? "";
    let url = "";
    try {
      url = new URL(href, this.base).href;
    } catch {
      /* not a URL */
    }
    if (url.startsWith(NO_BASE)) url = "";
    const detail: Record<string, unknown> = { href };
    if (url) detail.url = url;
    const wantsOpen = e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey;
    if (wantsOpen && /^(https?|mailto):/i.test(url) && this.host.openLink(url)) detail.opened = true;
    this.emit("click", link.getAttribute("id") ?? "", detail);
  }

  private onAuxClick(e: MouseEvent) {
    const link = this.linkIn(e);
    if (!link) return;
    if (e.button === 1) this.onLink(link, e);
    else e.preventDefault();
  }

  private onClick(e: MouseEvent) {
    const link = this.linkIn(e);
    if (link) {
      this.onLink(link, e);
      return;
    }
    for (const n of e.composedPath()) {
      if (!isElement(n)) continue;
      const el = n;
      const tag = el.localName;
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      const wants = (el.getAttribute("data-on") ?? "").split(/\s+/).includes("click");
      const reportable = tag === "button" || tag === "a" || tag === "summary" || (tag === "input" && ["button", "submit", "reset"].includes(type)) || wants;
      if (!reportable) continue;
      const id = el.getAttribute("id");
      if (id) {
        const detail: Record<string, string> = {};
        const href = this.resolver.get(el, "href");
        if (href !== null) detail.href = href;
        const value = this.resolver.get(el, "value");
        if (value !== null) detail.value = value;
        this.emit("click", id, Object.keys(detail).length ? detail : undefined);
      }
      break;
    }
  }

  private onSubmit(e: SubmitEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const id = form.getAttribute("id");
    if (!id) return;
    const fields: Record<string, string> = {};
    const data = new (this.frame.contentWindow as unknown as typeof globalThis).FormData(form, e.submitter ?? undefined);
    for (const [k, v] of data) if (typeof v === "string") fields[k] = v;
    this.emit("submit", id, fields);
  }

  private onChange(e: Event) {
    const el = e.target as HTMLInputElement;
    const id = el.getAttribute?.("id");
    if (!id) return;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (el.localName === "input" && (type === "checkbox" || type === "radio")) {
      this.emit("change", id, { checked: el.checked, value: this.resolver.get(el, "value") });
    } else if ("value" in el) {
      this.emit("change", id, { value: el.value });
    }
  }

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const id = el.getAttribute?.("id");
    if (!id) return;
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (type === "checkbox" || type === "radio") return; // reported as `change`
    if ((el.getAttribute("data-on") ?? "").split(/\s+/).includes("input") && "value" in el) {
      this.emit("input", id, { value: el.value });
    }
  }
}

/** Elements from the iframe's realm fail `instanceof Element` here. */
function isElement(n: EventTarget): n is Element {
  return (n as Node).nodeType === 1;
}
