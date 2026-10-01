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

import { Touch } from "./touch.ts";
import { Patcher } from "./patch.ts";
import { Resolver } from "./resolver.ts";
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
/** A window of a surface, in cells from its top-left corner (SPEC §5.2). */
export interface Window {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SurfaceHost {
  layer: HTMLElement;
  store: Store;
  /** Sends a HOTTY message (an event) to the program. */
  event(surface: string, kind: string, target: string, detail?: unknown): void;
  /** A key the surface does not use (a keydown or its keyup), for the
   *  terminal to send to the program as if typed there (SPEC §10.2). */
  key(e: KeyboardEvent): void;
  /** A key the browser keeps (the `browserKeys` option): the surface
   *  leaves it to the browser rather than hand it to the terminal. */
  browserKey(e: KeyboardEvent): boolean;
  /** Gives the keyboard back to the terminal. */
  focusTerminal(): void;
  /** The host's half of the network policy (SPEC §7.2). */
  policy: Policy;
  /** A hyperlink (SPEC §9: a link with target="_blank") was hovered, left
   *  or clicked: the terminal's, as an OSC 8 hyperlink is. `box` is the
   *  link's box in the page. */
  hyperlink(kind: "activate" | "hover" | "leave", e: MouseEvent, url: string, box: DOMRect): void;
  /** A wheel event over the surface, or a touch drag made one: the
   *  terminal's (SPEC §9), at a point in the page. */
  wheel(e: WheelEvent, pageX: number, pageY: number): void;
}

type Control = "none" | "text" | "textarea" | "select" | "activatable";

/** The theme's colour scheme, as the host stylesheet declares it. */
export type Scheme = "dark" | "light";

const TEXT_TYPES = new Set(["text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "time", "week"]);

/** The form controls a detached surface disables (SPEC §5.5). */
const CONTROLS = "input, select, textarea, button";

/**
 * A detached surface shows no pointer that promises a click (SPEC §5.5),
 * whatever the document's `cursor` asks for, except over a hyperlink, which
 * is the terminal's and still opens. Over another link the pointer is the
 * one over text: `auto` would be the hand there. Important in the host's
 * layer, the first, so that it wins over the program's own rules.
 */
const DETACHED_CSS = `@layer hotty-host {
* { cursor: auto !important; }
a[href], a[href] * { cursor: text !important; }
a[href][target="_blank"], a[href][target="_blank"] * { cursor: pointer !important; }
}`;

export class Surface {
  readonly name: string;
  readonly box: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
  readonly doc: Document;
  readonly resolver: Resolver;
  readonly patcher: Patcher;
  cols = 80;
  rows = 24;
  /** The part of the surface on screen, in cells (SPEC §5.2). */
  win: Window = { x: 0, y: 0, w: 80, h: 24 };
  autoRows = false;
  private readonly host: SurfaceHost;
  private readonly hostStyle: HTMLStyleElement;
  /** Set while the program moves focus, so no `focus` event echoes back. */
  private programFocus = false;
  /** The document's base URL (SPEC §7.3). */
  private base = NO_BASE;
  private keyboard = false;
  /** Detached (SPEC §5.5): nothing in the surface reaches the program. */
  private detachedState = false;
  /** A press is on something that takes no focus (SPEC §10.1): the focus
   * the browser gives the frame for it is not the surface's. */
  private pressNothing = false;
  /** The element a press focuses, until the browser is done with it. */
  private pressed: HTMLElement | null = null;
  /** A press of another button than the primary one, until the browser is
   * done with it: it neither takes nor gives back the keyboard. */
  private auxPress = false;
  private settling: ReturnType<typeof setTimeout> | null = null;
  private css = "";
  /** Keys whose keydown went to the program, so their keyup follows. */
  private forwarded = new Set<string>();

  constructor(name: string, host: SurfaceHost, hostCss: string, scheme: Scheme) {
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
    // The document is the whole surface; the box shows its window (SPEC §5.2).
    // The frame's colour scheme is the document's (the host stylesheet's,
    // from the theme): were they to differ, the browser would paint the
    // frame an opaque canvas, and a document with a transparent background
    // could not show the cells beneath it.
    Object.assign(this.frame.style, {
      border: "0",
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "100%",
      height: "100%",
      display: "block",
      colorScheme: scheme,
    });
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
    this.css = hostCss;
    this.restyle();
    this.resolver = new Resolver(host.store);
    this.patcher = new Patcher(doc, this.resolver);
    this.listen();
  }

  setHostCss(css: string, scheme: Scheme) {
    this.css = css;
    this.restyle();
    if (this.frame.style.colorScheme !== scheme) this.frame.style.colorScheme = scheme;
  }

  private restyle() {
    const css = this.detachedState ? `${this.css}\n${DETACHED_CSS}` : this.css;
    if (this.hostStyle.textContent !== css) this.hostStyle.textContent = css;
  }

  /** Replaces the whole document (`a=doc`): its head's styles and its body.
   * `detached` (`d=1`) detaches the surface first; without it, the surface
   * is the program's again (SPEC §5.1, §5.5). */
  setDocument(html: string, detached = false) {
    if (detached) this.detach();
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
    this.detachedState = detached;
    this.sync();
  }

  /** A patch (SPEC §6). On a detached surface, the controls it adds are
   * disabled too, and so is one whose `disabled` it removes. */
  patch(op: string, target: string | undefined, key: string | undefined, payload: string) {
    try {
      this.patcher.apply(op, target, key, payload);
    } finally {
      if (this.detachedState) this.sync();
    }
  }

  // --- Ownership (SPEC §5.5) -----------------------------------------------

  get detached(): boolean {
    return this.detachedState;
  }

  /** `a=detach`: nothing in the surface reaches the program any more. A
   * surface that has the keyboard gives it back silently, with no `change`
   * and no `blur`, and its form controls act disabled. */
  detach() {
    if (!this.detachedState) {
      this.detachedState = true; // from here on, emit() sends nothing
      const had = this.keyboard || this.frameFocused();
      this.keyboard = false;
      this.focusedControl()?.blur();
      if (had) this.giveBack();
    }
    this.sync();
  }

  /** Disables the form controls of a detached surface, as if each had the
   * `disabled` attribute, or enables those it disabled. The attribute is
   * the host's own: the document reports the program's (SPEC §16). */
  private sync() {
    for (const el of Array.from(this.doc.querySelectorAll(CONTROLS))) {
      if (!this.detachedState) this.resolver.removeOwn(el, "disabled");
      else if (!el.hasAttribute("disabled")) this.resolver.setOwn(el, "disabled", "");
    }
    this.restyle();
  }

  private copyAttributes(from: Element, to: Element) {
    for (const [name] of this.resolver.attributes(to)) {
      if (!from.hasAttribute(name)) this.resolver.remove(to, name);
    }
    for (const [name, value] of this.resolver.attributes(from)) this.resolver.set(to, name, value);
  }

  /** Rows the content needs at `cols` columns (`r=auto`). */
  contentRows(cols: number, cellW: number, cellH: number): number {
    // Laid out, unseen, whatever the surface was showing.
    Object.assign(this.box.style, { display: "block", visibility: "hidden" });
    Object.assign(this.frame.style, { width: `${cols * cellW}px`, height: "1px" });
    const h = this.doc.documentElement.scrollHeight;
    return Math.max(1, Math.min(1000, Math.ceil(h / cellH)));
  }

  /** The surface is `cols`×`rows` cells, and the box shows `win` of it:
   *  the document keeps the whole size, offset by the window's corner. */
  setSize(cols: number, rows: number, cellW: number, cellH: number, win: Window = { x: 0, y: 0, w: cols, h: rows }) {
    this.cols = cols;
    this.rows = rows;
    this.win = win;
    Object.assign(this.frame.style, {
      left: `${-Math.round(win.x * cellW)}px`,
      top: `${-win.y * cellH}px`,
      width: `${Math.round(cols * cellW)}px`,
      height: `${rows * cellH}px`,
    });
    this.box.style.width = `${Math.round(win.w * cellW)}px`;
    this.box.style.height = `${win.h * cellH}px`;
  }

  /** The placement's z (SPEC §5.2): CSS z-index on the box, so overlapping
   *  boxes stack by it, and by their order in the layer at the same z. */
  setZ(z: number) {
    this.box.style.zIndex = String(z);
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

  /** No placement (hidden, or not placed yet): the document stays, and the
   *  browser skips its style, layout and paint until it is placed again. */
  park() {
    this.box.style.display = "none";
  }

  destroy() {
    if (this.settling) clearTimeout(this.settling);
    if (this.keyboard || this.frameFocused()) this.host.focusTerminal();
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
    if (this.keyboard) this.giveBack();
  }

  /** The browser's focus goes from the frame to the terminal. The frame lets
   * go of it first: Firefox can leave the frame focused otherwise. */
  private giveBack() {
    this.frame.blur();
    this.host.focusTerminal();
  }

  private commit() {
    const active = this.focusedControl();
    if (active) active.blur(); // fires `change` if the value changed
  }

  private focusedControl(): HTMLElement | null {
    const a = this.doc.activeElement;
    return a && a !== this.doc.body && a !== this.doc.documentElement ? (a as HTMLElement) : null;
  }

  /** Whether the browser's focus is in this surface's frame. */
  private frameFocused(): boolean {
    return this.frame.ownerDocument.activeElement === this.frame;
  }

  /**
   * A press (SPEC §10.1). On an element that takes focus, the focus that
   * follows gives the surface the keyboard (`onFocusIn`). On anything else,
   * or anywhere in a detached surface, it takes nothing: a surface that had
   * the keyboard gives it back (its control commits, then `blur`), and the
   * focus the browser gives the frame anyway goes back to the terminal.
   */
  private onPress(e: MouseEvent) {
    // A touch is a click only once it lifts, as a tap: its mousedown.
    if (e.type === "pointerdown" && (e as PointerEvent).pointerType === "touch") return;
    // Only a click (the primary button) moves the keyboard. Focus stays where
    // the browser puts it for the others: a context menu's Copy copies the
    // selection of the frame that has it.
    if (e.button !== 0) {
      this.auxPress = true;
      setTimeout(() => (this.auxPress = false), 0);
      return;
    }
    const el = this.detachedState ? null : focusTargetAt(e);
    if (el) {
      this.pressed = el;
      this.settle();
      return;
    }
    this.pressNothing = true;
    if (this.keyboard) {
      this.commit();
      this.keyboard = false;
      this.emit("blur", "");
    }
    this.settle();
  }

  /**
   * Once the browser is done with a press (its default action focuses the
   * frame): an element that takes focus has it, even where the browser does
   * not focus one on a click (a button on a Mac, say); and focus the
   * surface does not hold goes back to the terminal. The frame keeps it
   * until then, so text selection starts as usual.
   */
  private settle() {
    if (this.settling) return;
    this.settling = setTimeout(() => {
      this.settling = null;
      const el = this.pressed;
      this.pressed = null;
      this.pressNothing = false;
      if (el && !this.keyboard && !this.detachedState && el.isConnected && this.doc.activeElement !== el) {
        this.frame.focus();
        el.focus({ preventScroll: true });
      }
      if (!this.keyboard && this.frameFocused()) this.giveBack();
    }, 0);
  }

  /** An element got focus: the surface takes the keyboard if the element is
   * one that takes focus, and the focus is neither the program's (no echo)
   * nor a detached surface's. */
  private onFocusIn(e: FocusEvent) {
    if (this.programFocus || this.auxPress) return;
    if (this.detachedState || this.pressNothing || !isElement(e.target as EventTarget) || !takesFocus(e.target as Element)) {
      this.settle();
      return;
    }
    if (this.keyboard) return;
    this.keyboard = true;
    this.emit("focus", "");
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
    if (!this.keyboard) {
      // The frame has the browser's focus without the keyboard, for a moment
      // (a press that took nothing): every key is the terminal's.
      this.settle();
      if (this.host.browserKey(e)) return;
      this.forward(e);
      return;
    }
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
    if (this.host.browserKey(e)) return; // the browser's: reload, zoom, …
    this.forward(e);
  }

  private forward(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.forwarded.add(e.code);
    this.host.key(e);
  }

  /** The release of a key the program had: the program hears it too, if it
   *  asked the terminal for releases (SPEC §10.3). */
  private onKeyUp(e: KeyboardEvent) {
    if (!this.forwarded.delete(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    this.host.key(e);
  }

  // --- Events for the program (PROTOCOL §8) --------------------------------

  private listen() {
    const d = this.doc;
    const win = this.frame.contentWindow!;
    d.addEventListener("pointerdown", (e) => this.onPress(e), true);
    d.addEventListener("mousedown", (e) => this.onPress(e), true);
    d.addEventListener("focusin", (e) => this.onFocusIn(e), true);
    d.addEventListener("click", (e) => this.onClick(e), true);
    d.addEventListener("auxclick", (e) => this.onAuxClick(e), true);
    d.addEventListener("mouseover", (e) => this.onOver(e), true);
    d.addEventListener("mouseout", (e) => this.onOut(e), true);
    d.addEventListener("submit", (e) => this.onSubmit(e as SubmitEvent), true);
    d.addEventListener("change", (e) => this.onChange(e), true);
    d.addEventListener("input", (e) => this.onInput(e), true);
    d.addEventListener("keydown", (e) => this.onKey(e), true);
    d.addEventListener("keyup", (e) => this.onKeyUp(e), true);
    d.addEventListener("dragstart", (e) => e.preventDefault(), true);
    d.addEventListener("wheel", (e) => this.onWheel(e), { capture: true, passive: false });
    d.addEventListener("scroll", (e) => this.onScroll(e), true);
    // A touch drag is the terminal's, as a wheel is (SPEC §9); taps and long
    // presses stay the surface's.
    new Touch(d, this.frame.ownerDocument.defaultView!, {
      scroll: (dx, dy, x, y) => this.host.wheel(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: x, clientY: y }), x, y),
      toPage: (x, y) => {
        const r = this.frame.getBoundingClientRect();
        return [r.left + x, r.top + y];
      },
    });
    // The frame's own focus gives no keyboard: an element in it that takes
    // focus does (`onFocusIn`), or the program (SPEC §10.1).
    win.addEventListener("focus", () => {
      if (!this.programFocus && !this.auxPress && !this.keyboard) this.settle();
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
   * Nothing in a surface scrolls, and a wheel over it is the terminal's
   * (SPEC §5.3, §9). Wheel events never leave an iframe, so without this
   * the terminal's scrollback (or, on the alternate screen, the program's
   * wheel input) would stall under the pointer. Ctrl and the wheel stay the
   * browser's: its zoom.
   */
  private onWheel(e: WheelEvent) {
    if (e.ctrlKey) return;
    e.preventDefault();
    const r = this.frame.getBoundingClientRect();
    this.host.wheel(e, r.left + e.clientX, r.top + e.clientY);
  }

  /** Whatever the browser scrolled (a focused element into view, say) goes
   * back to zero. A text field's own text follows its caret (SPEC §5.3). */
  private onScroll(e: Event) {
    const t = e.target;
    if (t === this.doc) {
      const s = this.doc.scrollingElement;
      if (s && (s.scrollTop || s.scrollLeft)) s.scrollTo(0, 0);
      return;
    }
    if (!t || !isElement(t) || t.localName === "input" || t.localName === "textarea") return;
    if (t.scrollTop || t.scrollLeft) t.scrollTo(0, 0);
  }


  /** An event for the program (SPEC §9); a detached surface sends none (§5.5). */
  private emit(kind: string, target: string, detail?: unknown) {
    if (this.detachedState) return;
    this.host.event(this.name, kind, target, detail);
  }

  private linkIn(e: Event): Element | null {
    for (const n of e.composedPath()) {
      if (isElement(n) && n.localName === "a" && n.hasAttribute("href")) return n;
    }
    return null;
  }

  /** A link's `url` (SPEC §9): its href resolved against the document's
   * base, or "" under hotty.invalid or when it is no URL. */
  private urlOf(link: Element): string {
    const href = this.resolver.get(link, "href") ?? "";
    let url = "";
    try {
      url = new URL(href, this.base).href;
    } catch {
      /* not a URL */
    }
    return url.startsWith(NO_BASE) ? "" : url;
  }

  /** The link's box in the page (the iframe may be offset for a window). */
  private pageBox(el: Element): DOMRect {
    const f = this.frame.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return new DOMRect(f.left + r.left, f.top + r.top, r.width, r.height);
  }

  /** A link's click (SPEC §9). A hyperlink is the terminal's, as an OSC 8
   * one is, and not reported; any other link is the program's: an event,
   * with or without an id. The host opens nothing itself. */
  private onLink(link: Element, e: MouseEvent) {
    e.preventDefault();
    const url = this.urlOf(link);
    if (isHyperlink(link)) {
      if (url && e.button === 0) this.host.hyperlink("activate", e, url, this.pageBox(link));
      return;
    }
    const detail: Record<string, unknown> = { href: this.resolver.get(link, "href") ?? "" };
    if (url) detail.url = url;
    this.emit("click", link.getAttribute("id") ?? "", detail);
  }

  /** Other buttons on a link do nothing: no navigation, no new tab. */
  private onAuxClick(e: MouseEvent) {
    if (this.linkIn(e)) e.preventDefault();
  }

  private hovered: { link: Element; url: string } | null = null;

  /** The pointer onto a hyperlink: the terminal hears it, as it does over
   * an OSC 8 one. */
  private onOver(e: MouseEvent) {
    const link = this.linkIn(e);
    const hyper = link && isHyperlink(link) ? link : null;
    if (hyper === this.hovered?.link) return;
    this.onLeave(e);
    const url = hyper ? this.urlOf(hyper) : "";
    if (hyper && url) {
      this.hovered = { link: hyper, url };
      this.host.hyperlink("hover", e, url, this.pageBox(hyper));
    }
  }

  private onOut(e: MouseEvent) {
    const to = e.relatedTarget as Node | null;
    if (this.hovered && to && this.hovered.link.contains(to)) return;
    this.onLeave(e);
  }

  private onLeave(e: MouseEvent) {
    const h = this.hovered;
    if (!h) return;
    this.hovered = null;
    this.host.hyperlink("leave", e, h.url, this.pageBox(h.link));
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

/** A link with target="_blank": a hyperlink, the terminal's (SPEC §9). */
function isHyperlink(link: Element): boolean {
  return link.getAttribute("target") === "_blank";
}

/**
 * Whether a click focuses `el` (SPEC §10.1), unless it is disabled: `input`,
 * `select`, `textarea` and `button`; a link with an href, except a
 * hyperlink, which is the terminal's; the first summary of a details; an
 * editing host; any element with a tabindex of 0 or more.
 */
function takesFocus(el: Element): boolean {
  if (el.matches(":disabled")) return false;
  switch (el.localName) {
    case "button":
    case "select":
    case "textarea":
      return true;
    case "input":
      return (el as HTMLInputElement).type !== "hidden";
    case "a":
    case "area":
      if (el.hasAttribute("href")) return !isHyperlink(el);
      break;
    case "summary": {
      const d = el.parentElement;
      if (d?.localName === "details" && d.querySelector(":scope > summary") === el) return true;
      break;
    }
  }
  // An editing host: the element whose contenteditable makes it one.
  const ce = el.getAttribute("contenteditable");
  if (ce !== null && ce.toLowerCase() !== "false" && (el as HTMLElement).isContentEditable) return true;
  return el.hasAttribute("tabindex") && (el as HTMLElement).tabIndex >= 0;
}

/** The element a press focuses: the nearest one, from its target outward,
 * that takes focus, or a label's control; null if there is none, or if the
 * press is on a hyperlink. */
function focusTargetAt(e: Event): HTMLElement | null {
  for (const n of e.composedPath()) {
    if (!isElement(n)) continue;
    if (n.localName === "a" && n.hasAttribute("href") && isHyperlink(n)) return null;
    if (takesFocus(n)) return n as HTMLElement;
    const control = n.localName === "label" ? (n as HTMLLabelElement).control : null;
    if (control) return takesFocus(control) ? control : null;
  }
  return null;
}
