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

import { LONG_PRESS_MS, panBlocked, Touch, type TouchBegin, touchPans } from "./touch.ts";
import { parseSteps, stepAt } from "./steps.ts";
import { CLIP, MEASURE, rootTouchAction, scrollCss, UNCLIPPED } from "./hostcss.ts";
import { type DeltaError, Deltas, type Op, type Reveal } from "./delta.ts";
import { atEnd, rendered, reveal, shows, slack } from "./view.ts";
import { Resolver } from "./resolver.ts";
import type { Body, Value } from "./msgpack.ts";
import { cspSources, intersect, parse, type Policy } from "./network.ts";
import { NO_BASE, type Store } from "./resources.ts";
import { edited, type FieldState, History, type Run, runOf, stateOf, step } from "./history.ts";
import { byteAt, clusterStart, type FieldChange, FieldError, readField, type Sel, unitAt, wireSel } from "./field.ts";
import { chars, elementKeymap, INSERT, inputKeys, isBreak, isSpace, type InputKey, type Keymap, keyText, MULTILINE_ACTIONS, NOT_KEYS, type Platform, plan, pressNames, resolve, ROW_ACTIONS, type Rows, type Text } from "./keys.ts";

/** A surface's CSP: nothing from the network but what the host grants, and
 * the host's font (`fonts`, a directory, or ""). The `<base>` is the addon's
 * own (a document's is read, then dropped), so any http(s) base is allowed. */
export function csp(host: Policy, fonts = ""): string {
  const with_ = (fixed: string, d: keyof Policy) => [fixed, cspSources(host, d)].filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    with_("img-src data: blob:", "img-src"),
    with_("media-src data: blob:", "media-src"),
    with_(["font-src data: blob:", cspPath(fonts)].filter(Boolean).join(" "), "font-src"),
    with_("style-src 'unsafe-inline' blob:", "style-src"),
    "form-action 'none'",
    "base-uri http: https:",
  ].join("; ");
}

/** A URL as a CSP source: what CSP takes as a delimiter is escaped (a
 * space, `;`, `,`), so it stays one source and can't add a directive. */
function cspPath(url: string): string {
  return url.replace(/[\s;,]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
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
  /** Sends a hotty message (an event) to the program, with its detail
   *  (SPEC §9), if it has one. */
  event(surface: string, kind: string, target: string, detail?: Body): void;
  /** A key the surface does not use (a keydown or its keyup), for the
   *  terminal to send to the program as if typed there (SPEC §10.2). */
  key(e: KeyboardEvent): void;
  /** What the terminal would send the program for a key, sent nowhere
   *  (SPEC §10.4: a text field names the key from it); null when the
   *  terminal cannot tell. */
  encodeKey(e: KeyboardEvent): string | null;
  /** Sends the program what `encodeKey` gave, as typed. */
  sendKey(data: string): void;
  /** How keys are read (SPEC §10.4): the platform. */
  keys: KeySettings;
  /** A key that reaches the program while it takes the edit command the
   *  key is a shortcut of (SPEC §10.6): the host sent the command, and the
   *  key goes no further. */
  command(e: KeyboardEvent): boolean;
  /** A key typed in the surface (SPEC §10.7): the program's menu is hidden
   *  by Escape and by a key it does not list. */
  typed(e: KeyboardEvent): void;
  /** A key the browser keeps (the `browserKeys` option): the surface
   *  leaves it to the browser rather than hand it to the terminal. */
  browserKey(e: KeyboardEvent): boolean;
  /** A copy key while something is selected (SPEC §11): the host copied
   *  it, and the key goes no further. */
  copyKey(e: KeyboardEvent): boolean;
  /** Puts text on the clipboard: a text field's `cut` (SPEC §10.2). */
  writeClipboard(text: string): void;
  /** The clipboard's text, for a text field's `paste` where the browser
   *  does not paste with the key itself; null when it cannot be read. */
  readClipboard(): Promise<string | null>;
  /** A press of the primary button on surface `keep`, or with Alt (null,
   *  the cells'): there is one selection (SPEC §11), so every other one is
   *  dropped. */
  pressed(keep: string | null): void;
  /** Gives the keyboard back to the terminal. */
  focusTerminal(): void;
  /** A click (SPEC §10.1) in surface `name`: an `a=focus` that waits in
   *  another surface ends, and the keyboard goes back. */
  clicked(name: string): void;
  /** The host's half of the network policy (SPEC §7.2). */
  policy: Policy;
  /** The directory of the host's font (the `fonts` option), or "". */
  fonts: string;
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
  /** A click's place in its run of clicks (SPEC §9), from the platform's
   *  count, a MouseEvent's `detail` (0 from the keyboard): a run starts
   *  again on another element or another surface. */
  clickCount(surface: string, el: Element, detail: number): number;
  /** A wheel event over the surface, or a touch drag made one: the
   *  terminal's (SPEC §9), at a point in the page. */
  wheel(e: WheelEvent, pageX: number, pageY: number): void;
  /** A press with Alt held, a move of the gesture it began, or its release
   *  (SPEC §9.2): the program's, as on the cells beneath, at a point in the
   *  page. */
  cells(kind: "down" | "move" | "up", e: MouseEvent, pageX: number, pageY: number): void;
}

export interface KeySettings {
  platform: Platform;
}

type Control = "none" | "text" | "textarea" | "date" | "select" | "activatable";

/** A drag under way (SPEC §9.1): the pointer it holds, the element that
 * started it, its steps if it has them, and the target, cell, modifiers, step and
 * step in the target the program heard of last. */
interface Drag {
  pointer: number;
  start: string;
  steps: Steps | null;
  target: string;
  c: number;
  r: number;
  mods: number | undefined;
  step: Step;
  tstep: TargetStep;
  /** The press's place in its run of clicks, as the browser counts them
   * (its mousedown's `detail`): the click the drag reports where it began
   * carries it (SPEC §9). */
  clicks: number;
}

/** The steps of the element a drag started on (SPEC §9.1): the element, and
 * its counts when the drag started, 0 for none along that axis. */
interface Steps {
  el: Element;
  x: number;
  y: number;
}

/** Where in the dragged element the pointer is, in its steps: `x` and `y`,
 * each only along an axis it has steps on. */
type Step = { x?: number; y?: number };

/** Where in a drag's target the pointer is, in the target's steps: `tx` and
 * `ty`, each only along an axis it has steps on. */
type TargetStep = { tx?: number; ty?: number };

/** The theme's colour scheme, as the host stylesheet declares it. */
export type Scheme = "dark" | "light";

/** Where a gesture or a key that scrolls goes in a document that scrolls
 * (SPEC §5.3): the document (an element of it that can still move that
 * way), the terminal, or nowhere (`overscroll-behavior` stopped it). */
export type Route = "doc" | "terminal" | "stop";

/** An element's cells, as the user sees it (SPEC §9: `area`). */
export type Area = {
  c: number;
  r: number;
  w: number;
  h: number;
};

/** A scroll by a key (SPEC §5.3: the keys a browser scrolls with; §10.2:
 * the scroll actions), along `axis`, `sign` its way: by a line, a page,
 * half a page, or to the end. */
interface KeyScroll {
  axis: Axis;
  sign: 1 | -1;
  by: "line" | "page" | "half" | "end";
}

/** What each scroll action does (SPEC §10.2, *Scrolling keys*): as the
 * arrows, the page keys, and Home and End scroll, and half pages. */
const SCROLL_ACTIONS: Record<string, KeyScroll> = {
  "scroll-up": { axis: "y", sign: -1, by: "line" },
  "scroll-down": { axis: "y", sign: 1, by: "line" },
  "scroll-left": { axis: "x", sign: -1, by: "line" },
  "scroll-right": { axis: "x", sign: 1, by: "line" },
  "scroll-page-up": { axis: "y", sign: -1, by: "page" },
  "scroll-page-down": { axis: "y", sign: 1, by: "page" },
  "scroll-half-page-up": { axis: "y", sign: -1, by: "half" },
  "scroll-half-page-down": { axis: "y", sign: 1, by: "half" },
  "scroll-start": { axis: "y", sign: -1, by: "end" },
  "scroll-end": { axis: "y", sign: 1, by: "end" },
};

type Axis = "x" | "y";

/** Whether the browser says when a scroll comes to rest (`scrollend`). */
const SCROLL_ENDS = typeof window !== "undefined" && "onscrollend" in window;
/** Where it does not, a scroll is at rest once nothing has scrolled for
 * this long (SPEC §9.5): a gesture's momentum scrolls every frame. */
const SCROLL_REST_MS = 150;
/** Where it does, this long without a scroll stands for a `scrollend` that
 * never came. */
const SCROLL_REST_LONG_MS = 600;

/** A line of a key's scroll, in CSS pixels, as Chromium has it. */
const LINE_PX = 40;
/** The part of the box a page of a key's scroll moves, as Chromium has it. */
const PAGE_FRACTION = 0.875;

/** The inputs that are text fields (SPEC §10.2). A type the browser does
 * not know is `text`. */
const FIELD_TYPES = new Set(["text", "email", "password", "search", "tel", "url", "number"]);

/** What a field is asked to do: an action, with Shift (`extend`) or
 * without, or typing. */
type Edit = { kind: "action"; action: string; extend?: boolean } | { kind: "type"; text: string };

/** Date and time inputs, which have keys of their own (§10.2). */
const DATE_TYPES = new Set(["date", "datetime-local", "month", "time", "week"]);

/** Text fields whose caret the browser keeps to itself (no selection API):
 * the live input is `text` while it is focused, so that the actions can
 * place the caret. The program still sees its own type. */
const NO_CARET = new Set(["email", "number"]);

/** The characters a number field types; others it takes and drops. */
const NUMBER_CHARS = /^[0-9.,+\-eE]$/;

/** On a Mac, Command pastes; elsewhere, Control (SPEC §10.4's Meta). */
const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

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
  /** `a=focus` came while the page's focus was outside the terminal: the
   * surface has the keyboard, and takes the browser's focus, at this
   * element id ("" for none), once the terminal has it. Null when nothing
   * waits. */
  private waiting: string | null = null;
  /** The element the program knows has focus: the last `focus` named it,
   * or the program's `a=focus` gave it (SPEC §10.1). */
  private told: Element | null = null;
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
  /** The program asked for presses (`p=1`, SPEC §5.2): the surface's, held
   * until it sends `p=0`. */
  presses = false;
  /** And for `fit` (`f=1`), held in the same way. */
  fits = false;
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
  /** Each text field's history of edits (SPEC §10.2, undo). */
  private histories = new WeakMap<Element, History>();
  /** The edit under way, from its `beforeinput` or from `replace`, which
   *  its `input` puts in the field's history. */
  private pending: { el: Element; before: FieldState; run: Run } | null = null;
  /** `replace` is editing: the edit is pending already. */
  private editing = false;
  /** The field shown as `text` while focused (`NO_CARET`). */
  private masked: HTMLInputElement | null = null;
  /** Each control's `rev` (SPEC §6.4): the changes the user made to it
   * since it entered the document. A radio group's is its buttons'
   * highest (`revOf`). */
  private revs = new WeakMap<Element, number>();
  /** Text fields the user edited since they were focused or last sent
   * `change`: focus leaving commits only theirs (SPEC §6.4, no echo). */
  private dirty = new WeakSet<Element>();
  /** Controls whose `input` counted a pick or a value, which the `change`
   * after it carries without counting it again. */
  private picked = new WeakSet<Element>();
  /** A text field's selection while it is not focused (SPEC §10.2), which
   * `a=focus` gives back; none is the caret at the end of its value. */
  private kept = new WeakMap<Element, Sel>();
  /** What the program last heard of a field with `data-on~=caret`: its
   * selection, in bytes, and its `rev` (SPEC §9, `caret`). None is the
   * caret at the end and `rev` 0, as the field entered the document. */
  private heard = new WeakMap<Element, { sel: [number, number]; rev: number }>();
  /** The field whose selection the next frame checks (`caret`), and that
   * frame. */
  private caretField: Element | null = null;
  private caretFrame = 0;
  /** The field an input method composes text in: `a=field` is stale
   * meanwhile (SPEC §6.4). */
  private composing: Element | null = null;
  /** `a=field` is changing a control: the events that fire are not the
   * user's. */
  private applying = false;
  /** Tab is moving focus: the field it reaches selects its text. */
  private tabbing = false;
  /** A prefix is on (SPEC §10.5): every key reaches the program, whatever is
   * focused, until the program sends `a=focus` or `a=blur`, the surface
   * loses the keyboard, or the user focuses an element with a press. */
  private prefix = false;
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
  /** Where the touch drag under way goes, once it has a direction: "self",
   * the document, but scrolled by the surface, since the document's
   * `touch-action` would stop the browser's own pan (SPEC §9.1: it changes
   * nothing there). */
  private touchRoute: Route | "self" = "terminal";
  /** The box a touch drag scrolls itself ("self"). */
  private touchBox: Element | null = null;
  /** The box the wheel gesture under way scrolls, if it went to the
   * document: the gesture moves no other (`scrollWheel`). */
  private wheelBox: Element | null = null;
  /** Some element may carry `CLIP`. */
  private clipping = false;
  /** Placed (SPEC §5.2), from `a=place` until the placement goes: drawn or
   * not, as the terminal scrolls it in and out of view (§5.4). */
  private placed = false;
  /** What the program heard last of which elements are in view (`view`,
   * SPEC §9.5), as `checkView` compares it, across placements; null when it
   * has heard nothing of this document. */
  private viewSent: string | null = null;
  /** What is in view may have changed since the last check. */
  private viewDirty = false;
  /** The frame a check waits for. */
  private viewFrame = 0;
  /** What notices the elements that report whether they are in view
   * changing size, or coming into the window or leaving it, whatever moved
   * them, once one asks; and the elements they watch. */
  private viewObservers: { size: ResizeObserver; window: IntersectionObserver } | null = null;
  private viewWatched = new Set<Element>();
  /** The boxes that scroll now (the document, for its root), until each
   * comes to rest (`scrollend`), or, where the browser tells no rest, until
   * none has moved for a while (`restTimer`). */
  private moving = new Set<EventTarget>();
  private restTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.frame.setAttribute("title", `hotty surface ${name}`);
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
        `<meta http-equiv="Content-Security-Policy" content="${csp(host.policy, host.fonts)}">` +
        `<base href="${NO_BASE}"><style id="hotty-host"></style></head><body></body></html>`,
    );
    doc.close();
    this.doc = doc;
    this.hostStyle = doc.getElementById("hotty-host") as HTMLStyleElement;
    this.css = hostCss;
    this.restyle();
    this.resolver = new Resolver(host.store);
    this.deltas = new Deltas(doc, this.resolver, (el, where) => this.reveal(el, where), (el) => this.valueSet(el));
    this.listen();
  }

  setHostCss(css: string, scheme: Scheme) {
    this.css = css;
    this.restyle();
    if (this.frame.style.colorScheme !== scheme) this.frame.style.colorScheme = scheme;
    this.relayout(); // the cell size or the font
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
    // A new document sends a view once it is laid out (SPEC §9.5).
    this.viewSent = null;
    this.relayout();
  }

  /** A delta (SPEC §6.1): its ops in order, as one unit, and the first that
   * failed, if any. On a detached surface, the controls it adds are
   * disabled too, and so is one whose `disabled` it removes. */
  delta(ops: Op[]): DeltaError | null {
    try {
      return this.deltas.apply(ops);
    } finally {
      if (this.detachedState) this.sync();
      else this.clip();
      this.relayout();
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
      const had = (this.keyboard && this.waiting === null) || this.frameFocused();
      this.prefix = false;
      this.keyboard = false;
      this.waiting = null;
      this.told = null;
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
   * `f=1` on the surface: from `rows`, the placement's own, the program
   * hears `fit` whenever the rows the document needs differ from those it
   * heard last. `null`: the surface did not ask, or has no placement.
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
    if (this.resolver.refresh(names)) this.relayout();
  }

  /** The layout may have changed: `fit` and `view` check it in the next
   * frame drawn. */
  private relayout() {
    this.refit();
    this.requestView();
  }

  // --- Reveal and view (SPEC §6.1, §9.5) -----------------------------------

  /**
   * A placement begins (`a=place`, SPEC §5.2). Its first `view` goes out
   * once the document is laid out in it and drawn, if what it carries
   * differs from what the program last heard (§9.5). Placing again, a new
   * window, is a new placement.
   */
  beginPlacement() {
    this.endPlacement();
    this.placed = true;
    this.requestView();
  }

  /** The placement goes (`a=hide`, `a=del`, its line gone): no `view` until
   * the next, which reports how what it carries differs from what the
   * program last heard (SPEC §9.5). */
  endPlacement() {
    this.placed = false;
    this.viewDirty = false;
    if (this.viewFrame) this.frame.ownerDocument.defaultView?.cancelAnimationFrame(this.viewFrame);
    this.viewFrame = 0;
    this.viewObservers?.size.disconnect();
    this.viewObservers?.window.disconnect();
    this.viewObservers = null;
    this.viewWatched.clear();
    this.moving.clear();
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
  }

  /**
   * `reveal` (SPEC §6.1): scrolls the boxes that hold `el`, along the axes
   * the document scrolls. A surface not placed has nothing in view to bring
   * it into, and scrolls nothing. One placed but out of view (§5.4) is laid
   * out unseen for it, as `r=auto` measures, and its offsets stay as it is
   * hidden again (as hiding keeps them).
   */
  private reveal(el: Element, where: Reveal) {
    if (!this.placed || !this.axes) return;
    const box = this.box.style;
    const out = box.display === "none";
    const visibility = box.visibility;
    if (out) Object.assign(box, { display: "block", visibility: "hidden" });
    try {
      reveal(el, where, this.axes, 0.5 / (this.frame.ownerDocument.defaultView?.devicePixelRatio || 1));
    } finally {
      if (out) Object.assign(box, { display: "none", visibility });
    }
  }

  /**
   * What is in view may have changed (SPEC §9.5): a check in the next frame
   * drawn, once every scroll under way has come to rest. One check per
   * frame, so one `view` at most. A placement out of view draws no frame,
   * and checks once it is shown again.
   */
  private requestView() {
    if (!this.placed) return;
    this.viewDirty = true;
    if (this.viewFrame || this.moving.size || this.box.style.display === "none") return;
    this.viewFrame = this.frame.ownerDocument.defaultView!.requestAnimationFrame(() => {
      this.viewFrame = 0;
      this.checkView();
    });
  }

  /** A box scrolled (SPEC §9.5): what is in view waits for it to rest. */
  private viewScrolled(e: Event) {
    if (!this.placed || !e.target) return;
    this.moving.add(e.target);
    this.viewDirty = true;
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = setTimeout(() => this.rested(), SCROLL_ENDS ? SCROLL_REST_LONG_MS : SCROLL_REST_MS);
  }

  /** A box came to rest (`scrollend`): once all have, what is in view is
   * checked. */
  private scrollEnded(e: Event) {
    if (e.target && this.moving.delete(e.target) && !this.moving.size) this.rested();
  }

  private rested() {
    if (this.restTimer) clearTimeout(this.restTimer);
    this.restTimer = null;
    this.moving.clear();
    this.requestView();
  }

  /**
   * `view` (SPEC §9.5), if what it would carry changed since the program
   * last heard it: every element with `view` in its `data-on` and an id
   * that is in view, with its area, and `end`. A document with none that
   * asks sends none. A detached surface sends none (§5.5).
   */
  private checkView() {
    if (!this.placed || !this.viewDirty || this.moving.size || this.box.style.display === "none") return;
    this.viewDirty = false;
    if (this.detachedState) return;
    const asks = Array.from(this.doc.querySelectorAll("[data-on~=view][id]")).filter((el) => el.id !== "");
    this.watchViews(asks);
    if (!asks.length) {
      this.viewSent = null;
      return;
    }
    const inView: Record<string, Area> = Object.create(null);
    const shown = this.shownRect();
    const dpr = this.frame.ownerDocument.defaultView?.devicePixelRatio || 1;
    const tol = (edge: number, axis: Axis) => slack(edge, axis === "x" ? this.cellW : this.cellH, dpr);
    for (const el of asks) {
      // Two elements of one id are one handle: the first in view stands.
      if (el.id in inView || !el.id.isWellFormed() || !rendered(el) || !shows(el, shown, tol)) continue;
      inView[el.id] = this.areaOf(el);
    }
    const end = atEnd(this.doc, this.axes);
    const key = JSON.stringify([end, Object.keys(inView).sort().map((id) => [id, inView[id]])]);
    if (key === this.viewSent) return;
    this.viewSent = key;
    this.emit("view", "", { in: inView, end });
  }

  /** The placement's window (SPEC §5.2) within the viewport, without its
   * scrollbars, in the frame's pixels: what the user can see of the
   * document. */
  private shownRect() {
    const root = this.doc.documentElement;
    const left = Math.round(this.win.x * this.cellW);
    const top = this.win.y * this.cellH;
    return {
      left,
      top,
      right: Math.min(root.clientWidth, left + Math.round(this.win.w * this.cellW)),
      bottom: Math.min(root.clientHeight, top + this.win.h * this.cellH),
    };
  }

  /** The observers watch the elements that ask, as deltas add and remove
   * them, and the root and the body, from the first that asks in the
   * placement. */
  private watchViews(asks: Element[]) {
    if (!asks.length && !this.viewObservers) return;
    if (!this.viewObservers) {
      // Coming into the window or leaving it: the window, as margins inside
      // the surface's viewport (SPEC §5.2).
      const w = this.win;
      const [left, top] = [Math.round(w.x * this.cellW), w.y * this.cellH];
      const [right, bottom] = [Math.round(this.cols * this.cellW) - left - Math.round(w.w * this.cellW), (this.rows - w.y - w.h) * this.cellH];
      this.viewObservers = {
        size: new ResizeObserver(() => this.requestView()),
        window: new IntersectionObserver(() => this.requestView(), { root: this.doc, rootMargin: `${-top}px ${-right}px ${-bottom}px ${-left}px` }),
      };
      this.viewObservers.size.observe(this.doc.documentElement);
      this.viewObservers.size.observe(this.doc.body);
    }
    const o = this.viewObservers;
    const now = new Set(asks);
    for (const el of this.viewWatched) {
      if (now.has(el)) continue;
      o.size.unobserve(el);
      o.window.unobserve(el);
      this.viewWatched.delete(el);
    }
    for (const el of now) {
      if (this.viewWatched.has(el)) continue;
      o.size.observe(el);
      o.window.observe(el);
      this.viewWatched.add(el);
    }
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
    if (this.viewDirty) this.requestView();
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
    this.endPlacement();
    this.dropDrag();
    this.dropAlt();
    if (this.settling) clearTimeout(this.settling);
    if (this.caretFrame) this.frame.ownerDocument.defaultView?.cancelAnimationFrame(this.caretFrame);
    this.prefix = false;
    // A focus that waits leaves the page's focus where it is.
    if ((this.keyboard && this.waiting === null) || this.frameFocused()) this.host.focusTerminal();
    this.waiting = null;
    this.box.remove();
  }

  // --- Keyboard (PROTOCOL §8, Q-0005) -------------------------------------

  hasKeyboard(): boolean {
    return this.keyboard;
  }

  /** The text selected in the surface, for the host's copy keys (SPEC
   * §11): the focused text field's selection, never a password field's, or
   * else the document's. */
  selectedText(): string {
    const el = this.doc.activeElement as HTMLInputElement | null;
    if (el && (el.localName === "input" || el.localName === "textarea")) {
      const type = (this.resolver.get(el, "type") ?? el.type ?? "").toLowerCase();
      if (type === "password") return "";
      try {
        const [a, b] = [el.selectionStart, el.selectionEnd];
        return a === null || b === null ? "" : el.value.slice(a, b);
      } catch {
        return ""; // a type with no text selection
      }
    }
    return this.doc.getSelection()?.toString() ?? "";
  }

  /**
   * A key for the selection in the document outside a text field (SPEC
   * §11): null when there is none, or a focused text field holds the
   * selection; else its text when the keymap of the element whose text it
   * starts in, read as a text field's, binds the key to `copy`, and false
   * when it does not, the key going on as if nothing were selected.
   */
  selectionCopy(e: KeyboardEvent): string | false | null {
    const active = this.doc.activeElement;
    if (isValueField(active) || (active as HTMLElement | null)?.isContentEditable) return null;
    const sel = this.doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString();
    if (text === "") return null;
    const start = sel.getRangeAt(0).startContainer;
    const el = start.nodeType === 1 ? (start as Element) : start.parentElement;
    if (!el) return null;
    const keymap = resolve(this.host.keys.platform, false, ...keysValues(el));
    const named = pressNames(e).find((n) => keymap.binds(n));
    return named !== undefined && keymap.lookup(named) === "copy" ? text : false;
  }

  /** Drops the document's selection: the user pressed elsewhere (SPEC §11). */
  clearSelection() {
    const sel = this.doc.getSelection();
    if (sel && sel.rangeCount > 0) sel.removeAllRanges();
  }

  /** `a=focus`: the surface takes the keyboard, at `target` if given. With
   * `now` false, the page's focus is outside the terminal, and stays there:
   * the surface has the keyboard, and takes the browser's focus when the
   * terminal does (`takeFocus`). */
  focus(target?: string, now = true) {
    const el = target ? this.doc.getElementById(target) : null;
    if (target && !el) throw new Error(target);
    // The program takes the keys back (SPEC §10.5), whether or not focus moves.
    this.prefix = false;
    this.waiting = null;
    if (!now) {
      this.keyboard = true;
      this.waiting = target ?? "";
      return;
    }
    this.programFocus = true;
    try {
      // Focusing the frame while focus is in it would blur its window:
      // a blur the surface never had.
      if (!this.frameFocused()) {
        this.frame.focus();
        this.frame.contentWindow?.focus();
      }
      const had = this.focusedControl();
      if (el) (el as HTMLElement).focus();
      else if (!had) this.tabbable()[0]?.focus();
      this.keyboard = true;
      // No echo (SPEC §10.1): the program knows where it put focus.
      this.told = this.focusedControl();
      // A text field it moves to has its selection back (§10.2).
      if (this.told && this.told !== had && this.isTextField(this.told)) this.restoreSelection(this.told);
    } finally {
      setTimeout(() => (this.programFocus = false), 0);
    }
  }

  /** `a=blur`, or the keyboard leaving: the edited control commits first. */
  blur() {
    // A press still settling must not focus its element again: the
    // keyboard left after it (Tab past the last element, or `a=blur`).
    this.pressed = null;
    this.prefix = false;
    // A focus that waits had no control focused, so none commits: the
    // keyboard leaves with `blur`, and the page's focus stays.
    if (this.dropWait(true)) return;
    this.commit();
    if (this.keyboard) this.giveBack();
  }

  /** The terminal has the page's focus, and not by a click: the focus that
   * waited moves now, as the program's (no echo). Its element may have gone
   * meanwhile; the surface takes the focus all the same. */
  takeFocus() {
    if (this.waiting === null) return;
    const target = this.waiting;
    this.waiting = null;
    const el = target ? this.doc.getElementById(target) : null;
    this.focus(el ? target : undefined);
  }

  /** A focus that waits ends without moving: a click elsewhere gives the
   * keyboard back (SPEC §10.1), and says so with `blur` when `say`;
   * another `a=focus` moves it, and the program knows. Whether one waited. */
  dropWait(say: boolean): boolean {
    if (this.waiting === null) return false;
    this.waiting = null;
    this.keyboard = false;
    this.told = null;
    if (say) this.emit("blur", "");
    return true;
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
    this.pressAt(e);
  }

  /** What a click (SPEC §10.1) at `e`'s target does to the keyboard: a
   * press of the primary button, a tap, or a touch that becomes a drag. */
  private pressAt(e: Event) {
    // A press that focuses an element ends a prefix (SPEC §10.5), and one
    // that takes the keyboard from the surface does.
    this.prefix = false;
    // A focus that waits elsewhere ends: this is a click elsewhere.
    this.host.clicked(this.name);
    const el = this.detachedState ? null : focusTargetAt(e, this.hyper);
    // One that waits here ends too. On an element that takes focus, the
    // focus is the user's, and reported; on anything else, the keyboard the
    // surface had goes back, as below.
    if (this.waiting !== null) {
      this.waiting = null;
      if (el) this.keyboard = false;
    }
    if (el) {
      this.pressed = el;
      this.settle();
      return;
    }
    this.pressNothing = true;
    if (this.keyboard) {
      this.commit();
      this.keyboard = false;
      this.told = null;
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
   * nor a detached surface's. The program hears where the user put focus,
   * each time it is another element than the one it knows (SPEC §10.1). */
  private onFocusIn(e: FocusEvent) {
    const el = isElement(e.target as EventTarget) ? (e.target as Element) : null;
    if (this.programFocus) {
      this.told = el;
      return;
    }
    if (this.auxPress) return;
    if (this.detachedState || this.pressNothing || !el || !takesFocus(el, this.hyper)) {
      this.settle();
      return;
    }
    const gained = !this.keyboard;
    this.keyboard = true;
    if (!gained && el === this.told) return;
    this.told = el;
    // `t`: the nearest element with an id, from the focused one outward.
    this.emit("focus", el.closest('[id]:not([id=""])')?.id ?? "");
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
    // The program's menu hides on Escape and on a key it does not list.
    this.host.typed(e);
    // While something is selected, a copy key is the host's (SPEC §11).
    if (this.host.copyKey(e)) {
      e.stopPropagation();
      return;
    }
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
    // After a prefix every key is the program's, Tab and Escape too (SPEC
    // §10.5); the browser's own stay its.
    if (this.prefix) {
      if (!this.host.browserKey(e)) this.forward(e);
      return;
    }
    this.plainKey(e);
  }

  /**
   * A key for the focused element (SPEC §10.2): Tab, a text field's keys,
   * what the element's keymap gives the program, what the element uses, the
   * scroll actions and the keys the document scrolls with; the rest is the
   * program's.
   */
  private plainKey(e: KeyboardEvent) {
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
    if (active && this.scrollActionKey(e, active)) return;
    if (this.axes && this.scrollKey(e)) return;
    this.forward(e);
  }

  /**
   * A key the focused element's keymap gives the program (SPEC §10.2, *Keys
   * for the program*), outside a text field: it reaches the program before
   * the element uses it (a select's arrows) and before the document
   * scrolls with it. The keymap is each `data-keys` from the root down to
   * the element, with no default, and only its `program` and `prefix`
   * bindings count; a `prefix` begins one (§10.5). The key is named as in a
   * text field (`fieldKey`).
   */
  private programKey(e: KeyboardEvent, el: Element): boolean {
    const values = keysValues(el);
    if (!values.some((v) => v.includes("program") || v.includes("prefix"))) return false;
    const keymap = elementKeymap(this.host.keys.platform, ...values);
    const data = this.host.encodeKey(e);
    const keys = asked(keymap, e, data);
    if (!keys.some((k) => keymap.program(k))) return false;
    this.toProgram(e, data);
    if (keys.some((k) => keymap.prefix(k))) this.prefix = true;
    return true;
  }

  /**
   * A key the focused element's keymap binds to a scroll action (SPEC
   * §10.2, *Scrolling keys*), outside a text field, and that the element
   * does not use. Along an axis the document scrolls, it scrolls the
   * nearest box from the element outward that can still move that way, as
   * a gesture goes (§5.3), and never the terminal: where nothing can move,
   * the key is used and does nothing. Along an axis the document does not
   * scroll, it goes on as if its keymap did not bind it. The key is named
   * as in a text field (`fieldKey`).
   */
  private scrollActionKey(e: KeyboardEvent, el: Element): boolean {
    const values = keysValues(el);
    if (!values.some((v) => v.includes("scroll-"))) return false;
    const keymap = elementKeymap(this.host.keys.platform, ...values);
    const data = this.host.encodeKey(e);
    const action = asked(keymap, e, data).map((k) => keymap.scroll(k)).find((a) => a !== null);
    const k = action ? SCROLL_ACTIONS[action] : undefined;
    if (!k || !(this.axes & (k.axis === "y" ? 1 : 2))) return false;
    e.preventDefault();
    e.stopPropagation();
    const to = this.scroller(el, k.axis, k.sign);
    if (typeof to !== "string") this.scrollBox(to, k);
    return true;
  }

  /** Scrolls `to` as a key does (`KeyScroll`), by Chromium's amounts. */
  private scrollBox(to: Element, k: KeyScroll) {
    const y = k.axis === "y";
    const port = y ? to.clientHeight : to.clientWidth;
    const by = k.by === "line" ? LINE_PX : k.by === "page" ? Math.max(1, port * PAGE_FRACTION) : k.by === "half" ? Math.max(1, port / 2) : y ? to.scrollHeight : to.scrollWidth;
    to.scrollBy(y ? { top: k.sign * by } : { left: k.sign * by });
  }

  /** A key the program has, as xterm.js encoded it (`data`; null when it
   * cannot say, and the key goes through it). Its release follows. */
  private toProgram(e: KeyboardEvent, data: string | null) {
    e.preventDefault();
    e.stopPropagation();
    // The key of an edit command the program takes is the command (§10.6).
    if (e.type === "keydown" && this.host.command(e)) return;
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

  /** Whether a text field has text selected. */
  private selects(el: HTMLElement): boolean {
    if (isValueField(el)) return el.selectionStart !== el.selectionEnd;
    const sel = this.doc.getSelection();
    return !!sel && !sel.isCollapsed && el.contains(sel.anchorNode);
  }

  /**
   * A key in a text field, offered at most twice (SPEC §10.4). A key that
   * types no text is offered first as pressed, named from the DOM's event
   * by its physical key and its character (`pressNames`), before xterm.js
   * translates it (on a Mac, Option+ArrowLeft is ESC b to the program).
   * Otherwise it is named as the program would read it: from
   * what xterm.js would send the program for it, in the encoding the
   * program enabled, read as SPEC §10.4 says. The field's keymap (the
   * default, then each `data-keys` from the root to the field) says what
   * the field does with each key; what it does not use is the program's,
   * sent as xterm.js encoded it.
   */
  private fieldKey(e: KeyboardEvent, el: HTMLElement, multiline: boolean) {
    if (this.host.browserKey(e)) return; // the browser's: reload, zoom, …
    const keymap = this.keymapOf(el, multiline);
    // No copy or cut with nothing selected, nor in a password field: the
    // key is the program's (SPEC §10.2).
    const cuts = this.selects(el) && !(el.localName === "input" && this.inputType(el as HTMLInputElement) === "password");
    const lookup = (key: string) => {
      const use = keymap.lookup(key);
      return (use === "copy" || use === "cut") && !cuts ? null : use;
    };
    // The first name of the press that the keymap binds decides alone: the
    // physical key before the character (SPEC §10.4).
    const named = typesNoText(e) ? pressNames(e).find((n) => keymap.binds(n)) : undefined;
    const first = named !== undefined && lookup(named) !== null;
    const data = first ? "" : this.host.encodeKey(e);
    const keys: InputKey[] = first ? [{ key: named!, data: "" }] : named !== undefined ? [{ key: named, data: data ?? "" }] : typedKeys(e, data);
    const uses = keys.map((k) => (k.key === null ? null : lookup(k.key)));
    // A move with Shift selects (§10.2).
    const extend = keys.map((k) => k.key !== null && keymap.selects(k.key));
    if (uses.every((u) => u === null)) {
      // The program's, unless the document scrolls with it (SPEC §5.3); a
      // key bound to `program` or `prefix` is the program's first (§10.2),
      // and a `prefix` begins one (§10.5).
      const program = keys.some((k) => k.key !== null && keymap.program(k.key));
      if (!program && this.axes && this.scrollKey(e)) return;
      this.toProgram(e, data);
      if (keys.some((k) => k.key !== null && keymap.prefix(k.key))) this.prefix = true;
      return;
    }
    const number = el.localName === "input" && this.inputType(el as HTMLInputElement) === "number";
    if (keys.length === 1) {
      const [use, key] = [uses[0], keys[0]!.key!];
      // A character, typed as the browser types it (input methods, the
      // undo history); Enter that submits, as the browser submits a form
      // with it (the default button's click, and `change` first).
      const typed = use === INSERT && !(number && !NUMBER_CHARS.test(keyText(key) ?? ""));
      const enter = use === "submit" && e.key === "Enter" && el.localName === "input";
      // The browser's own paste, where its key is the one pressed.
      const paste = use === "paste" && first && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey;
      if (typed || enter || paste) {
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
        const text = keyText(k.key!) ?? "";
        if (text && (!number || NUMBER_CHARS.test(text))) this.edit(el, multiline, { kind: "type", text });
      } else if (use === "submit") {
        this.goal = null;
        submitFrom(el);
      } else if (use === "undo" || use === "redo") this.undo(el, use === "redo");
      else if (use === "copy") this.host.writeClipboard(this.selectedText());
      else if (use === "cut") this.cut(el);
      else if (use === "paste") this.pasteFrom(el, multiline);
      else this.edit(el, multiline, { kind: "action", action: use, extend: extend[i] });
    });
  }

  /** A field's keymap (SPEC §10.2): the default, then the `data-keys` of
   * each element from the root down to the field. */
  private keymapOf(el: Element, multiline: boolean) {
    return resolve(this.host.keys.platform, multiline, ...keysValues(el));
  }

  /** Does an action in a field, or types text in it. */
  private edit(el: HTMLElement, multiline: boolean, what: Edit) {
    if (what.kind === "action" && MULTILINE_ACTIONS.has(what.action) && !multiline) return;
    if (el.localName === "input" || el.localName === "textarea") this.editValue(el as HTMLInputElement | HTMLTextAreaElement, multiline, what);
    else this.editHost(el, what);
  }

  /** An input's or a textarea's value: the action's plan, applied with
   * the editing commands, so that the browser sends `input` (and `change`
   * when focus leaves) as for typing. */
  private editValue(el: HTMLInputElement | HTMLTextAreaElement, multiline: boolean, what: Edit) {
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
    // The caret is the selection's focus; the other end is its anchor.
    const caret = el.selectionDirection === "backward" ? start : end;
    if (what.kind === "type") {
      this.goal = null;
      this.replace(el, at[start]!, at[end]!, what.text, "typing");
      return;
    }
    const action = what.action;
    const run: Run = action === "newline" ? "typing" : action === "delete-char-backward" || action === "delete-char-forward" ? "deleting" : null;
    // Any other action ends a run of typing or deleting.
    if (run === null) {
      const h = this.histories.get(el);
      if (h) h.run = null;
    }
    const password = el.localName === "input" && this.inputType(el as HTMLInputElement) === "password";
    const text: Text = { chars: cl, start, end, caret, multiline, password };
    const g = this.goal;
    const goal = ROW_ACTIONS.has(action) && g && g.el === el && g.caret === caret ? g.x : null;
    const rows = multiline && ROW_ACTIONS.has(action) ? this.textareaRows(el as HTMLTextAreaElement, cl) : null;
    const p = plan(text, action, rows, goal, what.extend);
    this.goal = p.kind === "move" && p.goal !== undefined ? { el, caret: p.to, x: p.goal } : null;
    if (p.kind === "move") {
      const a = p.anchor ?? p.to;
      el.setSelectionRange(at[Math.min(a, p.to)]!, at[Math.max(a, p.to)]!, a > p.to ? "backward" : "forward");
    }
    else if (p.kind === "replace") this.replace(el, at[p.from]!, at[p.to]!, p.text, run);
  }

  /** Replaces code units `from` to `to` of a field's value with `text`, the
   * caret after it, as typing does: an edit in the `run` for the field's
   * history (SPEC §10.2, undo). */
  private replace(el: HTMLInputElement | HTMLTextAreaElement, from: number, to: number, text: string, run: Run) {
    this.flushCaret(el);
    const before = stateOf(el);
    el.setSelectionRange(from, to);
    if (from === to && !text) return;
    this.pending = { el, before, run };
    this.editing = true;
    try {
      const done = text ? this.doc.execCommand("insertText", false, text) : this.doc.execCommand("delete", false);
      if (done) return;
      el.setRangeText(text, from, to, "end");
      const win = this.frame.contentWindow as unknown as typeof globalThis;
      el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: text ? "insertText" : "deleteContent", data: text || null }));
    } finally {
      this.editing = false;
      this.pending = null;
    }
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
  private editHost(host: HTMLElement, what: Edit) {
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
    if (action === "select-all") {
      sel.selectAllChildren(host);
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
    // With Shift, a move extends from the selection's focus, the caret.
    const alter = what.extend ? "extend" : "move";
    if (!what.extend && !sel.isCollapsed) {
      if (backward) sel.collapseToStart();
      else sel.collapseToEnd();
      if (action === "char-backward" || action === "char-forward") return;
    }
    const by = { "char-backward": "char", "char-forward": "char", "word-backward": "word", "word-forward": "word", "line-start": "line", "line-end": "line" }[action];
    if (by) {
      if (backward) back(alter, by);
      else forward(alter, by);
      return;
    }
    if (action === "input-start" || action === "input-end") {
      sel.modify(alter, backward ? "backward" : "forward", "documentboundary");
      return;
    }
    if (ROW_ACTIONS.has(action)) {
      const rows = action.startsWith("page") ? Math.max(1, Math.round(host.clientHeight / (parseFloat(this.frame.contentWindow!.getComputedStyle(host).lineHeight) || 16))) : 1;
      for (let i = 0; i < rows; i++) {
        const [fn, fo] = [sel.focusNode, sel.focusOffset];
        sel.modify(alter, backward ? "backward" : "forward", "line");
        if (sel.focusNode === fn && sel.focusOffset === fo) {
          // From the first row to the start, from the last to the end.
          sel.modify(alter, backward ? "backward" : "forward", "documentboundary");
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
    this.scrollBox(to, k);
    return true;
  }

  private forward(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "keydown" && this.host.command(e)) return;
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
    const mods = modsOf(e);
    const d: Drag = { pointer: e.pointerId, start: id, steps: stepsOf(start!), target: id, c, r, mods, step: {}, tstep: {}, clicks: 1 };
    d.step = this.stepIn(d, e.clientX, e.clientY);
    this.drag = d;
    this.emit("dragstart", id, { c, r, mods, ...d.step });
    try {
      this.doc.documentElement.setPointerCapture(e.pointerId);
    } catch {
      /* the browser routes a pressed mouse to the frame anyway */
    }
  }

  /** A move during a drag (`moveDrag`). */
  private onDragMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    this.moveDrag(d, e.clientX, e.clientY, modsOf(e));
  }

  /** The pointer or the finger of a drag moved to (x, y) of the document:
   * an event each time its target changes, while it has none each time its
   * cell does, and each time its step does (SPEC §9.1); one for a move that
   * changes more than one. */
  private moveDrag(d: Drag, x: number, y: number, mods: number | undefined) {
    const [c, r] = this.cellAt(x, y);
    const t = this.dragTarget(this.elementAtPoint(x, y, c, r));
    const target = t?.getAttribute("id") ?? "";
    const step = this.stepIn(d, x, y);
    const tstep = stepInTarget(t, x, y);
    if (
      target !== d.target ||
      (target === "" && (c !== d.c || r !== d.r)) ||
      step.x !== d.step.x ||
      step.y !== d.step.y ||
      tstep.tx !== d.tstep.tx ||
      tstep.ty !== d.tstep.ty
    ) {
      this.emit("drag", target, { c, r, mods, ...step, ...tstep });
    }
    Object.assign(d, { target, c, r, mods, step, tstep });
  }

  /**
   * Where (x, y) of the document is in the element a drag started on, in
   * its steps (SPEC §9.1): measured against its border box where the user
   * sees it now, wherever the point is, and as they last were once the
   * element has left the document. None when it has no steps.
   */
  private stepIn(d: Drag, x: number, y: number): Step {
    const s = d.steps;
    if (!s) return {};
    if (!s.el.isConnected) return d.step;
    const box = s.el.getBoundingClientRect();
    const step: Step = {};
    if (s.x) step.x = stepAt(x - box.left, box.width, s.x);
    if (s.y) step.y = stepAt(y - box.top, box.height, s.y);
    return step;
  }

  /** The release ends the drag, wherever it is. Where it began, it is the
   * click it would have been without the drag; anywhere else, no click. */
  private onDragUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer || e.button !== 0) return;
    this.drag = null;
    const [c, r] = this.cellOf(e);
    // The browser's click goes where the capture was (the root), or to
    // where the press and the release meet: the drag reports its own.
    this.endDrag(d, e.clientX, e.clientY, c, r, this.elementAt(e, c, r), modsOf(e));
  }

  /** A drag released at (x, y) of the document, cell (c, r), over `at`:
   * `dragend`, then the click it is where it began (SPEC §9.1): where the
   * nearest element that opts in to drags is the one it started on, whatever
   * its target, a drop-only element inside it included. */
  private endDrag(d: Drag, x: number, y: number, c: number, r: number, at: Element | null, mods: number | undefined) {
    const t = this.dragTarget(at);
    this.emit("dragend", t?.getAttribute("id") ?? "", { c, r, mods, ...this.stepIn(d, x, y), ...stepInTarget(t, x, y) });
    this.dragReleased = true;
    setTimeout(() => (this.dragReleased = false), 0);
    if (at && this.draggedAt(at) === d.start) this.reportClick(ancestry(at), d.clicks, mods);
  }

  /** The browser took the pointer away before the release. */
  private lostPointer(e: PointerEvent) {
    if (this.drag && e.pointerId === this.drag.pointer) this.cancelDrag();
    if (e.pointerId === this.altPointer) this.altPointer = null;
  }

  /**
   * Ends a drag under way without a release (SPEC §9.1: its placement went
   * away, a new document came, or the pointer was lost): `dragend` with no
   * target, at the last cell and step the program heard of.
   */
  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this.dropDrag();
    this.emit("dragend", "", { c: d.c, r: d.r, mods: d.mods, ...d.step });
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
    return this.cellAt(e.clientX, e.clientY);
  }

  /** The element under the pointer, if it is in the window (SPEC §5.2). */
  private elementAt(e: MouseEvent, c: number, r: number): Element | null {
    return this.elementAtPoint(e.clientX, e.clientY, c, r);
  }

  /** A drag's target, t: the nearest element with an id and `drag` or
   * `drop` in its `data-on`, from `el` outward; null where there is none. */
  private dragTarget(el: Element | null): Element | null {
    for (let n = el; n; n = n.parentElement) {
      if (n.getAttribute("id") && (listens(n, "drag") || listens(n, "drop"))) return n;
    }
    return null;
  }

  /** The id of the nearest element with an id and `drag` in its `data-on`,
   * from `el` outward: a drag that ends where this is the element it began
   * on is a click (SPEC §9.1). "" where there is none. */
  private draggedAt(el: Element): string {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const id = n.getAttribute("id");
      if (id && listens(n, "drag")) return id;
    }
    return "";
  }

  // --- Touch drags (SPEC §9.1) ----------------------------------------------

  /**
   * Where a touch that has just gone past the slop, scrolling by dx, dy so
   * far, goes. A drag, where the touched element opts in and the
   * touch-action that counts for it allows no pan along the touch's first
   * move (the larger delta; a tie pans). Otherwise a pan, as §5.3 and §9
   * have it, whatever touch-action says: where the browser would pan the
   * document but the document's touch-action stops it, the surface scrolls
   * the box itself.
   */
  private claimTouch(dx: number, dy: number, e: TouchEvent, begin: TouchBegin): boolean | "drag" {
    const el = begin.target && isElement(begin.target) ? begin.target : null;
    const pans = this.allowedPans(el);
    if (panBlocked(pans, dx, dy) && this.touchDragStart(e, begin)) return "drag";
    if (!this.axes) {
      this.touchRoute = "terminal";
      return true;
    }
    const to = this.gestureTarget(el, dx, dy);
    if (typeof to === "string") {
      this.touchRoute = to;
      return true;
    }
    // The browser pans the box, chaining to the page where the page scrolls,
    // unless the document's touch-action stops it.
    if (pans.x && pans.y) {
      this.touchRoute = "doc";
      return false;
    }
    this.touchRoute = "self";
    this.touchBox = to;
    return true;
  }

  /** Whether the touch-action that counts at `target` allows every pan. */
  private pansFreely(target: EventTarget | null): boolean {
    const p = this.allowedPans(target && isElement(target) ? target : null);
    return p.x && p.y;
  }

  /**
   * The pans the document's touch-action allows a touch on `el`, as Pointer
   * Events determine them: its own, with its ancestors' up to the nearest
   * element that scrolls (SPEC §5.3), both included. The root's is the
   * document's only where it differs from the host's (`rootTouchAction`),
   * which is there for the browser's own panning.
   */
  private allowedPans(el: Element | null): { x: boolean; y: boolean } {
    let x = true;
    let y = true;
    const root = this.doc.documentElement;
    const host = rootTouchAction(this.axes, this.host.pageScrolls);
    for (let n = el; n; n = n.parentElement) {
      const s = n.ownerDocument.defaultView!.getComputedStyle(n);
      const value = n === root && s.touchAction === host ? "auto" : s.touchAction;
      const [px, py] = touchPans(value);
      x &&= px;
      y &&= py;
      if (n !== root && this.scrolls(s)) break;
    }
    return { x, y };
  }

  /** Whether an element with this style scrolls (SPEC §5.3): its overflow is
   * `auto` or `scroll` along an axis the document asked to scroll. */
  private scrolls(s: CSSStyleDeclaration): boolean {
    return (!!(this.axes & 1) && /auto|scroll/.test(s.overflowY)) || (!!(this.axes & 2) && /auto|scroll/.test(s.overflowX));
  }

  /**
   * A touch becomes a drag (SPEC §9.1), if it can: one that began without
   * Alt and was not held still past a long press, on an element that opts
   * in and has an id, in a surface not detached. It presses at this moment
   * as a mouse does: `press`, then `dragstart`, both for where it began,
   * then what the press causes; then a `drag` if the finger is by now over
   * another element.
   */
  private touchDragStart(e: TouchEvent, begin: TouchBegin): boolean {
    if (this.detachedState || begin.altKey || e.timeStamp - begin.time >= LONG_PRESS_MS) return false;
    const el = begin.target && isElement(begin.target) ? begin.target : null;
    let start: Element | null = null;
    for (let n = el; n; n = n.parentElement) {
      if (listens(n, "drag")) {
        start = n;
        break;
      }
    }
    const id = start?.getAttribute("id");
    if (!id) return false;
    this.cancelDrag(); // a drag whose release was lost
    const [c, r] = this.cellAt(begin.x, begin.y);
    const mods = modsOf(begin);
    // The touch's own events have its start as their target, so the
    // press's path is the touched element's.
    this.reportPress(e);
    const d: Drag = { pointer: NaN, start: id, steps: stepsOf(start!), target: id, c, r, mods, step: {}, tstep: {}, clicks: 1 };
    d.step = this.stepIn(d, begin.x, begin.y);
    this.drag = d;
    this.emit("dragstart", id, { c, r, mods, ...d.step });
    this.pressAt(e);
    const t = [...e.changedTouches][0];
    if (t) this.touchDragMove(t.clientX, t.clientY, e);
    return true;
  }

  /** A touch drag's finger moved to (x, y) of the document: as a pointer's
   * move (`moveDrag`). */
  private touchDragMove(x: number, y: number, e: TouchEvent) {
    const d = this.drag;
    if (d) this.moveDrag(d, x, y, modsOf(e));
  }

  /** A touch drag's finger lifted at (x, y): as a pointer's release
   * (`onDragUp`), a click where it began. */
  private touchDragEnd(x: number, y: number, e: TouchEvent) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const [c, r] = this.cellAt(x, y);
    this.endDrag(d, x, y, c, r, this.elementAtPoint(x, y, c, r), modsOf(e));
  }

  /** The surface's cell at (x, y) of the document, counting on past its
   * edges. */
  private cellAt(x: number, y: number): [number, number] {
    return [Math.floor(x / this.cellW), Math.floor(y / this.cellH)];
  }

  /** The element at (x, y) of the document, if cell (c, r) is in the
   * window (SPEC §5.2). */
  private elementAtPoint(x: number, y: number, c: number, r: number): Element | null {
    const w = this.win;
    if (c < w.x || c >= w.x + w.w || r < w.y || r >= w.y + w.h) return null;
    return this.doc.elementFromPoint(x, y);
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

  /** `press` (SPEC §9), if the surface asked for it (`p`, §5.2): `t` is the
   * nearest element with an id, and the detail its cells and the modifier
   * keys held. A press on a hyperlink is the terminal's. */
  private reportPress(e: Event) {
    if (!this.presses) return;
    const link = this.linkIn(e);
    if (link && this.isHyperlink(link)) return;
    for (const n of e.composedPath()) {
      const id = isElement(n) ? n.getAttribute("id") : null;
      if (id) {
        this.emit("press", id, { area: this.areaOf(n as Element), mods: modsOf(e as MouseEvent) });
        return;
      }
    }
    this.emit("press", "", { mods: modsOf(e as MouseEvent) });
  }

  /**
   * The cells an element's border box covers as the user sees it, scrolled
   * included (SPEC §9: `area`), counted from the surface's top left cell:
   * whole, where it is clipped or scrolled away. An edge close enough to a
   * cell's (`slack`) is on it.
   */
  private areaOf(el: Element): Area {
    const b = el.getBoundingClientRect();
    const dpr = this.frame.ownerDocument.defaultView?.devicePixelRatio || 1;
    const c = Math.floor((b.left + slack(b.left, this.cellW, dpr)) / this.cellW);
    const r = Math.floor((b.top + slack(b.top, this.cellH, dpr)) / this.cellH);
    const right = Math.ceil((b.right - slack(b.right, this.cellW, dpr)) / this.cellW);
    const bottom = Math.ceil((b.bottom - slack(b.bottom, this.cellH, dpr)) / this.cellH);
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
        if (e.button === 0 && e.isPrimary) this.host.pressed(e.altKey ? null : this.name);
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
        // The press that started a drag: its place in a run of clicks, for
        // the click the drag reports (the pointerdown's detail is 0).
        if (this.drag && e.button === 0 && e.detail > 0) this.drag.clicks = e.detail;
        this.pointerPress = false;
        this.onPress(e);
      },
      true,
    );
    d.addEventListener("focusin", (e) => {
      // A focus of its own: what the user edits from here on, focus
      // leaving commits (SPEC §6.4).
      if (isElement(e.target as EventTarget)) this.dirty.delete(e.target as Element);
      this.maskField(e.target, true);
      this.onFocusIn(e);
      this.noteCaret();
    }, true);
    d.addEventListener("focusout", (e) => {
      // The field keeps its selection while it is not focused (SPEC §10.2),
      // read while it is still shown as it was focused (`NO_CARET`).
      const el = e.target as Element;
      if (isElement(el) && this.isTextField(el)) {
        this.kept.set(el, fieldSel(el as HTMLInputElement | HTMLTextAreaElement));
        this.flushCaret(el);
      }
      if (e.target === this.masked) this.unmaskField();
    }, true);
    // The user moving a field's selection (SPEC §9, `caret`): the browser
    // tells some moves, and every key and press may make one.
    d.addEventListener("selectionchange", () => this.noteCaret(), true);
    d.addEventListener("pointerup", () => this.noteCaret(), true);
    d.addEventListener("mouseup", () => this.noteCaret(), true);
    d.addEventListener("keyup", () => this.noteCaret(), true);
    // An input method composing text: `a=field` waits for it (SPEC §6.4).
    d.addEventListener("compositionstart", (e) => (this.composing = e.target as Element), true);
    d.addEventListener("compositionend", () => (this.composing = null), true);
    d.addEventListener("click", (e) => this.onClick(e), true);
    d.addEventListener("auxclick", (e) => this.onAuxClick(e), true);
    d.addEventListener("mouseover", (e) => this.onOver(e), true);
    d.addEventListener("mouseout", (e) => this.onOut(e), true);
    d.addEventListener("submit", (e) => this.onSubmit(e as SubmitEvent), true);
    d.addEventListener("change", (e) => this.onChange(e), true);
    d.addEventListener("beforeinput", (e) => this.onBeforeInput(e as InputEvent), true);
    d.addEventListener("input", (e) => this.onInput(e), true);
    d.addEventListener("keydown", (e) => {
      this.onKey(e);
      this.noteCaret();
    }, true);
    d.addEventListener("keyup", (e) => this.onKeyUp(e), true);
    d.addEventListener("dragstart", (e) => e.preventDefault(), true);
    d.addEventListener("wheel", (e) => this.onWheel(e), { capture: true, passive: false });
    d.addEventListener("scroll", (e) => this.onScroll(e), true);
    // What is in view waits for a scroll to rest (SPEC §9.5).
    d.addEventListener("scroll", (e) => this.viewScrolled(e), true);
    d.addEventListener("scrollend", (e) => this.scrollEnded(e), true);
    // An image or a stylesheet that loads late, a resource's or one fetched
    // from the network (SPEC §7.1, §7.2), and a font: the height may change.
    d.addEventListener("load", () => this.relayout(), true);
    d.addEventListener("error", () => this.relayout(), true);
    d.fonts.addEventListener("loadingdone", () => this.relayout());
    // What the user does that moves elements without resizing the root or
    // the body: a <details> opened inside a box of fixed height, a
    // transition or an animation that ends (SPEC §9.5).
    for (const kind of ["toggle", "transitionend", "animationend"]) d.addEventListener(kind, () => this.requestView(), true);
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
    // the browser chains the drag from the document to the page itself. A
    // touch on an element that opts in to drags, whose touch-action allows
    // no pan its way, is a drag (§9.1); a touch-action that would stop the
    // browser's pan anywhere else does not (`claimTouch`).
    new Touch(
      d,
      this.frame.ownerDocument.defaultView!,
      {
        scroll: (dx, dy, x, y) => {
          if (this.touchRoute === "self") this.touchBox?.scrollBy(dx, dy);
          else if (this.touchRoute !== "terminal") return;
          else if (this.host.pageScrolls) this.host.scrollPage(dx, dy);
          else this.host.wheel(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: x, clientY: y }), x, y);
        },
        toPage,
        claim: (dx, dy, e, begin) => this.claimTouch(dx, dy, e, begin),
        dragMove: (x, y, e) => this.touchDragMove(x, y, e),
        dragEnd: (x, y, e) => this.touchDragEnd(x, y, e),
        dragCancel: () => this.cancelDrag(),
      },
      false,
      // Where the page scrolls, the browser pans it from a touch the
      // surface leaves alone.
      this.host.pageScrolls ? (e) => (!this.axes && this.inScroller(e.target)) || !this.pansFreely(e.target) : undefined,
    );
    // The frame's own focus gives no keyboard: an element in it that takes
    // focus does (`onFocusIn`), or the program (SPEC §10.1).
    win.addEventListener("focus", () => {
      if (!this.programFocus && !this.auxPress && !this.keyboard) this.settle();
    });
    win.addEventListener("blur", () => {
      // A prefix ends with the keyboard (SPEC §10.5).
      this.prefix = false;
      this.commit();
      if (this.keyboard) {
        this.keyboard = false;
        this.told = null;
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
  private emit(kind: string, target: string, detail?: Body) {
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
    const detail: Record<string, Value | undefined> = { href: this.resolver.get(link, "href") ?? "" };
    if (url) detail.url = url;
    detail.area = this.areaOf(link);
    detail.mods = modsOf(e);
    const n = this.host.clickCount(this.name, link, e.detail);
    if (n > 1) detail.count = n;
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
    this.reportClick(e.composedPath(), e.detail, modsOf(e));
  }

  /** The click of the nearest element on `path` that reports one (SPEC §9),
   * the `count`th of its run as the platform counts clicks (`detail`; a
   * drag's release is the first), with the modifier keys held at its
   * release. */
  private reportClick(path: EventTarget[], count = 1, mods?: number) {
    for (const n of path) {
      if (!isElement(n)) continue;
      if (n.localName === "a" && n.hasAttribute("href")) {
        // A link's own click (a drag's release on one): the program's, unless
        // it is a hyperlink, which is the terminal's.
        if (this.isHyperlink(n)) return;
        const url = this.urlOf(n);
        const detail: Record<string, Value | undefined> = { href: this.resolver.get(n, "href") ?? "" };
        if (url) detail.url = url;
        detail.area = this.areaOf(n);
        detail.mods = mods;
        const c = this.host.clickCount(this.name, n, count);
        if (c > 1) detail.count = c;
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
        const detail: Record<string, Value | undefined> = {};
        const href = this.resolver.get(el, "href");
        if (href !== null) detail.href = href;
        const value = this.resolver.get(el, "value");
        if (value !== null) detail.value = value;
        detail.area = this.areaOf(el);
        detail.mods = mods;
        const c = this.host.clickCount(this.name, el, count);
        if (c > 1) detail.count = c;
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
    // Each field is a name and a value, in tree order, two of one name as
    // two; a form with none sends `[]` (SPEC §9).
    const fields: [string, string][] = [];
    const data = new (this.frame.contentWindow as unknown as typeof globalThis).FormData(form, e.submitter ?? undefined);
    for (const [k, v] of data) if (typeof v === "string") fields.push([k, v]);
    this.emit("submit", id, { fields });
  }

  /** A control's value committed (SPEC §9): a toggle, a check or a pick at
   * once, a text field's edits as focus leaves it. Each toggle and check is
   * one more `rev`, and so is a pick that no `input` counted (§6.4). */
  private onChange(e: Event) {
    if (this.applying) return;
    const el = e.target as HTMLInputElement;
    if (!isElement(el) || !isControl(el)) return;
    const check = el.localName === "input" && (el.type === "checkbox" || el.type === "radio");
    if (check) this.bump(el);
    else if (this.isTextField(el)) {
      // Only the user's edits are committed: a field that only a=field
      // changed sends none (§6.4).
      if (!this.dirty.has(el)) return;
      this.dirty.delete(el);
    } else if (!this.picked.delete(el)) this.bump(el);
    this.flushCaret(el);
    const id = el.getAttribute("id");
    if (!id) return;
    const rev = this.revOf(el);
    this.emit("change", id, check ? { checked: el.checked, value: el.value, rev } : { value: el.value, rev });
  }

  /** An edit the browser makes (typing, a paste): what the field was, for
   *  its history (SPEC §10.2, undo). A move of the caret before it is
   *  heard before it (`caret`). */
  private onBeforeInput(e: InputEvent) {
    const el = e.target as HTMLInputElement;
    if (this.applying || this.editing) return;
    if (isElement(el)) this.flushCaret(el);
    if (!isValueField(el) || e.inputType.startsWith("history")) return;
    this.pending = { el, before: stateOf(el), run: runOf(e.inputType) };
  }

  /** Puts an edit in its field's history: the one pending, else one from
   *  where the field last was. Undo's and redo's own are not edits. */
  private record(e: Event) {
    const el = e.target as HTMLInputElement;
    const p = this.pending;
    this.pending = null;
    if (!isValueField(el) || (e as InputEvent).inputType?.startsWith("history")) return;
    let h = this.histories.get(el);
    if (!h) this.histories.set(el, (h = new History()));
    const before = p?.el === el ? p.before : h.after;
    if (before) edited(h, before, stateOf(el), p?.el === el ? p.run : null);
  }

  /** Undoes a field's last edit, or with `redo` redoes the one last undone
   *  (SPEC §10.2), sending `input` as for an edit. An editing host has the
   *  browser's own history. */
  private undo(el: HTMLElement, redo: boolean) {
    this.goal = null;
    if (!isValueField(el)) {
      this.doc.execCommand(redo ? "redo" : "undo", false);
      return;
    }
    const h = this.histories.get(el);
    const s = h ? step(h, stateOf(el), redo) : null;
    if (!s) return;
    this.flushCaret(el);
    el.value = s.value;
    el.setSelectionRange(s.start, s.end, s.backward ? "backward" : "forward");
    const win = this.frame.contentWindow as unknown as typeof globalThis;
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: redo ? "historyRedo" : "historyUndo" }));
  }

  /** Cuts a field's selection to the clipboard (SPEC §10.2). */
  private cut(el: HTMLElement) {
    this.goal = null;
    if (!isValueField(el)) {
      const sel = this.doc.getSelection();
      if (!sel || sel.isCollapsed) return;
      this.host.writeClipboard(sel.toString());
      this.doc.execCommand("delete", false);
      return;
    }
    const [from, to] = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
    this.host.writeClipboard(el.value.slice(from, to));
    this.replace(el, from, to, "", null);
  }

  /** Types the clipboard's text in place of a field's selection, as
   *  `paste` does where the browser does not (SPEC §10.2): an `input`
   *  drops line breaks. */
  private pasteFrom(el: HTMLElement, multiline: boolean) {
    void this.host.readClipboard().then((t) => {
      if (t === null || t === "" || this.doc.activeElement !== el) return;
      const text = multiline ? t.replace(/\r\n?/g, "\n") : t.replace(/[\r\n]/g, "");
      if (!isValueField(el)) {
        this.doc.execCommand("insertText", false, text);
        return;
      }
      this.replace(el, el.selectionStart ?? 0, el.selectionEnd ?? 0, text, null);
    });
  }

  /** An edit of a control's value, or a pick (SPEC §9): one more `rev`
   * (§6.4), and `input` with `data-on~=input`, its selection with it in a
   * text field with `data-on~=caret`; without `input`, that field's
   * `caret` says the edit. A toggle and a check count at their `change`;
   * a change of a=field's is none of these. */
  private onInput(e: Event) {
    if (this.applying) return;
    this.record(e);
    const el = e.target as HTMLInputElement;
    if (!isElement(el) || !isControl(el)) return;
    if (el.localName === "input" && (el.type === "checkbox" || el.type === "radio")) return; // reported as `change`
    this.bump(el);
    const text = this.isTextField(el);
    if (text) this.dirty.add(el);
    else this.picked.add(el);
    const id = el.getAttribute("id");
    if (!id || !listens(el, "input")) {
      this.noteCaret(el);
      return;
    }
    const rev = this.revOf(el);
    if (text && listens(el, "caret")) {
      const sel = wireSel(el.value, this.selectionOf(el));
      this.heard.set(el, { sel, rev });
      this.emit("input", id, { value: el.value, rev, sel });
    } else this.emit("input", id, { value: el.value, rev });
  }

  // --- Fields (SPEC §6.4) ---------------------------------------------------

  /**
   * `a=field`: changes a control as the program says, focused or not, if
   * the user has not changed it since `rev`, and sends nothing back. It is
   * checked whole before anything changes: the error is the first of
   * `EDETACHED`, `ENOTARGET` (no element `target`), `EINVAL` and `ESTALE`
   * (the user changed it since, or an input method composes in it) that
   * holds, as a `FieldError`. Positions come last, `EINVAL` past the end
   * or inside a code point only when the command is not stale: they count
   * bytes of the value the program heard.
   */
  field(target: string | undefined, body: Uint8Array) {
    if (this.detachedState) throw new FieldError("EDETACHED", `surface ${this.name} is detached`);
    if (!target) throw new FieldError("EINVAL", "a=field needs t");
    const el = this.doc.getElementById(target);
    if (!el) throw new FieldError("ENOTARGET", target);
    const change = readField(body);
    const invalid = (why: string) => new FieldError("EINVAL", why);
    const kind = this.fieldKind(el);
    if (kind === null) throw invalid(`${target} is not a control`);
    if (kind !== "text" && (change.text !== undefined || change.sel !== undefined)) throw invalid("text, from, to and sel are for text fields");
    if (kind === "check" && change.value !== undefined) throw invalid("value is not for checkboxes and radio buttons");
    if (kind !== "check" && change.checked !== undefined) throw invalid("checked is for checkboxes and radio buttons");
    const stale = () => {
      const rev = this.revOf(el);
      if (change.rev !== rev || this.composing === el) throw new FieldError("ESTALE", String(rev));
    };
    if (kind === "text") {
      this.fieldText(el as HTMLInputElement | HTMLTextAreaElement, change, stale);
      return;
    }
    if (kind === "select") {
      const s = el as HTMLSelectElement;
      const i = Array.from(s.options).findIndex((o) => o.value === change.value);
      if (i < 0) throw invalid(`${target} has no option ${JSON.stringify(change.value)}`);
      stale();
      s.selectedIndex = i; // disabled or not
      return;
    }
    stale();
    const c = el as HTMLInputElement;
    if (kind === "check") c.checked = change.checked!; // unchecks the rest of a radio group
    else c.value = change.value!; // sanitized as its type says
  }

  /** `a=field` in a text field (SPEC §6.4): if it is not stale, positions
   * checked against its value, `sel` against the new one, then the edit
   * made as one of its history, and the selection set, or kept while it is
   * not focused. */
  private fieldText(f: HTMLInputElement | HTMLTextAreaElement, change: FieldChange, stale: () => void) {
    const invalid = (why: string) => new FieldError("EINVAL", why);
    // Positions come last (§6.4): a stale command is ESTALE whatever they are.
    stale();
    const now = f.value;
    const sel = this.selectionOf(f);
    let value = now;
    let edit: { from: number; to: number; text: string } | null = null;
    let after: Sel = sel;
    if (change.value !== undefined) {
      value = this.sanitized(f, change.value);
      edit = { from: 0, to: now.length, text: value };
      after = { start: value.length, end: value.length, backward: false };
    } else if (change.text !== undefined) {
      let [from, to] = [sel.start, sel.end];
      if (change.from !== undefined) {
        const a = unitAt(now, change.from);
        const b = unitAt(now, change.to!);
        if (a === null || b === null) throw invalid("from or to is negative, past the end of the value, or inside a code point");
        [from, to] = [a, b];
      }
      // As a paste (§10.2): an input drops its line breaks.
      const text = f.localName === "textarea" ? change.text.replace(/\r\n?/g, "\n") : change.text.replace(/[\r\n]/g, "");
      value = now.slice(0, from) + text + now.slice(to);
      edit = { from, to, text };
      after = { start: from + text.length, end: from + text.length, backward: false };
    }
    if (change.sel !== undefined) {
      const [a, c] = change.sel.map((b) => unitAt(value, b));
      if (a == null || c == null) throw invalid("sel is negative, past the end of the value, or inside a code point");
      // An end inside a character moves to its start.
      const [anchor, caret] = [clusterStart(value, a), clusterStart(value, c)];
      after = { start: Math.min(anchor, caret), end: Math.max(anchor, caret), backward: anchor > caret };
    }
    const focused = this.doc.activeElement === f;
    this.applying = true;
    try {
      if (edit && focused) this.insert(f, edit.from, edit.to, edit.text, value);
      else if (edit) f.value = value;
      if (focused) f.setSelectionRange(after.start, after.end, after.backward ? "backward" : "forward");
      else this.kept.set(f, after);
    } finally {
      this.applying = false;
    }
    // One edit of the field's history, which ends a run of typing; `sel`
    // alone edits nothing, and ends it too (§10.2).
    let h = this.histories.get(f);
    if (!h) this.histories.set(f, (h = new History()));
    edited(h, { value: now, ...sel }, { value, ...after }, null);
    if (this.pending?.el === f) this.pending = null;
    if (this.goal?.el === f) this.goal = null;
    // The program knows where it put the selection.
    if (this.caretField === f) this.caretField = null;
    if (listens(f, "caret")) this.heard.set(f, { sel: wireSel(value, after), rev: this.revOf(f) });
  }

  /** Puts `text` in place of code units `from` to `to` of a focused field
   * as a paste does, the editing command's events the field's own
   * (`applying`): the browser commits it with the user's edits as focus
   * leaves. Its value is then `value`, as the command left it or as set
   * where the command does not (a `maxlength`, a read-only field). */
  private insert(f: HTMLInputElement | HTMLTextAreaElement, from: number, to: number, text: string, value: string) {
    f.setSelectionRange(from, to);
    if (text) this.doc.execCommand("insertText", false, text);
    else if (from !== to) this.doc.execCommand("delete", false);
    if (f.value !== value) f.setRangeText(value, 0, f.value.length, "end");
  }

  /** `value` as `f` takes it from a script (SPEC §6.4): sanitized as its
   * type says, the program's for a field shown as `text` (`NO_CARET`). */
  private sanitized(f: HTMLInputElement | HTMLTextAreaElement, value: string): string {
    if (f.localName === "textarea") return value.replace(/\r\n?/g, "\n");
    const probe = f.cloneNode(false) as HTMLInputElement;
    if (f === this.masked) probe.setAttribute("type", this.resolver.get(f, "type") ?? "text");
    probe.value = value;
    return probe.value;
  }

  /** What `a=field` takes `el` for (SPEC §6.4): a text field, a checkbox
   * or a radio button, a select, another control; null for what is none. */
  private fieldKind(el: Element): "text" | "check" | "select" | "other" | null {
    if (el.localName === "textarea") return "text";
    if (el.localName === "select") return "select";
    if (el.localName !== "input") return null;
    const type = this.inputType(el as HTMLInputElement);
    if (FIELD_TYPES.has(type)) return "text";
    if (type === "checkbox" || type === "radio") return "check";
    return NOT_CONTROLS.has(type) ? null : "other";
  }

  /** A text field of §10.2: an input of a text type, or a textarea. */
  private isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
    return this.fieldKind(el) === "text";
  }

  /** A control's `rev` (SPEC §6.4); a radio button's is its group's. */
  private revOf(el: Element): number {
    const group = radioGroup(el);
    return group ? Math.max(0, ...group.map((b) => this.revs.get(b) ?? 0)) : (this.revs.get(el) ?? 0);
  }

  /** One more change of the user's to `el`: to its whole group, for a
   * radio button. */
  private bump(el: Element) {
    const rev = this.revOf(el) + 1;
    for (const b of radioGroup(el) ?? [el]) this.revs.set(b, rev);
  }

  /** A text field's selection: its own while focused, the one it keeps
   * otherwise (SPEC §10.2), the caret at the end of the value if none. */
  private selectionOf(f: HTMLInputElement | HTMLTextAreaElement): Sel {
    return this.doc.activeElement === f ? fieldSel(f) : this.keptSel(f);
  }

  /** The selection a field keeps while it is not focused. */
  private keptSel(f: HTMLInputElement | HTMLTextAreaElement): Sel {
    const n = f.value.length;
    const k = this.kept.get(f);
    return k ? { start: Math.min(k.start, n), end: Math.min(k.end, n), backward: k.backward } : { start: n, end: n, backward: false };
  }

  /** `a=focus` gives a field its selection back as it was (SPEC §10.1). */
  private restoreSelection(f: HTMLInputElement | HTMLTextAreaElement) {
    const s = this.keptSel(f);
    f.setSelectionRange(s.start, s.end, s.backward ? "backward" : "forward");
    if (this.caretField === f) this.caretField = null;
    if (listens(f, "caret")) this.heard.set(f, { sel: wireSel(f.value, s), rev: this.revOf(f) });
  }

  /** A delta set a field's value (SPEC §6.2): its caret goes to the end,
   * where the program knows it is. */
  private valueSet(el: Element) {
    if (!this.isTextField(el)) return;
    this.kept.delete(el);
    if (this.doc.activeElement === el) el.setSelectionRange(el.value.length, el.value.length);
    if (this.caretField === el) this.caretField = null;
    const end = byteAt(el.value, el.value.length);
    if (listens(el, "caret")) this.heard.set(el, { sel: [end, end], rev: this.revOf(el) });
  }

  /** The user may have moved the selection of the focused field, or `el`
   * (SPEC §9, `caret`): the next frame checks it, once however often it
   * moved meanwhile. Another field's check, waiting, is made first. */
  private noteCaret(el: Element | null = this.focusedControl()) {
    if (!el || this.detachedState || !this.isTextField(el) || !listens(el, "caret")) return;
    if (this.caretField && this.caretField !== el) this.flushCaret(this.caretField);
    this.caretField = el;
    if (this.caretFrame) return;
    this.caretFrame = this.frame.ownerDocument.defaultView!.requestAnimationFrame(() => {
      this.caretFrame = 0;
      const f = this.caretField;
      this.caretField = null;
      if (f) this.checkCaret(f);
    });
  }

  /** Makes `el`'s check now, if one waits: before another event of the
   * field (SPEC §9). */
  private flushCaret(el: Element) {
    if (this.caretField !== el) return;
    this.caretField = null;
    this.checkCaret(el);
  }

  /** `caret`, if the field's selection or its `rev` is not what the program
   * last heard: the user moved it, or edited a field that sends no
   * `input`. */
  private checkCaret(el: Element) {
    if (!el.isConnected || this.detachedState || !this.isTextField(el) || !listens(el, "caret")) return;
    const sel = wireSel(el.value, this.selectionOf(el));
    const rev = this.revOf(el);
    const end = byteAt(el.value, el.value.length);
    const h = this.heard.get(el) ?? { sel: [end, end], rev: 0 };
    if (h.sel[0] === sel[0] && h.sel[1] === sel[1] && h.rev === rev) return;
    this.heard.set(el, { sel, rev });
    const id = el.getAttribute("id");
    if (id) this.emit("caret", id, { sel, rev });
  }
}

/** The input types that are no control (SPEC §6.4). */
const NOT_CONTROLS = new Set(["hidden", "button", "submit", "reset", "image", "file"]);

/** An element whose value the user changes: an `input`, a `textarea`, a
 * `select`. */
function isControl(el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const n = el.localName;
  return n === "input" || n === "textarea" || n === "select";
}

/** The radio buttons of `el`'s group, `el` among them (HTML's: one name,
 * in one form, in one document); null for any other element, and for a
 * radio button with no name, which is in none. */
function radioGroup(el: Element): HTMLInputElement[] | null {
  const b = el as HTMLInputElement;
  if (b.localName !== "input" || b.type !== "radio") return null;
  const name = b.getAttribute("name");
  if (!name || !b.isConnected) return null;
  return Array.from(b.ownerDocument.querySelectorAll<HTMLInputElement>("input")).filter((r) => r.type === "radio" && r.getAttribute("name") === name && r.form === b.form);
}

/** A focused text field's selection, as the browser has it. */
function fieldSel(f: HTMLInputElement | HTMLTextAreaElement): Sel {
  const n = f.value.length;
  return { start: f.selectionStart ?? n, end: f.selectionEnd ?? n, backward: f.selectionDirection === "backward" };
}

/** An `input` or a `textarea`, whose value a history keeps. */
function isValueField(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  const n = (el as Element | null)?.localName;
  return n === "input" || n === "textarea";
}

/** Elements from the iframe's realm fail `instanceof Element` here. */
function isElement(n: EventTarget): n is Element {
  return (n as Node).nodeType === 1;
}

/** Whether `el`'s `data-on` lists `what`. */
function listens(el: Element, what: string): boolean {
  return (el.getAttribute("data-on") ?? "").split(/\s+/).includes(what);
}

/** The steps of a drag of `el`, from its `data-steps` when the drag starts
 * (SPEC §9.1); null when it has none. */
function stepsOf(el: Element): Steps | null {
  const n = parseSteps(el.getAttribute("data-steps"));
  return n && { el, x: n[0], y: n[1] };
}

/** Where (x, y) of the document is in `t`, a drag's target, in t's steps
 * (SPEC §9.1): `tx` and `ty`, measured against its border box where the user
 * sees it now, by the counts it has now. None when it has no `drop` in its
 * `data-on`, or no steps. */
function stepInTarget(t: Element | null, x: number, y: number): TargetStep {
  const n = t && listens(t, "drop") && parseSteps(t.getAttribute("data-steps"));
  if (!t || !n) return {};
  const box = t.getBoundingClientRect();
  const step: TargetStep = {};
  if (n[0]) step.tx = stepAt(x - box.left, box.width, n[0]);
  if (n[1]) step.ty = stepAt(y - box.top, box.height, n[1]);
  return step;
}

/** `el` and its ancestors, as an event's path would have them. */
function ancestry(el: Element): Element[] {
  const out: Element[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) out.push(n);
  return out;
}

/** The modifier keys held, as bits (SPEC §9): 1 shift, 2 alt, 4 ctrl, 8
 * super. Undefined when none is, since a body leaves the field out. */
function modsOf(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number | undefined {
  const bits = (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.metaKey ? 8 : 0);
  return bits || undefined;
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

/** A key that types no text (SPEC §10.4): one that is not a character, or a
 * character with Control or Meta. A field is offered it as pressed first;
 * typing comes only as the program would read it. */
function typesNoText(e: KeyboardEvent): boolean {
  if (e.getModifierState?.("AltGraph")) return false;
  if ([...e.key].length === 1) return e.ctrlKey || e.metaKey;
  return !NOT_KEYS.has(e.key);
}

/** A key as the program would read it (SPEC §10.4), from what xterm.js
 * sends for it (`data`; null when it cannot say, and the key is named from
 * the event, as a character where it is one). xterm.js drops a Meta it has
 * no encoding for, so Meta+Backspace is DEL: such a key is none the surface
 * reads, and goes on as it came. */
function typedKeys(e: KeyboardEvent, data: string | null): InputKey[] {
  if (data === null) return [{ key: pressNames(e).at(-1) ?? null, data: "" }];
  const keys = inputKeys(data);
  return e.metaKey ? keys.map((k) => (k.key !== null && !/(^|\+)super\+/.test(k.key) ? { ...k, key: null } : k)) : keys;
}

/** The names to ask an element's keymap about a key (SPEC §10.4): the first
 * name as pressed that it binds, alone, for a key that types no text;
 * otherwise the keys as the program would read it. */
function asked(keymap: Keymap, e: KeyboardEvent, data: string | null): string[] {
  const named = typesNoText(e) ? pressNames(e).find((n) => keymap.binds(n)) : undefined;
  return named !== undefined ? [named] : typedKeys(e, data).flatMap((k) => (k.key === null ? [] : [k.key]));
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
