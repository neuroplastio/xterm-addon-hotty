// HOTTY for xterm.js: the addon.
//
//   const term = new Terminal();
//   term.loadAddon(new HottyAddon());
//   term.open(element);
//
// Commands arrive on OSC 7279 (PROTOCOL §2); replies and events leave through
// `term.input(…, false)`, the same path as typing, so they reach the program
// on its stdin. Surfaces are sandboxed iframes in a layer over the screen.
// On the normal buffer a surface hangs from a marker (public API, unlike
// decorations, which need allowProposedApi): it scrolls with the text, stays
// visible while any of its rows is, and dies when its line leaves the
// scrollback. On the alternate buffer, where markers do not work (as
// xterm.js's own image addon notes), it sits on fixed cells.

import type { IBufferRange, IDisposable, IMarker, ITerminalAddon, Terminal } from "@xterm/xterm";
import { hostCss, palette } from "./hostcss.ts";
import { OPS, PatchError } from "./patch.ts";
import { clean, type Policy } from "./network.ts";
import { Store } from "./resources.ts";
import { type Scheme, Surface, type SurfaceHost } from "./surface.ts";
import { Touch } from "./touch.ts";
import { Assembler, Control, encode, OSC, text, type Command, type Decoded } from "./wire.ts";

export interface HottyOptions {
  /** Most surfaces at once (reported under `limits`). Default 64. */
  maxSurfaces?: number;
  /** Bytes of resources (reported under `limits`). Default 64 MB. */
  resourceQuota?: number;
  /** Called once per applied command batch, with timings, for measurements. */
  onFrame?: (f: FrameStats) => void;
  /** Called for commands that could not be decoded. */
  onInvalid?: (reason: string) => void;
  /**
   * What surfaces may fetch from the network: the host's half of the network
   * policy (SPEC §7.2), directive to sources, e.g.
   * `{ "img-src": ["https://example.com"] }`. A document gets what it asks
   * for (`<meta name="hotty-network">`) and this allows. Default: nothing.
   * The embedding page's own CSP must allow these sources too.
   */
  network?: Policy;
  /**
   * Touch on the whole terminal (SPEC §9): a drag scrolls, over the cells
   * and the surfaces alike, and a tap on the cells is a click for the
   * program. This replaces xterm.js's own touch handling, which in 6.1 sends
   * wheel reports with no position (NaN) and turns taps into nothing.
   * Default true.
   */
  touch?: boolean;
  /**
   * Keys the browser keeps: they never reach the program, from the terminal
   * or from a surface holding the keyboard, and the browser acts on them.
   * A terminal cannot know which keys a program binds, so these are the
   * browser's own. Default: `browserKeys`, which covers reload, zoom, full
   * screen, the developer tools, and on a Mac everything with Cmd.
   */
  browserKeys?: (e: KeyboardEvent) => boolean;
}

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The browser's own keys (the default for `browserKeys`): reload (F5, Ctrl
 * or Cmd with R), zoom (Ctrl or Cmd with +, - or 0), full screen (F11), the
 * developer tools (F12, Ctrl+Shift with I, J or C), and on a Mac everything
 * with Cmd. */
export function browserKeys(e: KeyboardEvent): boolean {
  if (e.key === "F5" || e.key === "F11" || e.key === "F12") return true;
  if (mac && e.metaKey) return true;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && !e.altKey && k === "r") return true;
  if (mod && ["=", "+", "-", "0"].includes(e.key)) return true;
  if (e.ctrlKey && e.shiftKey && ["i", "j", "c"].includes(k)) return true;
  return false;
}

export interface FrameStats {
  commands: number;
  /** Milliseconds spent applying them. */
  applyMs: number;
}

export interface Inspected {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: [string, string | null, string][];
}

/** `drag` stands for `dragstart`, `drag` and `dragend` (SPEC §4, §9.1). */
export const EVENTS = ["click", "change", "input", "submit", "press", "drag", "focus", "blur", "resize", "fit"];

interface Placement {
  surface: Surface;
  kind: "normal" | "alt";
  col: number;
  row: number;
  marker?: IMarker;
  disposables: IDisposable[];
}

class Failure extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.code = code;
  }
}

type Reply = { extra?: [string, string][]; body?: string };

export class HottyAddon implements ITerminalAddon {
  private term!: Terminal;
  private readonly opts: Required<Pick<HottyOptions, "maxSurfaces" | "resourceQuota">> & HottyOptions;
  private readonly store: Store;
  private readonly surfaces = new Map<string, Surface>();
  private readonly placements = new Map<string, Placement>();
  private readonly assembler = new Assembler();
  private readonly disposables: IDisposable[] = [];
  private layer: HTMLDivElement | null = null;
  /** Commands held while synchronized output is on (PROTOCOL §5). */
  private held: Command[] = [];
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  private css = "";
  private readonly policy: Policy;
  private metrics = { cellW: 0, cellH: 0, key: "" };
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** A surface's key is being forwarded to the terminal (`key`), and the
   * terminal's own focus is held off meanwhile. A program in the page may
   * answer the key inside its dispatch, since xterm.js parses what follows
   * user input at once: a surface that gives the keyboard back then has
   * its focus carried out once the key is through. */
  private forwarding = false;
  private focusAfter = false;

  constructor(options: HottyOptions = {}) {
    this.opts = { maxSurfaces: 64, resourceQuota: 64 << 20, ...options };
    this.policy = clean(options.network);
    this.store = new Store(this.opts.resourceQuota);
    this.store.onChange = (names) => {
      for (const s of this.surfaces.values()) s.refresh(names);
    };
  }

  activate(term: Terminal): void {
    this.term = term;
    // The browser's keys: xterm.js leaves them alone, and the browser acts.
    term.attachCustomKeyEventHandler((e) => !this.browserKey(e));
    const p = term.parser;
    this.disposables.push(
      p.registerOscHandler(OSC, (data) => this.onOsc(data)),
      // `CSI ? 2026 l` ends a synchronized batch: apply what was held, then
      // let xterm handle the mode as usual.
      p.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        if (params.some((x) => x === 2026)) this.release();
        return false;
      }),
      // RIS: every surface goes (PROTOCOL §4).
      p.registerEscHandler({ final: "c" }, () => {
        this.reset();
        return false;
      }),
      term.buffer.onBufferChange((b) => this.onBufferChange(b.type)),
      term.onRender(() => {
        this.bindTouch();
        this.checkMetrics();
      }),
      term.onResize(() => this.checkMetrics()),
      term.onScroll(() => this.reposition()),
      term.onWriteParsed(() => this.reposition()),
    );
  }

  dispose(): void {
    this.cellTouch?.dispose();
    this.cellTouch = null;
    this.reset();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.layer?.remove();
    this.layer = null;
  }

  /**
   * An element of a surface as the program wrote it (tag, attributes, text,
   * child elements): the shape the shared conformance vectors check
   * (conformance/README.md). `null` if there is no such surface or element.
   */
  inspect(surface: string, id: string): Inspected | null {
    const s = this.surfaces.get(surface);
    const el = s?.doc.getElementById(id);
    if (!s || !el) return null;
    return {
      tag: el.localName,
      attrs: Object.fromEntries(s.resolver.attributes(el)),
      text: el.textContent ?? "",
      children: Array.from(el.children, (c): [string, string | null, string] => [c.localName, c.getAttribute("id"), c.textContent ?? ""]),
    };
  }

  // --- Wire -----------------------------------------------------------------

  private onOsc(data: string): boolean | Promise<boolean> {
    const decoded = this.assembler.feed(data);
    // Only zlib makes decoding async; the parser waits for it, so order holds.
    if (decoded instanceof Promise) return decoded.then((d) => this.run(d)).then(() => true);
    const r = this.run(decoded);
    return r instanceof Promise ? r.then(() => true) : true;
  }

  private run(decoded: Decoded[]): void | Promise<void> {
    let chain: Promise<void> | undefined;
    for (const d of decoded) {
      if (d.kind === "invalid") this.opts.onInvalid?.(d.reason);
      if (d.kind !== "command") continue;
      const cmd = d.command;
      chain = sequence(chain, () => this.submit(cmd));
    }
    return chain;
  }

  private submit(cmd: Command): void | Promise<void> {
    if (this.term.modes.synchronizedOutputMode && cmd.control.get("a") !== "q") {
      this.held.push(cmd);
      // xterm gives up on a batch that never ends after a second; so do we.
      this.heldTimer ??= setTimeout(() => this.release(), 1000);
      return;
    }
    return this.apply([cmd]);
  }

  private release() {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    const batch = this.held;
    this.held = [];
    if (batch.length) void this.apply(batch);
  }

  private apply(batch: Command[]): void | Promise<void> {
    const t0 = performance.now();
    let chain: Promise<void> | undefined;
    for (const cmd of batch) chain = sequence(chain, () => this.handle(cmd));
    const done = () => this.opts.onFrame?.({ commands: batch.length, applyMs: performance.now() - t0 });
    if (chain) return chain.then(done);
    done();
  }

  private handle(cmd: Command): void | Promise<void> {
    const action = cmd.control.get("a") ?? "";
    const quiet = Number(cmd.control.get("q") ?? "0");
    const ok = (r: Reply | void) => {
      if (quiet === 0) this.reply("ok", cmd, r ?? {});
    };
    const fail = (e: unknown) => {
      const code = e instanceof Failure || e instanceof PatchError ? e.code : "EINVAL";
      const detail = e instanceof Error ? e.message : String(e);
      if (quiet < 2) this.reply("err", cmd, { body: JSON.stringify({ code, detail }) });
    };
    try {
      const r = this.dispatch(action, cmd);
      if (r instanceof Promise) return r.then(ok, fail);
      ok(r);
    } catch (e) {
      fail(e);
    }
  }

  private reply(kind: "ok" | "err", cmd: Command, r: Reply) {
    const c = new Control().set("a", kind);
    for (const k of ["n", "s"]) {
      const v = cmd.control.get(k);
      if (v !== undefined) c.set(k, v);
    }
    c.set("re", cmd.control.get("a") ?? "");
    for (const [k, v] of r.extra ?? []) c.set(k, v);
    this.send(encode(c, r.body ?? ""));
  }

  private send(message: string) {
    this.term.input(message, false);
  }

  // --- Commands (PROTOCOL §3-§6) -------------------------------------------

  private dispatch(action: string, cmd: Command): Reply | void | Promise<Reply | void> {
    const c = cmd.control;
    switch (action) {
      case "q":
        return { body: JSON.stringify(this.capabilities()) };
      case "doc": {
        const name = this.surfaceName(c);
        let s = this.surfaces.get(name);
        if (!s) {
          if (this.surfaces.size >= this.opts.maxSurfaces) throw new Failure("EQUOTA", `at most ${this.opts.maxSurfaces} surfaces`);
          s = new Surface(name, this.host(), this.hostCss(), this.scheme());
          this.surfaces.set(name, s);
        }
        // A new document ends a drag under way (SPEC §9.1); d=1 ends it
        // silently, detaching the surface.
        if (c.get("d") !== "1") s.cancelDrag();
        // d=1: detached at once, for a document the program only shows (§5.5).
        s.setDocument(text(cmd.payload), c.get("d") === "1");
        return;
      }
      case "place":
        return this.place(this.existing(c), c);
      case "hide": {
        // The document stays; the keyboard goes back to the terminal (§5.4),
        // and a drag under way ends (§9.1).
        const s = this.existing(c);
        s.cancelDrag();
        if (s.hasKeyboard()) s.blur();
        this.unplace(s.name);
        return;
      }
      case "patch": {
        const s = this.existing(c);
        s.patch(c.get("op") ?? "morph", c.get("t"), c.get("k"), text(cmd.payload));
        return;
      }
      case "res": {
        const id = c.get("id");
        if (!id) throw new Failure("EINVAL", "res needs id=<name>");
        try {
          this.store.put(id, c.get("type") ?? "application/octet-stream", cmd.payload);
        } catch (e) {
          throw new Failure("EQUOTA", (e as Error).message);
        }
        return;
      }
      case "del": {
        const id = c.get("id");
        if (id !== undefined) {
          this.store.remove(id);
          return;
        }
        const name = c.get("s");
        if (name === undefined) {
          this.reset();
          return;
        }
        if (!this.surfaces.has(name)) throw new Failure("ENOENT", `no surface ${name}`);
        this.remove(name);
        return;
      }
      case "detach":
        // The program is done with the surface: it reports nothing more,
        // and never takes the keyboard (§5.5). Detaching twice does nothing.
        this.existing(c).detach();
        return;
      case "focus": {
        const s = this.existing(c);
        if (s.detached) throw new Failure("EDETACHED", `surface ${s.name} is detached`);
        try {
          s.focus(c.get("t"));
        } catch (e) {
          throw new Failure("ENOTARGET", (e as Error).message);
        }
        return;
      }
      case "blur":
        this.existing(c).blur();
        return;
      case "":
        throw new Failure("EINVAL", "missing a=<action>");
      default:
        throw new Failure("EINVAL", `unknown action a=${action}`);
    }
  }

  private capabilities() {
    const { cellW, cellH } = this.cell();
    const scale = window.devicePixelRatio || 1;
    return {
      v: "0.1",
      ops: OPS,
      events: EVENTS,
      cell: { w: Math.round(cellW * scale), h: Math.round(cellH * scale) },
      scale,
      scheme: this.scheme(),
      limits: { resources: this.store.quota, surfaces: this.opts.maxSurfaces },
      net: this.policy,
      host: "xterm-addon-hotty",
    };
  }

  private surfaceName(c: Control): string {
    const s = c.get("s");
    if (s === undefined) throw new Failure("EINVAL", "missing s=<surface>");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) throw new Failure("EINVAL", `bad surface name ${JSON.stringify(s)}`);
    return s;
  }

  private existing(c: Control): Surface {
    const name = this.surfaceName(c);
    const s = this.surfaces.get(name);
    if (!s) throw new Failure("ENOENT", `no surface ${name}`);
    return s;
  }

  private place(s: Surface, c: Control): Reply {
    const cols = Number(c.get("c"));
    if (c.get("c") === undefined || !Number.isInteger(cols)) throw new Failure("EINVAL", "place needs c=<cols>");
    if (cols < 1 || cols > 1000) throw new Failure("EINVAL", "c out of range");
    const { cellW, cellH } = this.cell();
    const r = c.get("r");
    const auto = r === undefined || r === "auto";
    const rows = auto ? s.contentRows(cols, cellW, cellH) : Number(r);
    if (!Number.isInteger(rows) || rows < 1 || rows > 1000) throw new Failure("EINVAL", "r out of range");
    // The window: the part of the surface the placement shows (§5.2).
    const cell = (k: string, d: number) => {
      const v = c.get(k);
      if (v === undefined) return d;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new Failure("EINVAL", `bad ${k}`);
      return n;
    };
    const x = cell("x", 0);
    const y = cell("y", 0);
    const win = { x, y, w: cell("w", cols - x), h: cell("h", rows - y) };
    if (win.w < 1 || win.h < 1 || x + win.w > cols || y + win.h > rows) {
      throw new Failure("EINVAL", "the window is not inside the surface");
    }
    // Stacking (SPEC §5.2): z, then the order the surfaces were created in,
    // which is the boxes' order in the layer.
    const z = c.get("z") === undefined ? 0 : Number(c.get("z"));
    if (!Number.isInteger(z) || z < -1000 || z > 1000) throw new Failure("EINVAL", "z is an integer from -1000 to 1000");
    s.autoRows = auto;
    s.setSize(cols, rows, cellW, cellH, win);
    s.setZ(z);
    this.unplace(s.name);
    // Presses (SPEC §5.2): like z, the placement's.
    s.presses = c.get("p") === "1";
    // Fit (SPEC §5.2): the placement's too, from its own rows. The
    // placement keeps its size: re-placing is the program's to do.
    s.setFit(c.get("f") === "1" ? rows : null);

    const buf = this.term.buffer.active;
    const col = buf.cursorX;
    const row = buf.cursorY;
    const p: Placement = { surface: s, kind: buf.type === "normal" ? "normal" : "alt", col, row, disposables: [] };
    if (p.kind === "normal") {
      const marker = this.term.registerMarker(0);
      if (marker) {
        p.marker = marker;
        // Scrolled out of the scrollback: the placement dies (PROTOCOL §4).
        p.disposables.push(marker.onDispose(() => this.unplace(s.name)));
      } else {
        p.kind = "alt";
      }
    }
    this.placements.set(s.name, p);
    this.position(p);

    if (c.get("C") !== "1") this.moveCursorBelow(win.h);
    return { extra: [["c", String(cols)], ["r", String(rows)]] };
  }

  /** As the native host: index `rows` times, then carriage return. */
  private moveCursorBelow(rows: number) {
    // Private, as the official image addon does it (addon-image ImageStorage.ts:230).
    const core = (this.term as unknown as { _core?: { _inputHandler?: { lineFeed(): void }; buffer?: { x: number } } })._core;
    const ih = core?._inputHandler;
    if (ih && core?.buffer) {
      for (let i = 0; i < rows; i++) ih.lineFeed();
      core.buffer.x = 0;
    }
  }

  /** Puts every placed surface where its cells are now. */
  private reposition() {
    for (const p of this.placements.values()) this.position(p);
  }

  private position(p: Placement) {
    const { cellW, cellH } = this.cell();
    const s = p.surface;
    let row = p.row;
    if (p.kind === "normal") {
      const buf = this.term.buffer.active;
      if (buf.type !== "normal" || !p.marker || p.marker.line < 0) {
        s.hide();
        return;
      }
      row = p.marker.line - buf.viewportY;
    }
    if (row + s.win.h <= 0 || row >= this.term.rows) {
      s.hide();
      return;
    }
    s.setSize(s.cols, s.rows, cellW, cellH, s.win);
    s.show(Math.round(p.col * cellW), row * cellH);
  }

  private unplace(name: string) {
    const p = this.placements.get(name);
    if (!p) return;
    this.placements.delete(name);
    for (const d of p.disposables) d.dispose();
    p.marker?.dispose();
    p.surface.presses = false;
    p.surface.setFit(null);
    p.surface.park();
  }

  private remove(name: string) {
    this.unplace(name);
    this.surfaces.get(name)?.destroy();
    this.surfaces.delete(name);
  }

  private reset() {
    for (const name of Array.from(this.surfaces.keys())) this.remove(name);
    this.held = [];
  }

  private onBufferChange(type: "normal" | "alternate") {
    for (const p of Array.from(this.placements.values())) {
      // Surfaces placed on the alternate screen die with it (PROTOCOL §4).
      if (p.kind === "alt" && type === "normal") this.remove(p.surface.name);
    }
    this.reposition();
  }

  // --- Geometry and look ---------------------------------------------------

  private host(): SurfaceHost {
    return {
      layer: this.ensureLayer(),
      store: this.store,
      event: (surface, kind, target, detail) => {
        const c = new Control().set("a", "ev").set("s", surface).set("e", kind).set("t", target);
        this.send(encode(c, detail === undefined ? "" : JSON.stringify(detail)));
      },
      browserKey: (e) => this.browserKey(e),
      key: (e) => {
        // Through xterm.js's own keyboard handling, so the key is encoded
        // the way the program asked: DECCKM, modifyOtherKeys, the kitty
        // keyboard protocol. A printable key xterm.js leaves to keypress
        // (legacy input) gets one.
        const ta = this.term.textarea;
        if (!ta) return;
        const init = {
          key: e.key,
          code: e.code,
          location: e.location,
          repeat: e.repeat,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          keyCode: e.keyCode,
          which: e.which,
          bubbles: true,
          cancelable: true,
        };
        // xterm.js focuses the terminal on every keyup; the surface keeps
        // the keyboard, so its focus does nothing meanwhile.
        Object.defineProperty(ta, "focus", { value: () => {}, configurable: true });
        this.forwarding = true;
        try {
          const ev = new KeyboardEvent(e.type, init);
          ta.dispatchEvent(ev);
          if (e.type === "keydown" && !ev.defaultPrevented && [...e.key].length === 1) {
            const c = e.key.codePointAt(0)!;
            ta.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: c, keyCode: c, which: c }));
          }
        } finally {
          delete (ta as { focus?: unknown }).focus;
          this.forwarding = false;
          if (this.focusAfter) {
            this.focusAfter = false;
            this.term.focus();
          }
        }
      },
      focusTerminal: () => {
        if (this.forwarding) this.focusAfter = true;
        else this.term.focus();
      },
      policy: this.policy,
      // A hyperlink (SPEC §9) goes where xterm.js sends an OSC 8 one: the
      // terminal's linkHandler, or its confirm-then-open default, and only
      // for http and https unless the handler allows other schemes.
      hyperlink: (kind, e, url, box) => {
        const handler = this.term.options.linkHandler;
        if (!handler?.allowNonHttpProtocols) {
          try {
            if (!["http:", "https:"].includes(new URL(url).protocol)) return;
          } catch {
            return;
          }
        }
        const range = this.cellRange(box);
        if (kind === "activate") {
          if (handler) handler.activate(e, url, range);
          else openAfterConfirm(url);
        } else if (kind === "hover") handler?.hover?.(e, url, range);
        else handler?.leave?.(e, url, range);
      },
      // Replayed on the terminal's screen, where xterm handles it as its own:
      // scrollback, or mouse reports and arrow keys on the alternate screen.
      wheel: (e, x, y) => this.forwardWheel(e, x, y),
      cells: (kind, e, x, y) => this.pressCells(kind, e, x, y),
    };
  }

  private cellTouch: Touch | null = null;

  /** Touch on the cells (the `touch` option), once the terminal is open. */
  private bindTouch() {
    const el = this.term.element;
    if (this.cellTouch || !el || this.opts.touch === false) return;
    const screen = () => el.querySelector(".xterm-screen");
    this.cellTouch = new Touch(
      el,
      el.ownerDocument.defaultView!,
      {
        scroll: (dx, dy, x, y) => this.forwardWheel(new WheelEvent("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0 }), x, y),
        // A tap is the press and release a click would make: xterm.js
        // reports them to the program as it reports a mouse.
        tap: (x, y) => {
          const at = { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, view: el.ownerDocument.defaultView };
          screen()?.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
          el.ownerDocument.dispatchEvent(new MouseEvent("mouseup", { ...at, buttons: 0 }));
        },
        toPage: (x, y) => [x, y],
      },
      true,
    );
  }

  /** A wheel, at a point in the page, replayed on the terminal's screen,
   * where xterm.js handles it as its own: scrollback, or mouse reports and
   * arrow keys on the alternate screen. */
  private forwardWheel(e: WheelEvent, x: number, y: number) {
    const ev = new WheelEvent("wheel", {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      clientX: x,
      clientY: y,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      bubbles: true,
      cancelable: true,
    });
    legacyWheelDelta(ev, e);
    this.term.element?.querySelector(".xterm-screen")?.dispatchEvent(ev);
  }

  /**
   * A press with Alt held on a surface, a move of its gesture, or its
   * release (SPEC §9.2), replayed on the cells beneath, where xterm.js
   * handles them as its own mouse: a report to the program, with Alt, or
   * its selection (rectangular, with Alt). The press goes to the screen,
   * where xterm.js listens for presses; the moves and the release to its
   * document, where it listens while a button is held. The keyboard goes
   * back to the terminal first, as on a click on the cells (§10.1): a
   * surface that had it sends `blur`.
   */
  private pressCells(kind: "down" | "move" | "up", e: MouseEvent, x: number, y: number) {
    const el = this.term.element;
    if (!el) return;
    const init: MouseEventInit = {
      clientX: x,
      clientY: y,
      screenX: e.screenX,
      screenY: e.screenY,
      button: 0,
      buttons: e.buttons,
      // xterm.js selects on a press whose detail is the click count.
      detail: kind === "down" ? e.detail || 1 : e.detail,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      bubbles: true,
      cancelable: true,
      view: el.ownerDocument.defaultView,
    };
    if (kind === "down") {
      for (const s of this.surfaces.values()) if (s.hasKeyboard()) s.blur();
      el.querySelector(".xterm-screen")?.dispatchEvent(new MouseEvent("mousedown", init));
      return;
    }
    el.ownerDocument.dispatchEvent(new MouseEvent(kind === "move" ? "mousemove" : "mouseup", init));
  }

  private ensureLayer(): HTMLDivElement {
    if (this.layer?.isConnected) return this.layer;
    const screen = this.term.element?.querySelector(".xterm-screen");
    if (!screen) throw new Failure("EINVAL", "terminal is not open");
    const layer = document.createElement("div");
    layer.className = "hotty-layer";
    // The screen's size, clipping surfaces that are partly scrolled away.
    Object.assign(layer.style, { position: "absolute", inset: "0", overflow: "hidden", zIndex: "6", pointerEvents: "none" });
    screen.append(layer);
    this.layer = layer;
    return layer;
  }

  private browserKey(e: KeyboardEvent): boolean {
    return (this.opts.browserKeys ?? browserKeys)(e);
  }

  /** A box in the page as the buffer cells it covers (1-based, as xterm.js
   * gives an OSC 8 link's range). */
  private cellRange(box: DOMRect): IBufferRange {
    const screen = this.term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    const { cellW, cellH } = this.cell();
    const top = this.term.buffer.active.viewportY;
    const at = (x: number, y: number) => ({
      x: Math.floor((x - (screen?.left ?? 0)) / cellW) + 1,
      y: top + Math.floor((y - (screen?.top ?? 0)) / cellH) + 1,
    });
    return { start: at(box.left, box.top), end: at(box.right - 1, box.bottom - 1) };
  }

  /** Cell size in CSS pixels (private in xterm.js), with a measured fallback. */
  private cell(): { cellW: number; cellH: number } {
    const dims = (this.term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } })._core?._renderService?.dimensions?.css?.cell;
    if (dims && dims.width > 0 && dims.height > 0) return { cellW: dims.width, cellH: dims.height };
    const screen = this.term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (screen && this.term.cols > 0) return { cellW: screen.clientWidth / this.term.cols, cellH: screen.clientHeight / this.term.rows };
    return { cellW: 9, cellH: 17 };
  }

  private hostCss(): string {
    const { cellW, cellH } = this.cell();
    const o = this.term.options;
    this.css = hostCss(o.theme, { cellW, cellH, fontFamily: o.fontFamily ?? "monospace", fontSize: o.fontSize ?? 15 });
    return this.css;
  }

  private scheme(): Scheme {
    return palette(this.term.options.theme).dark ? "dark" : "light";
  }

  /** On every render: did the cell size, font or theme change? */
  private checkMetrics() {
    const { cellW, cellH } = this.cell();
    const o = this.term.options;
    const key = `${cellW}x${cellH}|${o.fontFamily}|${o.fontSize}|${JSON.stringify(o.theme ?? {})}`;
    if (key === this.metrics.key) return;
    const sizeChanged = this.metrics.cellW !== 0 && (cellW !== this.metrics.cellW || cellH !== this.metrics.cellH);
    this.metrics = { cellW, cellH, key };
    if (this.surfaces.size === 0) return;
    const css = this.hostCss();
    const scheme = this.scheme();
    for (const s of this.surfaces.values()) s.setHostCss(css, scheme);
    this.reposition();
    if (sizeChanged) {
      // Re-rendered with no program involvement; tell the program the new size.
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        for (const p of this.placements.values()) {
          const s = p.surface;
          if (s.detached) continue; // it sends no events (§5.5)
          this.host().event(s.name, "resize", "", { w: Math.round(s.cols * cellW), h: s.rows * cellH });
        }
      }, 100);
    }
  }
}

/** Runs `f` after `chain`, synchronously when nothing before it was async. */
function sequence(chain: Promise<void> | undefined, f: () => void | Promise<void>): Promise<void> | undefined {
  if (chain) return chain.then(f);
  const r = f();
  return r instanceof Promise ? r : undefined;
}

/** xterm.js's default for an OSC 8 link with no linkHandler, as it has it:
 * ask, then open without an opener. */
function openAfterConfirm(uri: string): void {
  if (!confirm(`Do you want to navigate to ${uri}?\n\nWARNING: This link could potentially be dangerous`)) return;
  const w = window.open();
  if (!w) {
    console.warn("Opening link blocked as opener could not be cleared");
    return;
  }
  try {
    w.opener = null;
  } catch {
    // Electron can throw
  }
  w.location.href = uri;
}

/**
 * xterm.js scrolls its scrollback with VS Code's scrollable, which reads the
 * legacy `wheelDeltaX`/`wheelDeltaY` wherever the browser has them (Chromium,
 * WebKit), and those are 0 on a constructed event: without this, a forwarded
 * wheel moves nothing there. A real wheel's own values are kept. A drag's
 * (pixels) are chosen so the scrollback moves as far as the finger: the
 * scrollable moves 50 pixels per 120 of wheelDelta.
 */
function legacyWheelDelta(ev: WheelEvent, from: WheelEvent) {
  if (!("wheelDeltaY" in WheelEvent.prototype)) return; // Firefox reads deltaY
  const legacy = from as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
  const pixels = from.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 : from.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 400;
  const x = legacy.wheelDeltaX || -from.deltaX * pixels * (120 / 50);
  const y = legacy.wheelDeltaY || -from.deltaY * pixels * (120 / 50);
  Object.defineProperty(ev, "wheelDeltaX", { value: x });
  Object.defineProperty(ev, "wheelDeltaY", { value: y });
}
