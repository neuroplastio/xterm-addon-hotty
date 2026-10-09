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
import { CLIP, MEASURE, scrollCss, UNCLIPPED } from "./hostcss.ts";
import { Deltas } from "./delta.ts";
import { Resolver } from "./resolver.ts";
import { cspSources, intersect, parse, type Policy } from "./network.ts";
import { NO_BASE, type Store } from "./resources.ts";
import { chars, elementKeymap, INSERT, inputKeys, isBreak, isSpace, type InputKey, MULTILINE_ACTIONS, plan, resolve, ROW_ACTIONS, type Rows, type Text } from "./keys.ts";

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
  /** What the terminal would send the program for a key, sent nowhere
   *  (SPEC §10.4: a text field names the key from it); null when the
   *  terminal cannot tell. */
  encodeKey(e: KeyboardEvent): string | null;
  /** Sends the program what `encodeKey` gave, as typed. */
  sendKey(data: string): void;
  /** A key the browser keeps (the `browserKeys` option): the surface
   *  leaves it to the browser rather than hand it to the terminal. */
  browserKey(e: KeyboardEvent): boolean;
  /** Gives the keyboard back to the terminal. */
  focusTerminal(): void;
  /** The host's half of the network policy (SPEC §7.2). */
  policy: Policy;
  /** The page scrolls, not the terminal (the `scroll` option): wheels and
   *  touch drags over the surface are left to the browser. */
  pageScrolls: boolean;
  /** The wheel gesture a wheel over a document that scrolls belongs to:
   *  where it began decides where the rest of it goes (`decide`, called for
   *  a gesture's first wheel), as a browser latches scrolling to what it
   *  began on. A gesture begun over the cells stays the terminal's. */
  wheelGesture(surface: string, decide: () => Route): Route;
  /** Scrolls the page by dx, dy pixels, where the page scrolls: for a
   *  gesture the browser would give an element of the document instead. */
  scrollPage(dx: number, dy: number): void;
  /** A hyperlink (SPEC §9: a link with target="_blank") was hovered, left
   *  or clicked: the terminal's, as an OSC 8 hyperlink is. `box` is the
   *  link's box in the page. */
  hyperlink(kind: "activate" | "hover" | "leave", e: MouseEvent, url: string, box: DOMRect): void;
  /** A wheel event over the surface, or a touch drag made one: the
   *  terminal's (SPEC §9), at a point in the page. */
  wheel(e: WheelEvent, pageX: number, pageY: number): void;
  /** A press with Alt held, a move of the gesture it began, or its release
   *  (SPEC §9.2): the program's, as on the cells beneath, at a point in the
   *  page. */
  cells(kind: "down" | "move" | "up", e: MouseEvent, pageX: number, pageY: number): void;
}

type Control = "none" | "text" | "textarea" | "date" | "select" | "activatable";

/** A drag under way (SPEC §9.1): the pointer it holds, the element that
 * started it, and the target, cell and keys the program heard of last. */
interface Drag {
  pointer: number;
  start: string;
  target: string;
  c: number;
  r: number;
  keys: string[];
}

/** The theme's colour scheme, as the host stylesheet declares it. */
export type Scheme = "dark" | "light";

/** Where a gesture or a key that scrolls goes in a document that scrolls
 * (SPEC §5.3): the document (an element of it that can still move that
 * way), the terminal, or nowhere (`overscroll-behavior` stopped it). */
export type Route = "doc" | "terminal" | "stop";

/** An element's cells, as the user sees it (SPEC §9: `area`). */
export interface Area {
  c: number;
  r: number;
  w: number;
  h: number;
}

/** A scroll by a key (SPEC §5.3: the keys a browser scrolls with), along
 * `axis`, `sign` its way: by a line, a page, or to the end. */
interface KeyScroll {
  axis: Axis;
  sign: 1 | -1;
  by: "line" | "page" | "end";
}

type Axis = "x" | "y";

/** A line of a key's scroll, in CSS pixels, as Chromium has it. */
const LINE_PX = 40;
/** The part of the box a page of a key's scroll moves, as Chromium has it. */
const PAGE_FRACTION = 0.875;

/** The inputs that are text fields (SPEC §10.2). A type the browser does
 * not know is `text`. */
const FIELD_TYPES = new Set(["text", "email", "password", "search", "tel", "url", "number"]);

/** Date and time inputs, which have keys of their own (§10.2). */
const DATE_TYPES = new Set(["date", "datetime-local", "month", "time", "week"]);

/** Text fields whose caret the browser keeps to itself (no selection API):
 * the live input is `text` while it is focused, so that the actions can
 * place the caret. The program still sees its own type. */
const NO_CARET = new Set(["email", "number"]);

/** The characters a number field types; others it takes and drops. */
const NUMBER_CHARS = /^[0-9.,+\-eE]$/;

/** The styles a textarea's rows depend on, copied to the copy that measures
 * them (`textareaRows`). */
const LAYOUT_STYLES = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "font-feature-settings",
  "font-kerning",
  "letter-spacing",
  "word-spacing",
  "line-height",
  "text-transform",
  "text-indent",
  "tab-size",
  "white-space",
  "overflow-wrap",
  "word-break",
  "direction",
  "text-align",
  "padding-left",
  "padding-right",
  "padding-top",
  "padding-bottom",
];

/** The form controls a detached surface disables (SPEC §5.5). */
const CONTROLS = "input, select, textarea, button";

/** The host's own attribute on a detached surface's hyperlinks, for its
 * stylesheet: whether a link is one depends on its `url` (SPEC §9). Under
 * the addon's vendor prefix: `data-hotty-*` is the spec's (§15). */
const HYPERLINK = "data-xterm-hotty-hyperlink";

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
a[href][${HYPERLINK}], a[href][${HYPERLINK}] * { cursor: pointer !important; }
}`;

export class Surface {
  readonly name: string;
  readonly box: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
  readonly doc: Document;
  readonly resolver: Resolver;
  readonly deltas: Deltas;
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
  /** A drag under way (SPEC §9.1). */
  private drag: Drag | null = null;
  /** A drag just ended at a release: it reported its own click, so the
   * browser's, which follows in the same task, is not reported. */
  private dragReleased = false;
  /** The placement asked for presses (`p=1`, SPEC §5.2). */
  presses = false;
  /** A mouse's or a pen's pointerdown came first: the mousedown that
   * follows is the same press, not a tap's. */
  private pointerPress = false;
  /** The pointer of a press with Alt held (SPEC §9.2), until its release:
   * the gesture is the program's. */
  private altPointer: number | null = null;
  /** Such a gesture just ended at a release: the browser's click that
   * follows in the same task is not the surface's. */
  private altReleased = false;
  /** One cell, in CSS pixels: a drag's detail counts cells (SPEC §9.1). */
  private cellW = 9;
  private cellH = 17;
  private css = "";
  /** Keys whose keydown went to the program, so their keyup follows. */
  private forwarded = new Set<string>();
  /** A run of row moves in a field (SPEC §10.2): the caret it left, and the
   * place along the row it keeps. Anything else that moves the caret ends
   * it. */
  private goal: { el: Element; caret: number; x: number } | null = null;
  /** The field shown as `text` while focused (`NO_CARET`). */
  private masked: HTMLInputElement | null = null;
  /** Tab is moving focus: the field it reaches selects its text. */
  private tabbing = false;
  /** The rows the program heard last, while the placement asked for `fit`
   * (`f=1`, SPEC §5.2); null when it did not. */
  private fitRows: number | null = null;
  /** The height may have changed since the last check. */
  private fitDirty = false;
  /** The frame a check waits for. */
  private fitFrame = 0;
  private fitObserver: ResizeObserver | null = null;
  /** The axes the document asked to scroll along (`scroll`, SPEC §5.1): 1
   * vertically, 2 horizontally, 3 both; 0, nothing scrolls. */
  private axes = 0;
  /** Where the touch drag under way goes, once it has a direction. */
  private touchRoute: Route = "terminal";
  /** The box the wheel gesture under way scrolls, if it went to the
   * document: the gesture moves no other (`scrollWheel`). */
  private wheelBox: Element | null = null;
  /** Some element may carry `CLIP`. */
  private clipping = false;

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
    this.deltas = new Deltas(doc, this.resolver);
    this.listen();
  }

  setHostCss(css: string, scheme: Scheme) {
    this.css = css;
    this.restyle();
    if (this.frame.style.colorScheme !== scheme) this.frame.style.colorScheme = scheme;
    this.refit(); // the cell size or the font
  }

  private restyle() {
    const css = [this.css, scrollCss(this.axes, this.host.pageScrolls), ...(this.detachedState ? [DETACHED_CSS] : [])].join("\n");
    if (this.hostStyle.textContent !== css) this.hostStyle.textContent = css;
    this.clip();
  }

  /** Replaces the whole document (`a=doc`): its head's styles and its body.
   * `detached` (`d=1`) detaches the surface first; without it, the surface
   * is the program's again (SPEC §5.1, §5.5). `axes` (`scroll`) are the
   * axes it scrolls along, 0 for none (§5.3). */
  setDocument(html: string, detached = false, axes = 0) {
    if (detached) this.detach();
    const scrolled = this.axes !== 0;
    this.axes = axes;
    const parsed = new DOMParser().parseFromString(html, "text/html");
    // The document's base and its network request (SPEC §7.2, §7.3) are read
    // before the resolver drops its <base> and <meta> elements; deltas can
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
    // A new document starts at the top left (SPEC §5.3). The root and the
    // body stay from one document to the next, and so would their offsets;
    // the previous document's are zero unless it scrolled.
    if (scrolled) {
      this.doc.documentElement.scrollTo(0, 0);
      this.doc.body.scrollTo(0, 0);
    }
    this.refit();
  }

  /** A delta (SPEC §6). On a detached surface, the controls it adds are
   * disabled too, and so is one whose `disabled` it removes. */
  delta(op: string, target: string | undefined, key: string | undefined, payload: string) {
    try {
      this.deltas.apply(op, target, key, payload);
    } finally {
      if (this.detachedState) this.sync();
      else this.clip();
      this.refit();
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
      this.dropDrag(); // it ends with nothing more reported (SPEC §9.1)
      const had = this.keyboard || this.frameFocused();
      this.keyboard = false;
      this.focusedControl()?.blur();
      if (had) this.giveBack();
    }
    this.sync();
  }

  /** Disables the form controls of a detached surface, as if each had the
   * `disabled` attribute, or enables those it disabled, and marks its
   * hyperlinks for the host's stylesheet. The attributes are the host's
   * own: the document reports the program's (SPEC §16). */
  private sync() {
    const detached = this.detachedState;
    for (const el of Array.from(this.doc.querySelectorAll(CONTROLS))) {
      if (!detached) this.resolver.removeOwn(el, "disabled");
      else if (!el.hasAttribute("disabled")) this.resolver.setOwn(el, "disabled", "");
    }
    for (const a of Array.from(this.doc.querySelectorAll("a"))) {
      if (detached && this.isHyperlink(a)) {
        if (!a.hasAttribute(HYPERLINK)) this.resolver.setOwn(a, HYPERLINK, "");
      } else this.resolver.removeOwn(a, HYPERLINK);
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
    return this.neededRows(cols, cellW, cellH);
  }

  /**
   * Rows the document needs at `cols` columns: `r=auto`'s, and `fit`'s
   * (SPEC §5.2). The frame is laid out at the width a placement gives it
   * and a height of 1px, so the viewport adds nothing, then restored in the
   * same task: nothing is drawn in between.
   */
  private neededRows(cols: number, cellW: number, cellH: number): number {
    const f = this.frame.style;
    const [width, height] = [f.width, f.height];
    // A document that scrolls would show its root's scrollbar at 1px, and
    // lay its content out narrower: the root is measured clipped.
    const root = this.doc.documentElement;
    if (this.axes) this.resolver.setOwn(root, MEASURE, "");
    Object.assign(f, { width: `${Math.round(cols * cellW)}px`, height: "1px" });
    const h = root.scrollHeight;
    Object.assign(f, { width, height });
    if (this.axes) this.resolver.removeOwn(root, MEASURE);
    return Math.max(1, Math.min(1000, Math.ceil(h / cellH)));
  }

  /**
   * In a document that scrolls along one axis only, the elements whose
   * `overflow` along the other is `auto` or `scroll` are marked (`CLIP`), so
   * that the host stylesheet clips that axis as `overflow: hidden` does
   * (SPEC §5.3): no scrollbar, and nothing the user does scrolls it. CSS
   * cannot select by a computed value, so the addon reads it, with its own
   * rule off (`UNCLIPPED`), each time the document or its style may have
   * changed: a document, a delta, the host stylesheet. Style only, no
   * layout, and only for a document with `scroll` of 1 or 2.
   */
  private clip() {
    const prop = this.axes === 1 ? "overflowX" : this.axes === 2 ? "overflowY" : null;
    if (!prop && !this.clipping) return;
    const marked = new Set(this.doc.querySelectorAll(`[${CLIP}]`));
    const want = new Set<Element>();
    if (prop) {
      const root = this.doc.documentElement;
      const win = this.frame.contentWindow!;
      this.resolver.setOwn(root, UNCLIPPED, "");
      for (const el of [this.doc.body, ...Array.from(this.doc.body.querySelectorAll("*"))]) {
        if (/auto|scroll/.test(win.getComputedStyle(el)[prop])) want.add(el);
      }
      this.resolver.removeOwn(root, UNCLIPPED);
    }
    for (const el of marked) if (!want.has(el)) this.resolver.removeOwn(el, CLIP);
    for (const el of want) if (!marked.has(el)) this.resolver.setOwn(el, CLIP, "");
    this.clipping = want.size > 0;
  }

  // --- Fit (SPEC §5.2: f=1 on a=place) --------------------------------------

  /**
   * `f=1` on the placement: from `rows`, the placement's own, the program
   * hears `fit` whenever the rows the document needs differ from those it
   * heard last. `null`: the placement did not ask (or is gone).
   *
   * What can change the height asks for a check in the next frame drawn:
   * a document, a delta, a resource (`refresh`), the host stylesheet (cell
   * size, font), an image, stylesheet or font loading, and, for whatever
   * else does (the user opening a `<details>`, say), the root's and the
   * body's boxes changing size. One check per frame, so one `fit` at most.
   */
  setFit(rows: number | null) {
    this.fitRows = rows;
    if (rows === null) {
      this.fitObserver?.disconnect();
      this.fitObserver = null;
      if (this.fitFrame) this.frame.ownerDocument.defaultView?.cancelAnimationFrame(this.fitFrame);
      this.fitFrame = 0;
      this.fitDirty = false;
      return;
    }
    if (!this.fitObserver) {
      this.fitObserver = new ResizeObserver(() => this.refit());
      this.fitObserver.observe(this.doc.documentElement);
      this.fitObserver.observe(this.doc.body);
    }
    this.refit();
  }

  /** The document's height may have changed: a check in the next frame
   * drawn. A surface out of view draws none; it checks once shown. */
  private refit() {
    if (this.fitRows === null) return;
    this.fitDirty = true;
    if (this.fitFrame || this.box.style.display === "none") return;
    this.fitFrame = this.frame.ownerDocument.defaultView!.requestAnimationFrame(() => {
      this.fitFrame = 0;
      this.checkFit();
    });
  }

  private checkFit() {
    if (this.fitRows === null || !this.fitDirty || this.box.style.display === "none") return;
    this.fitDirty = false;
    if (this.detachedState) return; // it sends no events (§5.5)
    const rows = this.neededRows(this.cols, this.cellW, this.cellH);
    if (rows === this.fitRows) return;
    this.fitRows = rows;
    this.emit("fit", "", { r: rows });
  }

  /** A resource changed (`a=res`, `a=del`): what names it resolves again. */
  refresh(names: Set<string>) {
    if (this.resolver.refresh(names)) this.refit();
  }

  /** The surface is `cols`×`rows` cells, and the box shows `win` of it:
   *  the document keeps the whole size, offset by the window's corner. */
  setSize(cols: number, rows: number, cellW: number, cellH: number, win: Window = { x: 0, y: 0, w: cols, h: rows }) {
    this.cols = cols;
    this.rows = rows;
    this.win = win;
    this.cellW = cellW;
    this.cellH = cellH;
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
    if (this.fitDirty) this.refit(); // what changed while out of view
  }

  /** Out of view (its line left the screen): a drag under way ends
   * (SPEC §9.1). */
  hide() {
    this.cancelDrag();
    this.dropAlt();
    this.box.style.display = "none";
  }

  /** No placement (hidden, or not placed yet): the document stays, and the
   *  browser skips its style, layout and paint until it is placed again. */
  park() {
    this.box.style.display = "none";
  }

  destroy() {
    this.setFit(null);
    this.dropDrag();
    this.dropAlt();
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
    const el = this.detachedState ? null : focusTargetAt(e, this.hyper);
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
    if (this.detachedState || this.pressNothing || !isElement(e.target as EventTarget) || !takesFocus(e.target as Element, this.hyper)) {
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
      const type = this.inputType(el as HTMLInputElement);
      if (FIELD_TYPES.has(type)) return "text";
      if (DATE_TYPES.has(type)) return "date";
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
      case "date":
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
    // A select's open list has every key, Escape and those its keymap gives
    // the program included (SPEC §10.2). Chromium's list keeps them from
    // the document anyway; where one reaches it, it is the list's.
    if (listOpen(this.focusedControl())) return;
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Tab moves between controls; past the last one it leaves the surface.
      const order = this.tabbable();
      const at = order.indexOf(this.doc.activeElement as HTMLElement);
      const leaving = order.length === 0 || (e.shiftKey ? at <= 0 : at === order.length - 1 || at < 0);
      if (leaving) {
        e.preventDefault();
        this.blur();
      } else {
        this.tabbing = true;
        setTimeout(() => (this.tabbing = false), 0);
      }
      return;
    }
    const active = this.focusedControl();
    const kind = this.controlKind(active);
    if (kind === "text" || kind === "textarea") {
      this.fieldKey(e, active!, kind === "textarea");
      return;
    }
    if (this.host.browserKey(e)) return; // the browser's: reload, zoom, …
    if (active && this.programKey(e, active)) return;
    if (this.consumes(e, kind)) return;
    if (this.axes && this.scrollKey(e)) return;
    this.forward(e);
  }

  /**
   * A key the focused element's keymap gives the program (SPEC §10.2, *Keys
   * for the program*), outside a text field: it reaches the program before
   * the element uses it (a select's arrows) and before the document
   * scrolls with it. The keymap is each `data-keys` from the root down to
   * the element, with no default, and only its `program` bindings count.
   * The key is named as in a text field (`fieldKey`).
   */
  private programKey(e: KeyboardEvent, el: Element): boolean {
    const values = keysValues(el);
    if (!values.some((v) => v.includes("program"))) return false;
    const keymap = elementKeymap(...values);
    const data = this.host.encodeKey(e);
    const keys: InputKey[] = data === null ? [{ key: domKeyName(e), data: "" }] : inputKeys(data);
    if (!keys.some((k) => k.key !== null && keymap.program(k.key))) return false;
    this.toProgram(e, data);
    return true;
  }

  /** A key the program has, as xterm.js encoded it (`data`; null when it
   * cannot say, and the key goes through it). Its release follows. */
  private toProgram(e: KeyboardEvent, data: string | null) {
    e.preventDefault();
    e.stopPropagation();
    this.forwarded.add(e.code);
    if (data === null) this.host.key(e);
    else if (data) this.host.sendKey(data);
  }

  // --- Text fields (SPEC §10.2, §10.4) ------------------------------------

  /** An input's type, as the browser has it; the program's for a field
   * that is `text` while focused (`NO_CARET`). */
  private inputType(el: HTMLInputElement): string {
    return el === this.masked ? (this.resolver.get(el, "type") ?? "").toLowerCase() : el.type;
  }

  /**
   * A key in a text field. It is named as the program would read it: from
   * what xterm.js would send the program for it, in the encoding the
   * program enabled, read as SPEC §10.4 says. The field's keymap (the
   * default, then each `data-keys` from the root to the field) says what
   * the field does with each key; what it does not use is the program's,
   * sent as xterm.js encoded it.
   */
  private fieldKey(e: KeyboardEvent, el: HTMLElement, multiline: boolean) {
    if (this.host.browserKey(e)) return; // the browser's: reload, zoom, …
    const data = this.host.encodeKey(e);
    const keys: InputKey[] = data === null ? [{ key: domKeyName(e), data: "" }] : inputKeys(data);
    const keymap = this.keymapOf(el, multiline);
    const uses = keys.map((k) => (k.key === null ? null : keymap.lookup(k.key)));
    if (uses.every((u) => u === null)) {
      // The program's, unless the document scrolls with it (SPEC §5.3); a
      // key bound to `program` is the program's first (§10.2).
      const program = keys.some((k) => k.key !== null && keymap.program(k.key));
      if (!program && this.axes && this.scrollKey(e)) return;
      this.toProgram(e, data);
      return;
    }
    const number = el.localName === "input" && this.inputType(el as HTMLInputElement) === "number";
    if (keys.length === 1) {
      const [use, key] = [uses[0], keys[0]!.key!];
      // A character, typed as the browser types it (input methods, the
      // undo history); Enter that submits, as the browser submits a form
      // with it (the default button's click, and `change` first).
      const typed = use === INSERT && !(number && !NUMBER_CHARS.test(keyText(key)));
      const enter = use === "submit" && e.key === "Enter" && el.localName === "input";
      if (typed || enter) {
        this.goal = null;
        return;
      }
    }
    e.preventDefault();
    e.stopPropagation();
    keys.forEach((k, i) => {
      const use = uses[i];
      if (use === null) {
        if (k.data) this.host.sendKey(k.data);
      } else if (use === INSERT) {
        const text = keyText(k.key!);
        if (!number || NUMBER_CHARS.test(text)) this.edit(el, multiline, { kind: "type", text });
      } else if (use === "submit") {
        this.goal = null;
        submitFrom(el);
      } else this.edit(el, multiline, { kind: "action", action: use });
    });
  }

  /** A field's keymap (SPEC §10.2): the default, then the `data-keys` of
   * each element from the root down to the field. */
  private keymapOf(el: Element, multiline: boolean) {
    return resolve(multiline, ...keysValues(el));
  }

  /** Does an action in a field, or types text in it. */
  private edit(el: HTMLElement, multiline: boolean, what: { kind: "action"; action: string } | { kind: "type"; text: string }) {
    if (what.kind === "action" && MULTILINE_ACTIONS.has(what.action) && !multiline) return;
    if (el.localName === "input" || el.localName === "textarea") this.editValue(el as HTMLInputElement | HTMLTextAreaElement, multiline, what);
    else this.editHost(el, what);
  }

  /** An input's or a textarea's value: the action's plan, applied with
   * the editing commands, so that the browser sends `input` (and `change`
   * when focus leaves) as for typing. */
  private editValue(el: HTMLInputElement | HTMLTextAreaElement, multiline: boolean, what: { kind: "action"; action: string } | { kind: "type"; text: string }) {
    const cl = chars(el.value);
    // Code units at each character boundary.
    const at = [0];
    for (const c of cl) at.push(at[at.length - 1]! + c.length);
    const index = (cu: number) => {
      let i = 0;
      while (i < cl.length && at[i + 1]! <= cu) i++;
      return i;
    };
    const start = index(el.selectionStart ?? el.value.length);
    const end = index(el.selectionEnd ?? el.value.length);
    if (what.kind === "type") {
      this.goal = null;
      this.replace(el, at[start]!, at[end]!, what.text);
      return;
    }
    const action = what.action;
    const password = el.localName === "input" && this.inputType(el as HTMLInputElement) === "password";
    const text: Text = { chars: cl, start, end, multiline, password };
    const g = this.goal;
    const goal = ROW_ACTIONS.has(action) && g && g.el === el && start === end && g.caret === start ? g.x : null;
    const rows = multiline && ROW_ACTIONS.has(action) ? this.textareaRows(el as HTMLTextAreaElement, cl) : null;
    const p = plan(text, action, rows, goal);
    this.goal = p.kind === "move" && p.goal !== undefined ? { el, caret: p.to, x: p.goal } : null;
    if (p.kind === "move") el.setSelectionRange(at[p.to]!, at[p.to]!);
    else if (p.kind === "replace") this.replace(el, at[p.from]!, at[p.to]!, p.text);
  }

  /** Replaces code units `from` to `to` of a field's value with `text`, the
   * caret after it, as typing does. */
  private replace(el: HTMLInputElement | HTMLTextAreaElement, from: number, to: number, text: string) {
    el.setSelectionRange(from, to);
    if (from === to && !text) return;
    const done = text ? this.doc.execCommand("insertText", false, text) : this.doc.execCommand("delete", false);
    if (done) return;
    el.setRangeText(text, from, to, "end");
    const win = this.frame.contentWindow as unknown as typeof globalThis;
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: text ? "insertText" : "deleteContent", data: text || null }));
  }

  /**
   * A textarea's rows as it lays them out (SPEC §10.2: a line that wraps is
   * several rows): a hidden copy of its text, wrapped as it wraps, with
   * every character in an element of its own, measured where each
   * position is. The place along a row is a position's x.
   */
  private textareaRows(el: HTMLTextAreaElement, cl: string[]): Rows {
    const win = this.frame.contentWindow!;
    const cs = win.getComputedStyle(el);
    const copy = this.doc.createElement("hotty-rows");
    for (const p of LAYOUT_STYLES) copy.style.setProperty(p, cs.getPropertyValue(p));
    const width = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    Object.assign(copy.style, {
      display: "block",
      position: "absolute",
      left: "0px",
      top: "0px",
      visibility: "hidden",
      boxSizing: "content-box",
      width: `${Math.max(width, 1)}px`,
      height: "auto",
      border: "0",
      margin: "0",
    });
    const cells = [...cl, "​"].map((c) => {
      const s = this.doc.createElement("hotty-c");
      s.style.cssText = "display:inline;margin:0;padding:0;border:0;font:inherit;letter-spacing:inherit";
      s.textContent = c;
      return s;
    });
    copy.append(...cells);
    this.doc.body.append(copy);
    const pos = cells.map((s) => {
      const r = s.getClientRects()[0] ?? s.getBoundingClientRect();
      return { x: r.left, y: Math.round(r.top) };
    });
    copy.remove();
    const tops = [...new Set(pos.map((p) => p.y))].sort((a, b) => a - b);
    const line = tops.length > 1 ? tops[1]! - tops[0]! : parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const shown = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const n = cl.length;
    return {
      page: Math.max(1, Math.round(shown / line)),
      move(from, by, goal) {
        const g = goal ?? pos[from]!.x;
        const r = tops.indexOf(pos[from]!.y) + by;
        if (r < 0) return { to: 0, goal: g };
        if (r >= tops.length) return { to: n, goal: g };
        let best = -1;
        for (let i = 0; i <= n; i++) {
          if (pos[i]!.y !== tops[r]) continue;
          if (best < 0 || Math.abs(pos[i]!.x - g) < Math.abs(pos[best]!.x - g)) best = i;
        }
        return { to: best, goal: g };
      },
    };
  }

  /**
   * An editing host (`contenteditable`): the actions with the selection's
   * own moves, a character at a time where they need to see the text, so
   * that words and lines are SPEC §10.2's, then the editing commands.
   */
  private editHost(host: HTMLElement, what: { kind: "action"; action: string } | { kind: "type"; text: string }) {
    this.goal = null;
    const sel = this.doc.getSelection();
    if (!sel || !sel.rangeCount) return;
    const d = this.doc;
    if (what.kind === "type") {
      d.execCommand("insertText", false, what.text);
      return;
    }
    const action = what.action;
    if (action === "newline") {
      d.execCommand("insertLineBreak", false);
      return;
    }
    const within = () => sel.focusNode !== null && host.contains(sel.focusNode);
    /** The character next to the selection's focus that way, if any. */
    const next = (dir: "backward" | "forward"): string => {
      const [an, ao, fn, fo] = [sel.anchorNode!, sel.anchorOffset, sel.focusNode!, sel.focusOffset];
      sel.collapse(fn, fo);
      sel.modify("extend", dir, "character");
      const c = within() ? sel.toString() : "";
      sel.setBaseAndExtent(an, ao, fn, fo);
      return c;
    };
    /** Moves (or extends) a character at a time while `go` holds. */
    const walk = (alter: "move" | "extend", dir: "backward" | "forward", go: (c: string) => boolean) => {
      for (let i = 0; i < 100_000; i++) {
        const c = next(dir);
        if (!c || !go(c)) return;
        sel.modify(alter, dir, "character");
      }
    };
    const back = (alter: "move" | "extend", unit: string) => {
      if (unit === "word") {
        walk(alter, "backward", isSpace);
        walk(alter, "backward", (c) => !isSpace(c));
      } else if (unit === "line") walk(alter, "backward", (c) => !isBreak(c));
      else sel.modify(alter, "backward", "character");
    };
    const forward = (alter: "move" | "extend", unit: string) => {
      if (unit === "word") {
        walk(alter, "forward", isSpace);
        walk(alter, "forward", (c) => !isSpace(c));
      } else if (unit === "line") walk(alter, "forward", (c) => !isBreak(c));
      else sel.modify(alter, "forward", "character");
    };
    if (action.startsWith("delete-")) {
      if (sel.isCollapsed) {
        const unit = action.includes("word") ? "word" : action.includes("line") ? "line" : "char";
        if (action.endsWith("backward") || action.endsWith("start")) back("extend", unit);
        else forward("extend", unit);
      }
      if (!sel.isCollapsed) d.execCommand("delete", false);
      return;
    }
    const backward = ["char-backward", "word-backward", "line-start", "line-previous", "page-up", "input-start"].includes(action);
    if (!sel.isCollapsed) {
      if (backward) sel.collapseToStart();
      else sel.collapseToEnd();
      if (action === "char-backward" || action === "char-forward") return;
    }
    const by = { "char-backward": "char", "char-forward": "char", "word-backward": "word", "word-forward": "word", "line-start": "line", "line-end": "line" }[action];
    if (by) {
      if (backward) back("move", by);
      else forward("move", by);
      return;
    }
    if (action === "input-start" || action === "input-end") {
      sel.modify("move", backward ? "backward" : "forward", "documentboundary");
      return;
    }
    if (ROW_ACTIONS.has(action)) {
      const rows = action.startsWith("page") ? Math.max(1, Math.round(host.clientHeight / (parseFloat(this.frame.contentWindow!.getComputedStyle(host).lineHeight) || 16))) : 1;
      for (let i = 0; i < rows; i++) {
        const [fn, fo] = [sel.focusNode, sel.focusOffset];
        sel.modify("move", backward ? "backward" : "forward", "line");
        if (sel.focusNode === fn && sel.focusOffset === fo) {
          // From the first row to the start, from the last to the end.
          sel.modify("move", backward ? "backward" : "forward", "documentboundary");
          return;
        }
      }
    }
  }

  /** A field that hides its caret (`NO_CARET`) is `text` while focused:
   * from the press that focuses it, so that the caret lands where the
   * press does, or from the focus. */
  private maskField(target: EventTarget | null, focusing: boolean) {
    const el = target as HTMLInputElement | null;
    if (!el || el.nodeType !== 1 || el.localName !== "input" || el === this.masked || this.detachedState) return;
    const type = (this.resolver.get(el, "type") ?? "").toLowerCase();
    if (!NO_CARET.has(type) || el.disabled) return;
    this.unmaskField();
    this.masked = el;
    this.resolver.mask(el, "type", "text");
    if (!el.hasAttribute("inputmode")) this.resolver.setOwn(el, "inputmode", type === "number" ? "decimal" : "email");
    // Focused without a press: as a browser focuses a text field, all of
    // it selected for Tab, the caret at the end otherwise.
    if (focusing) el.setSelectionRange(this.tabbing ? 0 : el.value.length, el.value.length);
  }

  private unmaskField() {
    const el = this.masked;
    if (!el) return;
    this.masked = null;
    this.resolver.removeOwn(el, "inputmode");
    this.resolver.unmask(el, "type");
  }

  /**
   * A key a browser scrolls with, in a document that scrolls (SPEC §5.3):
   * it scrolls the innermost box, from the focused element outward (from
   * the root when none is), that can still move that way. Where none can,
   * the key goes on to the program, as every key the surface does not use
   * does (§10.2), unless `overscroll-behavior` stops it. The addon scrolls
   * the box itself: the browser's own action could be the focused
   * element's instead (a radio button's arrows, a number field's).
   */
  private scrollKey(e: KeyboardEvent): boolean {
    const k = keyScroll(e);
    if (!k) return false;
    const to = this.scroller(this.focusedControl(), k.axis, k.sign);
    if (to === "terminal") return false;
    e.preventDefault();
    if (to === "stop") return true;
    const y = k.axis === "y";
    const by = k.by === "line" ? LINE_PX : k.by === "page" ? Math.max(1, (y ? to.clientHeight : to.clientWidth) * PAGE_FRACTION) : y ? to.scrollHeight : to.scrollWidth;
    to.scrollBy(y ? { top: k.sign * by } : { left: k.sign * by });
    return true;
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

  // --- Drags (SPEC §9.1) ----------------------------------------------------

  /**
   * A press of a mouse's or a pen's primary button on an element with
   * `drag` in its `data-on` (the nearest, from the pressed one outward, and
   * only if it has an id) starts a drag. The surface then holds the pointer
   * until the release: captured by its root element, which no delta
   * replaces, so every move comes here wherever it is (over the cells,
   * another surface, or outside the page), and nothing else hears it.
   */
  private onDragDown(e: PointerEvent) {
    // A press while a drag is under way: its release was lost.
    this.cancelDrag();
    if (this.detachedState || e.pointerType === "touch" || e.button !== 0 || !e.isPrimary) return;
    let start: Element | null = null;
    for (const n of e.composedPath()) {
      if (isElement(n) && listens(n, "drag")) {
        start = n;
        break;
      }
    }
    const id = start?.getAttribute("id");
    if (!id) return;
    const [c, r] = this.cellOf(e);
    const keys = keysOf(e);
    this.drag = { pointer: e.pointerId, start: id, target: id, c, r, keys };
    this.emit("dragstart", id, { c, r, keys });
    try {
      this.doc.documentElement.setPointerCapture(e.pointerId);
    } catch {
      /* the browser routes a pressed mouse to the frame anyway */
    }
  }

  /** A move during a drag: an event each time its target changes, and
   * while it has none, each time its cell does. */
  private onDragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    const [c, r] = this.cellOf(e);
    const target = this.dragTarget(this.elementAt(e, c, r));
    const keys = keysOf(e);
    if (target !== d.target || (target === "" && (c !== d.c || r !== d.r))) {
      this.emit("drag", target, { c, r, keys });
    }
    Object.assign(d, { target, c, r, keys });
  }

  /** The release ends the drag, wherever it is. Where it began, it is the
   * click it would have been without the drag; anywhere else, no click. */
  private onDragUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer || e.button !== 0) return;
    this.drag = null;
    const [c, r] = this.cellOf(e);
    const at = this.elementAt(e, c, r);
    const target = this.dragTarget(at);
    this.emit("dragend", target, { c, r, keys: keysOf(e) });
    // The browser's click goes where the capture was (the root), or to
    // where the press and the release meet: the drag reports its own.
    this.dragReleased = true;
    setTimeout(() => (this.dragReleased = false), 0);
    if (target === d.start && at) this.reportClick(ancestry(at));
  }

  /** The browser took the pointer away before the release. */
  private lostPointer(e: PointerEvent) {
    if (this.drag && e.pointerId === this.drag.pointer) this.cancelDrag();
    if (e.pointerId === this.altPointer) this.altPointer = null;
  }

  /**
   * Ends a drag under way without a release (SPEC §9.1: its placement went
   * away, a new document came, or the pointer was lost): `dragend` with no
   * target, at the last cell the program heard of.
   */
  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.dropDrag();
    this.emit("dragend", "", { c: d.c, r: d.r, keys: d.keys });
  }

  /** Ends a drag under way, silently (a detached or deleted surface). */
  private dropDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      if (this.doc.documentElement.hasPointerCapture(d.pointer)) this.doc.documentElement.releasePointerCapture(d.pointer);
    } catch {
      /* already released */
    }
  }

  /** The surface's cell under the pointer, from its top left (the frame's
   * origin), counting on past its edges. */
  private cellOf(e: MouseEvent): [number, number] {
    return [Math.floor(e.clientX / this.cellW), Math.floor(e.clientY / this.cellH)];
  }

  /** The element under the pointer, if it is in the window (SPEC §5.2). */
  private elementAt(e: MouseEvent, c: number, r: number): Element | null {
    const w = this.win;
    if (c < w.x || c >= w.x + w.w || r < w.y || r >= w.y + w.h) return null;
    return this.doc.elementFromPoint(e.clientX, e.clientY);
  }

  /** A drag's target: the nearest element with an id and `drag` in its
   * `data-on`, from `el` outward; "" where there is none. */
  private dragTarget(el: Element | null): string {
    for (let n = el; n; n = n.parentElement) {
      const id = n.getAttribute("id");
      if (id && listens(n, "drag")) return id;
    }
    return "";
  }

  // --- Presses with Alt (SPEC §9.2) ---------------------------------------

  /**
   * A press of a mouse's or a pen's primary button with Alt held is the
   * program's: the addon replays it on the cells beneath, and the surface
   * hears nothing of it (no press, drag, click, focus or selection; its
   * mousedown is cancelled). It holds the pointer until the release, as a
   * drag does, so every move and the release go to the cells, wherever the
   * pointer is. Whether it is the program's is decided here, at the press:
   * Alt let go later changes nothing.
   */
  private onAltDown(e: PointerEvent): boolean {
    if (e.pointerType === "touch" || e.button !== 0 || !e.altKey || !e.isPrimary) return false;
    this.cancelDrag(); // a drag whose release was lost
    this.dropAlt();
    this.pointerPress = true;
    this.altPointer = e.pointerId;
    // No longer hovered: a hyperlink under the pointer is left.
    this.onLeave(e);
    try {
      this.doc.documentElement.setPointerCapture(e.pointerId);
    } catch {
      /* the browser routes a pressed mouse to the frame anyway */
    }
    const [x, y] = this.toPage(e);
    this.host.cells("down", e, x, y);
    return true;
  }

  private onAltMove(e: PointerEvent): boolean {
    if (e.pointerId !== this.altPointer) return false;
    const [x, y] = this.toPage(e);
    this.host.cells("move", e, x, y);
    return true;
  }

  private onAltUp(e: PointerEvent): boolean {
    if (e.pointerId !== this.altPointer || e.button !== 0) return false;
    this.dropAlt();
    this.altReleased = true;
    setTimeout(() => (this.altReleased = false), 0);
    const [x, y] = this.toPage(e);
    this.host.cells("up", e, x, y);
    return true;
  }

  /** Ends such a gesture without a release: the frame goes away. */
  private dropAlt() {
    const p = this.altPointer;
    if (p === null) return;
    this.altPointer = null;
    try {
      if (this.doc.documentElement.hasPointerCapture(p)) this.doc.documentElement.releasePointerCapture(p);
    } catch {
      /* already released */
    }
  }

  /** A point of the frame's document in the page. */
  private toPage(e: MouseEvent): [number, number] {
    const r = this.frame.getBoundingClientRect();
    return [r.left + e.clientX, r.top + e.clientY];
  }

  /** `press` (SPEC §9), if the placement asked for it: `t` is the nearest
   * element with an id. A press on a hyperlink is the terminal's. */
  private reportPress(e: Event) {
    if (!this.presses) return;
    const link = this.linkIn(e);
    if (link && this.isHyperlink(link)) return;
    for (const n of e.composedPath()) {
      const id = isElement(n) ? n.getAttribute("id") : null;
      if (id) {
        this.emit("press", id, { area: this.areaOf(n as Element) });
        return;
      }
    }
    this.emit("press", "");
  }

  /**
   * The cells an element's border box covers as the user sees it, scrolled
   * included (SPEC §9: `area`), counted from the surface's top left cell:
   * whole, where it is clipped or scrolled away. An edge within half a
   * device pixel of a cell's is on it: layout rounds positions to fractions
   * of a pixel, and the user sees no less than a device pixel.
   */
  private areaOf(el: Element): Area {
    const b = el.getBoundingClientRect();
    const tol = 0.5 / (this.frame.ownerDocument.defaultView?.devicePixelRatio || 1);
    const c = Math.floor((b.left + tol) / this.cellW);
    const r = Math.floor((b.top + tol) / this.cellH);
    const right = Math.ceil((b.right - tol) / this.cellW);
    const bottom = Math.ceil((b.bottom - tol) / this.cellH);
    return { c, r, w: Math.max(0, right - c), h: Math.max(0, bottom - r) };
  }

  // --- Events for the program (PROTOCOL §8) --------------------------------

  private listen() {
    const d = this.doc;
    const win = this.frame.contentWindow!;
    // A drag's start comes before what the press causes (SPEC §9.1).
    d.addEventListener(
      "pointerdown",
      (e) => {
        if (this.onAltDown(e)) return;
        if (e.button === 0) this.maskField(e.target, false);
        this.pointerPress = e.pointerType !== "touch";
        if (this.pointerPress && e.button === 0 && e.isPrimary) this.reportPress(e);
        this.onDragDown(e);
        this.onPress(e);
      },
      true,
    );
    d.addEventListener("pointermove", (e) => this.onAltMove(e) || this.onDragMove(e), true);
    d.addEventListener("pointerup", (e) => this.onAltUp(e) || this.onDragUp(e), true);
    d.addEventListener("pointercancel", (e) => this.lostPointer(e), true);
    d.addEventListener("lostpointercapture", (e) => this.lostPointer(e), true);
    d.addEventListener(
      "mousedown",
      (e) => {
        if (this.altPointer !== null) {
          // The program's press (SPEC §9.2): no focus, no selection, no drag.
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        // A press with no pointerdown before it is a tap's (SPEC §9).
        if (!this.pointerPress && e.button === 0) this.reportPress(e);
        this.pointerPress = false;
        this.onPress(e);
      },
      true,
    );
    d.addEventListener("focusin", (e) => {
      this.maskField(e.target, true);
      this.onFocusIn(e);
    }, true);
    d.addEventListener("focusout", (e) => {
      if (e.target === this.masked) this.unmaskField();
    }, true);
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
    // An image or a stylesheet that loads late, a resource's or one fetched
    // from the network (SPEC §7.1, §7.2), and a font: the height may change.
    d.addEventListener("load", () => this.refit(), true);
    d.addEventListener("error", () => this.refit(), true);
    d.fonts.addEventListener("loadingdone", () => this.refit());
    // A touch drag is the terminal's, as a wheel is (SPEC §9); taps and long
    // presses stay the surface's. Where the page scrolls, the browser
    // scrolls it from here, as from the cells, but for a drag on an element
    // it would scroll instead (`inScroller`).
    const toPage = (x: number, y: number): [number, number] => {
      const r = this.frame.getBoundingClientRect();
      return [r.left + x, r.top + y];
    };
    // A document that scrolls (SPEC §5.3) is the browser's to pan: where it
    // can still move the way a drag goes, the drag is left to the browser,
    // which pans the document; where it cannot, the drag goes on to the
    // terminal, unless overscroll-behavior stops it. Where the page scrolls,
    // the browser chains the drag from the document to the page itself.
    if (this.host.pageScrolls) {
      new Touch(d, this.frame.ownerDocument.defaultView!, { scroll: (dx, dy) => this.host.scrollPage(dx, dy), toPage }, false, (e) =>
        !this.axes && this.inScroller(e.target),
      );
    } else {
      new Touch(d, this.frame.ownerDocument.defaultView!, {
        scroll: (dx, dy, x, y) => {
          if (this.touchRoute === "terminal") this.host.wheel(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: x, clientY: y }), x, y);
        },
        toPage,
        claim: (dx, dy, e) => {
          this.touchRoute = this.axes ? this.gestureRoute(e.target, dx, dy) : "terminal";
          return this.touchRoute !== "doc";
        },
      });
    }
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
   * browser's: its zoom. Where the page scrolls (the `scroll` option), the
   * wheel is the browser's too: nothing in the frame scrolls, so it scrolls
   * the page, as over the cells; but over an element it would scroll
   * instead, the surface scrolls the page itself.
   */
  private onWheel(e: WheelEvent) {
    if (e.ctrlKey) return;
    if (this.axes) {
      this.scrollWheel(e);
      return;
    }
    if (this.host.pageScrolls) {
      if (!this.inScroller(e.target)) return;
      e.preventDefault();
      const px = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 : e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 400;
      this.host.scrollPage(e.deltaX * px, e.deltaY * px);
      return;
    }
    e.preventDefault();
    const r = this.frame.getBoundingClientRect();
    this.host.wheel(e, r.left + e.clientX, r.top + e.clientY);
  }

  /** Whether a wheel or a touch at target would scroll an element of the
   * document, overflowing with `overflow: auto` or `scroll`: the browser
   * gives the gesture to it before the page, and nothing in a surface
   * scrolls (SPEC §5.3), so the gesture would go nowhere. */
  private inScroller(target: EventTarget | null): boolean {
    for (let n = target && isElement(target) ? target : null; n; n = n.parentElement) {
      const s = n.ownerDocument.defaultView!.getComputedStyle(n);
      const y = /auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight;
      const x = /auto|scroll/.test(s.overflowX) && n.scrollWidth > n.clientWidth;
      if (x || y) return true;
    }
    return false;
  }

  /**
   * A wheel over a document that scrolls (SPEC §5.3). A gesture's first
   * wheel decides where all of it goes, as a browser latches scrolling to
   * what it began on: while an element under the pointer can still move
   * that way, the browser scrolls it; where none can, the gesture goes on
   * to the terminal, as over the cells beneath (§9), unless
   * `overscroll-behavior` stops it. A gesture the document took goes no
   * further when it reaches the end there, as in a browser. Where the page
   * scrolls (the `scroll` option), the page is the terminal, and the
   * browser chains to it from the document natively. A wheel the browser
   * does not let the page cancel is the browser's already.
   */
  private scrollWheel(e: WheelEvent) {
    if (this.host.pageScrolls || !e.cancelable) return;
    const route = this.host.wheelGesture(this.name, () => {
      const to = this.gestureTarget(e.target, e.deltaX, e.deltaY);
      this.wheelBox = typeof to === "string" ? null : to;
      return typeof to === "string" ? to : "doc";
    });
    // The box the gesture began on, while it can still move: the browser's
    // own scrolling picks it again, the innermost under the pointer.
    const [axis, d] = mainAxis(e.deltaX, e.deltaY);
    if (route === "doc" && this.wheelBox && this.canMove(this.wheelBox, axis, d)) return;
    e.preventDefault();
    if (route !== "terminal") return;
    const r = this.frame.getBoundingClientRect();
    this.host.wheel(e, r.left + e.clientX, r.top + e.clientY);
  }

  /** Where a gesture that scrolls by dx, dy pixels at `target` goes, by its
   * main axis (SPEC §5.3). */
  private gestureRoute(target: EventTarget | null, dx: number, dy: number): Route {
    const to = this.gestureTarget(target, dx, dy);
    return typeof to === "string" ? to : "doc";
  }

  private gestureTarget(target: EventTarget | null, dx: number, dy: number): Element | "terminal" | "stop" {
    const [axis, d] = mainAxis(dx, dy);
    return this.scroller(target && isElement(target) ? target : null, axis, d);
  }

  /** Whether a box that scrolls can still move along `axis`, `d`'s way. */
  private canMove(el: Element, axis: Axis, d: number): boolean {
    if (!d || !(this.axes & (axis === "y" ? 1 : 2))) return false;
    const [at, span] = axis === "y" ? [el.scrollTop, el.scrollHeight - el.clientHeight] : [el.scrollLeft, el.scrollWidth - el.clientWidth];
    // Across a right-to-left box, scrollLeft runs from -span to 0.
    const rtl = axis === "x" && this.frame.contentWindow!.getComputedStyle(el).direction === "rtl";
    const [min, max] = rtl ? [-span, 0] : [0, span];
    return d > 0 ? at < max - 0.5 : at > min + 0.5;
  }

  /**
   * What a scroll along `axis`, `d`'s way, from `from` (an element, or the
   * root for none) moves in a document that scrolls (SPEC §5.3): the
   * innermost box, from `from` outward, that the user scrolls along it
   * (`overflow` `auto` or `scroll`; the root's, unless `hidden` or `clip`),
   * that overflows there, and that can still move that way. At a box that
   * cannot, the scroll stops if its `overscroll-behavior` is `contain` or
   * `none`, and goes on outward otherwise. Past the root, and along an axis
   * the document did not ask for, it is the terminal's.
   */
  private scroller(from: Element | null, axis: Axis, d: number): Element | "terminal" | "stop" {
    if (!d || !(this.axes & (axis === "y" ? 1 : 2))) return "terminal";
    const win = this.frame.contentWindow!;
    const root = this.doc.documentElement;
    const body = this.doc.body;
    const rootStyle = win.getComputedStyle(root);
    // The viewport takes the root's overflow, or the body's where the root's
    // is visible both ways; the body then scrolls nothing itself.
    const fromBody = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible";
    const prop = axis === "y" ? "overflowY" : "overflowX";
    for (let el: Element | null = from ?? root; el; el = el.parentElement) {
      if (el === body && fromBody) continue;
      const s = el === root ? rootStyle : win.getComputedStyle(el);
      const scrolls = el === root ? !/hidden|clip/.test((fromBody ? win.getComputedStyle(body) : s)[prop]) : /auto|scroll/.test(s[prop]);
      const span = axis === "y" ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      if (!scrolls || span < 1) continue;
      if (this.canMove(el, axis, d)) return el;
      const stops = axis === "y" ? s.overscrollBehaviorY : s.overscrollBehaviorX;
      if (stops === "contain" || stops === "none") return "stop";
    }
    return "terminal";
  }

  /** Whatever the browser scrolled along an axis the document did not ask
   * for (a focused element into view, say) goes back to zero. A text
   * field's own text follows its caret (SPEC §5.3). */
  private onScroll(e: Event) {
    if (this.axes === 3) return;
    const t = e.target;
    const el = t === this.doc ? this.doc.scrollingElement : t && isElement(t) ? t : null;
    if (!el || (t !== this.doc && (el.localName === "input" || el.localName === "textarea"))) return;
    const x = !(this.axes & 2) && el.scrollLeft !== 0;
    const y = !(this.axes & 1) && el.scrollTop !== 0;
    if (x || y) el.scrollTo(x ? 0 : el.scrollLeft, y ? 0 : el.scrollTop);
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

  /** A hyperlink (SPEC §9): a link with target="_blank" and a `url`. One
   * without a url is the program's, as any other link. */
  private isHyperlink(link: Element): boolean {
    return link.getAttribute("target") === "_blank" && this.urlOf(link) !== "";
  }

  private readonly hyper = (link: Element) => this.isHyperlink(link);

  /** A link's click (SPEC §9). A hyperlink is the terminal's, as an OSC 8
   * one is, and not reported; any other link is the program's: an event,
   * with or without an id. The host opens nothing itself. */
  private onLink(link: Element, e: MouseEvent) {
    e.preventDefault();
    const url = this.urlOf(link);
    if (this.isHyperlink(link)) {
      if (e.button === 0) this.host.hyperlink("activate", e, url, this.pageBox(link));
      return;
    }
    const detail: Record<string, unknown> = { href: this.resolver.get(link, "href") ?? "" };
    if (url) detail.url = url;
    detail.area = this.areaOf(link);
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
    if (this.altPointer !== null) return; // the program's gesture (SPEC §9.2)
    const link = this.linkIn(e);
    const hyper = link && this.isHyperlink(link) ? link : null;
    if (hyper === this.hovered?.link) return;
    this.onLeave(e);
    const url = hyper ? this.urlOf(hyper) : "";
    if (hyper) {
      this.hovered = { link: hyper, url };
      this.host.hyperlink("hover", e, url, this.pageBox(hyper));
    }
  }

  private onOut(e: MouseEvent) {
    if (this.altPointer !== null) return;
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
    if (this.altReleased) {
      // The release of a press with Alt held: the program's (SPEC §9.2).
      this.altReleased = false;
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (this.dragReleased) {
      // A drag's release: it reported its click itself (onDragUp).
      this.dragReleased = false;
      if (link) e.preventDefault();
      return;
    }
    if (link) {
      this.onLink(link, e);
      return;
    }
    this.reportClick(e.composedPath());
  }

  /** The click of the nearest element on `path` that reports one (SPEC §9). */
  private reportClick(path: EventTarget[]) {
    for (const n of path) {
      if (!isElement(n)) continue;
      if (n.localName === "a" && n.hasAttribute("href")) {
        // A link's own click (a drag's release on one): the program's, unless
        // it is a hyperlink, which is the terminal's.
        if (this.isHyperlink(n)) return;
        const url = this.urlOf(n);
        const detail: Record<string, unknown> = { href: this.resolver.get(n, "href") ?? "" };
        if (url) detail.url = url;
        detail.area = this.areaOf(n);
        this.emit("click", n.getAttribute("id") ?? "", detail);
        return;
      }
      const el = n;
      const tag = el.localName;
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      const wants = (el.getAttribute("data-on") ?? "").split(/\s+/).includes("click");
      const reportable = tag === "button" || tag === "a" || tag === "summary" || (tag === "input" && ["button", "submit", "reset"].includes(type)) || wants;
      if (!reportable) continue;
      const id = el.getAttribute("id");
      if (id) {
        const detail: Record<string, unknown> = {};
        const href = this.resolver.get(el, "href");
        if (href !== null) detail.href = href;
        const value = this.resolver.get(el, "value");
        if (value !== null) detail.value = value;
        detail.area = this.areaOf(el);
        this.emit("click", id, detail);
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

/** Whether `el`'s `data-on` lists `what`. */
function listens(el: Element, what: string): boolean {
  return (el.getAttribute("data-on") ?? "").split(/\s+/).includes(what);
}

/** `el` and its ancestors, as an event's path would have them. */
function ancestry(el: Element): Element[] {
  const out: Element[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) out.push(n);
  return out;
}

/** The modifier keys held, in the spec's order (SPEC §9.1). */
function keysOf(e: MouseEvent): string[] {
  const keys: string[] = [];
  if (e.shiftKey) keys.push("shift");
  if (e.ctrlKey) keys.push("ctrl");
  if (e.altKey) keys.push("alt");
  if (e.metaKey) keys.push("meta");
  return keys;
}

/**
 * Whether a click focuses `el` (SPEC §10.1), unless it is disabled: `input`,
 * `select`, `textarea` and `button`; a link with an href, except a
 * hyperlink (`hyper`), which is the terminal's whatever its tabindex; the
 * first summary of a details; an editing host; any element with a tabindex
 * of 0 or more.
 */
function takesFocus(el: Element, hyper: (link: Element) => boolean): boolean {
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
      if (el.hasAttribute("href")) return !hyper(el);
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
function focusTargetAt(e: Event, hyper: (link: Element) => boolean): HTMLElement | null {
  for (const n of e.composedPath()) {
    if (!isElement(n)) continue;
    if (n.localName === "a" && n.hasAttribute("href") && hyper(n)) return null;
    if (takesFocus(n, hyper)) return n as HTMLElement;
    const control = n.localName === "label" ? (n as HTMLLabelElement).control : null;
    if (control) return takesFocus(control, hyper) ? control : null;
  }
  return null;
}

/** A scroll's main axis, and its delta along it. */
function mainAxis(dx: number, dy: number): [Axis, number] {
  return Math.abs(dy) >= Math.abs(dx) ? ["y", dy] : ["x", dx];
}

/** The scroll a key makes in a browser, if it makes one (SPEC §5.3): the
 * arrows by a line, Page Up, Page Down, Space and Shift+Space by a page,
 * Home and End to the ends. */
function keyScroll(e: KeyboardEvent): KeyScroll | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.shiftKey) return e.key === " " ? { axis: "y", sign: -1, by: "page" } : null;
  switch (e.key) {
    case "ArrowDown":
      return { axis: "y", sign: 1, by: "line" };
    case "ArrowUp":
      return { axis: "y", sign: -1, by: "line" };
    case "ArrowRight":
      return { axis: "x", sign: 1, by: "line" };
    case "ArrowLeft":
      return { axis: "x", sign: -1, by: "line" };
    case "PageDown":
    case " ":
      return { axis: "y", sign: 1, by: "page" };
    case "PageUp":
      return { axis: "y", sign: -1, by: "page" };
    case "End":
      return { axis: "y", sign: 1, by: "end" };
    case "Home":
      return { axis: "y", sign: -1, by: "end" };
  }
  return null;
}

/** Whether `el` is a select with its list open (`:open`, where the browser
 * has it). */
function listOpen(el: Element | null): boolean {
  if (el?.localName !== "select") return false;
  try {
    return el.matches(":open");
  } catch {
    return false;
  }
}

/** The `data-keys` of each element from the root down to `el`, its own
 * last (SPEC §10.2). */
function keysValues(el: Element): string[] {
  const values: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    const v = n.getAttribute("data-keys");
    if (v !== null) values.unshift(v);
  }
  return values;
}

/** The text a character key types (`Space` is a space). */
function keyText(key: string): string {
  const v = key.endsWith("++") ? "+" : key.slice(key.lastIndexOf("+") + 1);
  return v === "Space" ? " " : v;
}

/** A key's name from the DOM's event (SPEC §10.4), for a terminal that
 * cannot say what it would send: the modifiers, then the key's value, Shift
 * left out before a character. */
function domKeyName(e: KeyboardEvent): string {
  const char = [...e.key].length === 1;
  const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.metaKey && "Meta", e.shiftKey && !char && "Shift"].filter(Boolean);
  return [...mods, e.key === " " ? "Space" : e.key].join("+");
}

/**
 * Submits a field's form as Enter in a text field does (HTML's implicit
 * submission): through its default button, which is clicked; with none,
 * the form itself, unless more than one of its fields would take Enter.
 */
function submitFrom(el: HTMLElement) {
  const form = (el as HTMLInputElement).form ?? el.closest("form");
  if (!form) return;
  const controls = Array.from(form.elements) as HTMLInputElement[];
  const button = controls.find((c) => (c.localName === "button" && (c.type || "submit") === "submit") || (c.localName === "input" && (c.type === "submit" || c.type === "image")));
  if (button) {
    if (!button.disabled) button.click();
    return;
  }
  const blocking = controls.filter((c) => c.localName === "input" && (FIELD_TYPES.has(c.type) || DATE_TYPES.has(c.type)));
  if (blocking.length <= 1) form.requestSubmit();
}
