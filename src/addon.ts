// hotty for xterm.js: the addon.
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
import { boxBackground, hostCss, palette } from "./hostcss.ts";
import { DeltaError, readDelta } from "./delta.ts";
import { Float, float, Writer, type Body, type Value } from "./msgpack.ts";
import { clean, type Policy } from "./network.ts";
import { Store } from "./resources.ts";
import { displayKey, EDIT_ACTIONS, editAction, editOf, type Platform, pressNames, readKey } from "./keys.ts";
import { entries, find, hides, isGroup, type Menu, type MenuEntry, Menus, readMenu, readSeq, shownLevel } from "./menu.ts";
import { type KeySettings, type Route, type Scheme, Surface, type SurfaceHost } from "./surface.ts";
import { areaAt, areaDrags, LONG_PRESS_MS, readTouchAreas, Touch, type TouchArea, type TouchBegin } from "./touch.ts";
import { HOST, VERSION } from "./version.ts";
import { Assembler, Control, encode, MAX_COMMAND, OSC, text, type Command, type Decoded } from "./wire.ts";

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
   * program. In the cells a program names with `a=touch` (§9.6), a drag
   * the way one drags is the program's mouse instead. This replaces
   * xterm.js's own touch handling, which in 6.1 sends wheel reports with no
   * position (NaN) and turns taps into nothing. Default true.
   */
  touch?: boolean;
  /**
   * What a wheel or a touch drag scrolls, over the cells and the surfaces
   * alike (SPEC §9). `"terminal"` (the default): the terminal's scrollback,
   * or on the alternate screen the program's wheel input. `"page"`: the page
   * the terminal is in, for a page that shows a program's output whole, with
   * the terminal as tall as what it shows. Neither the addon nor xterm.js
   * takes a wheel or a touch then: the browser scrolls the page, natively,
   * and the program hears no wheel. `touch` does nothing in this mode.
   */
  scroll?: "terminal" | "page";
  /**
   * Keys the browser keeps: they never reach the program, from the terminal
   * or from a surface holding the keyboard, and the browser acts on them.
   * A terminal cannot know which keys a program binds, so these are the
   * browser's own. Default: `browserKeys`, which covers reload, zoom, full
   * screen, the developer tools, and on a Mac everything with Cmd.
   */
  browserKeys?: (e: KeyboardEvent) => boolean;
  /**
   * Keys that copy what is selected on the cells to the clipboard. While
   * something is selected there they reach neither a surface nor the
   * program; with nothing selected they go where they would, so Ctrl+C
   * still interrupts. Default: `copyKeys`, Ctrl+C and Cmd+C. `() => false`
   * leaves copying the cells to the browser alone. A surface's selection
   * is copied by its keymap (SPEC §10.2, §11), Ctrl+C and Cmd+C by
   * default, whatever this says.
   */
  copyKeys?: (e: KeyboardEvent) => boolean;
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

/** The copy keys (the default for `copyKeys`): Ctrl+C, and Cmd+C (Meta). */
export function copyKeys(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c";
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

/** A wheel this soon after the one before belongs to the same gesture, in
 * milliseconds: a wheel's notches, or a touchpad's scroll and its momentum. */
const GESTURE_MS = 150;

/** The hotty versions the addon speaks (SPEC §4), highest first. The first
 * is VERSION's MAJOR.MINOR (gov P-5 rule 6). */
export const SPEAKS = ["0.5"];

/**
 * The version a query is answered in (SPEC §4): the highest the addon
 * speaks of those its `v` lists, comma-separated. A version has one
 * spelling (`major.minor`, no leading zeros), so an entry is one only
 * exactly: `0.20` is not 0.2. None, as with no `v` at all, is `EVERSION`,
 * its detail the versions the addon speaks (§3.6).
 */
function answerIn(v: string | undefined): string {
  const listed = (v ?? "").split(",");
  const shared = SPEAKS.find((s) => listed.includes(s));
  if (shared === undefined) throw new Failure("EVERSION", SPEAKS.join(","));
  return shared;
}

/** The longest label a menu shows, in characters; the rest is cut. */
const LABEL_CHARS = 32;
/** The most items a column of a menu holds. */
const COLUMN_ITEMS = 10;

/** Where a placement goes (SPEC §5.2): the cursor's cell when its command
 * came. On the normal buffer a marker holds its line; on the alternate,
 * fixed cells. */
interface Spot {
  kind: "normal" | "alt";
  col: number;
  row: number;
  marker?: IMarker;
  /** On the alternate screen, which one (`altScreens`). */
  alt?: number;
  /** Held in a batch (`hold`): the rows it measured as it came. */
  rows?: number;
}

interface Placement {
  surface: Surface;
  kind: "normal" | "alt";
  col: number;
  row: number;
  marker?: IMarker;
  disposables: IDisposable[];
}

/** A command held while synchronized output is on, and for `a=place`,
 * where it came (`hold`). */
interface Held {
  cmd: Command;
  at?: Spot;
}

class Failure extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** The optional features the addon has (SPEC §4). It lets the pointer pass
 * through no surface (`passthrough`, §9.3) and sends no `hover` (§9.4). */
const FEATURES = ["count", "menu"];

type Reply = { extra?: [string, string][]; body?: Body };

/** Where xterm.js sends what the program reads (its core service). */
type DataSink = { triggerDataEvent(data: string, wasUserInput?: boolean): void };

/** The modifier keys an event has held. */
type Keys = Pick<MouseEvent, "altKey" | "ctrlKey" | "shiftKey" | "metaKey">;
const keysOf = (e: Keys): Keys => ({ altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey });

/** What `pressCells` replays of a mouse event: a surface's, or a finger's
 * as the mouse (SPEC §9.6). */
type MouseLike = Keys & Pick<MouseEvent, "screenX" | "screenY" | "buttons" | "detail">;

export class HottyAddon implements ITerminalAddon {
  private term!: Terminal;
  private readonly opts: Required<Pick<HottyOptions, "maxSurfaces" | "resourceQuota">> & HottyOptions;
  private readonly store: Store;
  private readonly surfaces = new Map<string, Surface>();
  private readonly placements = new Map<string, Placement>();
  private readonly assembler = new Assembler();
  /** Replies' and events' bodies (SPEC §3.3), each sent as it is written. */
  private readonly writer = new Writer();
  private readonly disposables: IDisposable[] = [];
  private layer: HTMLDivElement | null = null;
  /** The terminal's element, whose presses drop the surfaces' selections,
   * and whose focus moves an `a=focus` that waits (`watch`). */
  private pressed: HTMLElement | null = null;
  private readonly dropSelections = () => {
    for (const s of this.surfaces.values()) s.clearSelection();
  };
  /** A press on the cells drops the surfaces' selections. A click (SPEC
   * §10.1: the primary button, without Alt) also ends an `a=focus` that
   * waits: the keyboard comes back to the terminal. */
  private readonly cellsPressed = (e: MouseEvent) => {
    this.dropSelections();
    if (e.button === 0 && !e.altKey) for (const s of this.surfaces.values()) s.dropWait(true);
  };
  /** Focus comes into the terminal, and not by a click (Tab, or the page
   * focusing it): an `a=focus` that waited moves now. */
  private readonly focusIn = () => {
    for (const s of this.surfaces.values()) s.takeFocus();
  };
  /** Commands held while synchronized output is on (PROTOCOL §5). */
  private held: Held[] = [];
  /** How many times the alternate screen was entered: a placement held on
   * one that has gone since goes with it. */
  private altScreens = 0;
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  private css = "";
  private readonly policy: Policy;
  private metrics = { cellW: 0, cellH: 0, key: "" };
  /** The capabilities the program last heard (SPEC §4), from its query or a
   * `caps` event; null while it has asked for none. */
  private heard: Body | null = null;
  /** The font and the cell (CSS px) it heard them with: a new cell is owed
   * as `cellcss` when the font changed, or by more than a device pixel's
   * rounding (SPEC §5.3). */
  private told = { cellW: 0, cellH: 0, font: "" };
  private capsTimer: ReturnType<typeof setTimeout> | null = null;
  private pixelWatch: IDisposable | null = null;
  /** A surface's key is being forwarded to the terminal (`key`), and the
   * terminal's own focus is held off meanwhile. A program in the page may
   * answer the key inside its dispatch, since xterm.js parses what follows
   * user input at once: a surface that gives the keyboard back then has
   * its focus carried out once the key is through. */
  private forwarding = false;
  private focusAfter = false;
  /** The wheel gesture under way: the surface its last wheel was over ("" for
   * the cells), where it goes, and when that wheel came. */
  private gesture: { surface: string; route: Route; at: number } | null = null;
  /** How keys are read (SPEC §10.4): `mod` is `super` on a Mac, `ctrl` elsewhere. */
  private readonly keys: KeySettings;
  /** The edit commands the program takes on each screen (SPEC §10.6). */
  private readonly taken = { normal: new Set<string>(), alternate: new Set<string>() };
  /** Keys whose keydown was a command: their release sends nothing. */
  private readonly commandCodes = new Set<string>();
  /** A paste command waiting for the browser's paste, which brings the
   * clipboard's text: the key, and the fallback that reads it instead. */
  private pasting: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** `encodeKey` runs a key through xterm.js: it is not typed. */
  private encoding = false;
  /** The program's menu on each screen (SPEC §10.7). */
  private readonly menus = new Menus();
  /** The cells where a finger drags as the mouse, on each screen (SPEC
   * §9.6). */
  private readonly touchAreas: Record<"normal" | "alternate", TouchArea[]> = { normal: [], alternate: [] };
  /** The keys of the level shown (`a=menu:show=1`), null when none is, and
   * where it shows. */
  private shownSeq: string[] | null = null;
  private menuEl: HTMLDivElement | null = null;
  /** The terminal's element, whose paste a `paste` command takes. */
  private pasteOn: HTMLElement | null = null;

  constructor(options: HottyOptions = {}) {
    this.opts = { maxSurfaces: 64, resourceQuota: 64 << 20, ...options };
    const platform: Platform = { mod: mac ? "super" : "ctrl" };
    this.keys = { platform };
    this.policy = clean(options.network);
    this.store = new Store(this.opts.resourceQuota);
    this.store.onChange = (names) => {
      for (const s of this.surfaces.values()) s.refresh(names);
    };
  }

  activate(term: Terminal): void {
    this.term = term;
    // The browser's keys: xterm.js leaves them alone, and the browser acts.
    // A key of an edit command the program takes is the command (SPEC
    // §10.6), after the terminal's selection is copied.
    term.attachCustomKeyEventHandler((e) => {
      if (this.copyKey(e)) return false;
      if (!this.encoding) {
        if (e.type === "keyup" && this.commandCodes.delete(e.code)) return false;
        if (e.type === "keydown") {
          this.menuKey(e);
          if (this.command(e)) return false;
        }
      }
      return !this.browserKey(e);
    });
    // One selection (SPEC §11): a selection made on the cells drops a
    // surface's, as a press there does (`ensureLayer`).
    this.disposables.push(
      term.onSelectionChange(() => {
        if (term.hasSelection()) this.dropSelections();
      }),
    );
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
        this.taken.normal.clear();
        this.taken.alternate.clear();
        this.touchAreas.normal = [];
        this.touchAreas.alternate = [];
        this.menus.clear();
        this.shownSeq = null;
        this.drawMenu();
        return false;
      }),
      term.buffer.onBufferChange((b) => this.onBufferChange(b.type)),
      term.onRender(() => {
        this.bindTouch();
        this.bindPaste();
        this.checkMetrics();
      }),
      term.onResize(() => this.checkMetrics()),
      term.onScroll(() => this.reposition()),
      term.onWriteParsed(() => this.reposition()),
    );
    this.watchPixels();
  }

  /** A zoom, or a display with another pixel density, changes
   * `--hotty-px` (SPEC §5.3, §8) even where nothing is drawn: the media
   * query for the current density stops matching when it changes. */
  private watchPixels() {
    this.pixelWatch?.dispose();
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const changed = () => {
      this.checkMetrics();
      this.watchPixels();
    };
    query.addEventListener("change", changed, { once: true });
    this.pixelWatch = { dispose: () => query.removeEventListener("change", changed) };
  }

  dispose(): void {
    if (this.pasting) clearTimeout(this.pasting.timer);
    this.pasting = null;
    this.pasteOn?.removeEventListener("paste", this.onPaste, true);
    this.pasteOn = null;
    this.menuEl?.remove();
    this.menuEl = null;
    this.cellTouch?.dispose();
    this.cellTouch = null;
    this.reset();
    if (this.capsTimer) clearTimeout(this.capsTimer);
    this.capsTimer = null;
    this.pixelWatch?.dispose();
    this.pixelWatch = null;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.layer?.remove();
    this.layer = null;
    this.unwatch();
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
      const at = cmd.control.get("a") === "place" ? this.hold(cmd.control) : undefined;
      this.held.push({ cmd, at });
      // xterm gives up on a batch that never ends after a second; so do we.
      this.heldTimer ??= setTimeout(() => this.release(), 1000);
      return;
    }
    return this.apply([{ cmd }]);
  }

  /**
   * A placement held in a batch is drawn when the batch ends (SPEC §6.3),
   * but it goes where the cursor is as it comes, and unless `C=1` it moves
   * the cursor below it then (§5.2), so what the batch writes next is below
   * it. How far is its rows: for `r=auto` only the document can tell, so
   * what the batch held before it is applied first (and may be drawn
   * before the batch ends). A place that will fail moves nothing.
   */
  private hold(c: Control): Spot {
    const at = this.cursorSpot();
    if (c.get("C") === "1") return at;
    const r = c.get("r");
    if (r === undefined || r === "auto") this.release();
    try {
      // A surface the batch creates before it is placed too.
      const name = this.surfaceName(c);
      if (!this.surfaces.has(name) && !this.held.some((h) => h.cmd.control.get("a") === "doc" && h.cmd.control.get("s") === name)) return at;
      const { cellW, cellH } = this.cell();
      const { rows, win } = this.measure(c, (cols) => this.existing(c).contentRows(cols, cellW, cellH));
      at.rows = rows;
      this.moveCursorBelow(win.h);
      // Laid out unseen, it shows as it was placed until the batch ends.
      const p = this.placements.get(name);
      if (p) this.position(p);
    } catch {
      // It fails as it is applied.
    }
    return at;
  }

  private release() {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    const batch = this.held;
    this.held = [];
    if (batch.length) void this.apply(batch);
  }

  private apply(batch: Held[]): void | Promise<void> {
    const t0 = performance.now();
    let chain: Promise<void> | undefined;
    for (const { cmd, at } of batch) chain = sequence(chain, () => this.handle(cmd, at));
    const done = () => this.opts.onFrame?.({ commands: batch.length, applyMs: performance.now() - t0 });
    if (chain) return chain.then(done);
    done();
  }

  private handle(cmd: Command, at?: Spot): void | Promise<void> {
    const action = cmd.control.get("a") ?? "";
    // Only errors, unless asked (SPEC §3.5): a query and a command with `n`
    // are answered, any other command only when it fails.
    const quiet = Number(cmd.control.get("q") ?? (action === "q" || cmd.control.get("n") !== undefined ? "0" : "1"));
    const ok = (r: Reply | void) => {
      if (quiet === 0) this.reply("ok", cmd, r ?? {});
    };
    const fail = (e: unknown) => {
      const code = e instanceof Failure || e instanceof DeltaError ? e.code : "EINVAL";
      const detail = e instanceof Error ? e.message : String(e);
      // A delta's error names the op at fault by its index (SPEC §6.1).
      const extra: [string, string][] = e instanceof DeltaError && e.i !== undefined ? [["i", String(e.i)]] : [];
      if (quiet < 2) this.reply("err", cmd, { extra, body: { code, detail } });
    };
    try {
      const r = this.dispatch(action, cmd, at);
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
    this.send(encode(c, r.body ? this.writer.body(r.body) : ""));
  }

  private send(message: string) {
    this.term.input(message, false);
  }

  // --- Commands (PROTOCOL §3-§6) -------------------------------------------

  private dispatch(action: string, cmd: Command, at?: Spot): Reply | void | Promise<Reply | void> {
    const c = cmd.control;
    switch (action) {
      case "q":
        // Answered at once, `late=1` or not: the addon is attached to its
        // terminal from the start, so it holds no query (§4). What the
        // program hears is what a `caps` event differs from (§9).
        return { body: this.hear(this.capabilities(answerIn(c.get("v")))) };
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
        // scroll: the axes it scrolls along, a bitmask; anything else is none.
        const scroll = c.get("scroll");
        s.setDocument(text(cmd.payload), c.get("d") === "1", scroll === "1" || scroll === "2" || scroll === "3" ? Number(scroll) : 0);
        return;
      }
      case "place":
        try {
          return this.place(this.existing(c), c, at);
        } catch (e) {
          at?.marker?.dispose();
          throw e;
        }
      case "hide": {
        // The document stays; the keyboard goes back to the terminal (§5.4),
        // and a drag under way ends (§9.1).
        const s = this.existing(c);
        s.cancelDrag();
        if (s.hasKeyboard()) s.blur();
        this.unplace(s.name);
        return;
      }
      case "delta": {
        // Checked whole first, then applied in order as one unit; the first
        // op that failed is the error (SPEC §6.1).
        const s = this.existing(c);
        const failed = s.delta(readDelta(cmd.payload));
        if (failed) throw failed;
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
        // a=focus moves the keyboard within the terminal (§10.1). From a
        // control of the page around the terminal it takes no focus, as a
        // native terminal's takes none from another window: the surface has
        // the keyboard, and the page's focus once the terminal has it.
        const now = this.focusInside();
        try {
          s.focus(c.get("t"), now);
        } catch (e) {
          throw new Failure("ENOTARGET", (e as Error).message);
        }
        // The keyboard is this surface's: one that waited elsewhere moved.
        for (const o of this.surfaces.values()) if (o !== s) o.dropWait(false);
        if (!now) this.watch();
        return;
      }
      case "blur":
        this.existing(c).blur();
        return;
      case "edit": {
        // The commands the program on this screen takes (SPEC §10.6); a
        // name the addon does not know is ignored.
        const take = (c.get("take") ?? "").split(",").filter((n) => (EDIT_ACTIONS as readonly string[]).includes(n));
        this.taken[this.term.buffer.active.type] = new Set(take);
        return;
      }
      case "touch":
        // The cells where a finger drags as the mouse (SPEC §9.6), on this
        // screen; no body leaves none. A drag under way goes on.
        this.touchAreas[this.term.buffer.active.type] = readTouchAreas(cmd.payload);
        return;
      case "menu": {
        // The program's menu (SPEC §10.7): set or left none, or a level of
        // it shown or hidden.
        const screen = this.term.buffer.active.type;
        const show = c.get("show");
        if (show !== undefined && show !== "0" && show !== "1") throw new Failure("EINVAL", "show is 0 or 1");
        if (show === "1") {
          this.shownSeq = readSeq(cmd.payload);
        } else if (show === "0") {
          this.shownSeq = null;
        } else {
          this.menus.set(screen, cmd.payload.length ? readMenu(cmd.payload) : null);
        }
        this.drawMenu();
        return;
      }
      case "":
        throw new Failure("EINVAL", "missing a=<action>");
      default:
        throw new Failure("EINVAL", `unknown action a=${action}`);
    }
  }

  /** The capabilities (SPEC §4) in version `v`, each field as its type. */
  private capabilities(v: string): Body {
    const { cellW, cellH } = this.cell();
    const scale = window.devicePixelRatio || 1;
    // A limit is an int; an embedder's Infinity is none, and left out.
    const limit = (n: number) => (Number.isFinite(n) ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : undefined);
    return {
      v,
      cellcss: { w: float(cellW), h: float(cellH) },
      scale: float(scale),
      scheme: this.scheme(),
      mod: this.keys.platform.mod,
      features: FEATURES,
      limits: { resources: limit(this.store.quota), surfaces: limit(this.opts.maxSurfaces), message: MAX_COMMAND },
      net: this.policy,
      edit: editOf(this.keys.platform),
      host: HOST,
      version: VERSION,
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

  /** `at`: where it was held in a batch (`hold`), not where the cursor is
   * now; the cursor moved then. */
  private place(s: Surface, c: Control, at?: Spot): Reply {
    const { cellW, cellH } = this.cell();
    const { cols, rows, auto, win, z } = this.measure(c, (cols) => at?.rows ?? s.contentRows(cols, cellW, cellH));
    s.autoRows = auto;
    s.setSize(cols, rows, cellW, cellH, win);
    s.setZ(z);
    this.unplace(s.name);
    // What the program hears (SPEC §5.2): `p`, `f` and `v` belong to the
    // surface, 1 on and 0 off, held until sent again; anything else is as
    // if absent. (Hover is not sent: `v` has nothing to turn on.)
    const flag = (k: string) => (c.get(k) === "1" ? true : c.get(k) === "0" ? false : undefined);
    s.presses = flag("p") ?? s.presses;
    s.fits = flag("f") ?? s.fits;
    // Fit counts from the placement's own rows. The placement keeps its
    // size: re-placing is the program's to do.
    s.setFit(s.fits ? rows : null);
    // View (SPEC §9.5): its first goes out once drawn, if it differs from
    // what the program last heard.
    s.beginPlacement();

    const spot = at ?? this.cursorSpot();
    const p: Placement = { surface: s, kind: spot.kind, col: spot.col, row: spot.row, marker: spot.marker, disposables: [] };
    // Scrolled out of the scrollback: the placement dies (PROTOCOL §4).
    if (p.marker) p.disposables.push(p.marker.onDispose(() => this.unplace(s.name)));
    this.placements.set(s.name, p);
    const buf = this.term.buffer.active;
    // Held in a batch, its line or its screen may have gone before the
    // batch ended, and it with them.
    if (p.marker?.isDisposed) this.unplace(s.name);
    else if (spot.alt !== undefined && (buf.type !== "alternate" || spot.alt !== this.altScreens)) this.remove(s.name);
    else this.position(p);

    if (!at && c.get("C") !== "1") this.moveCursorBelow(win.h);
    return { extra: [["c", String(cols)], ["r", String(rows)]] };
  }

  /** A placement's size, window and z (SPEC §5.2), as its command gives
   * them; `contentRows` lays the document out for `r=auto`. */
  private measure(c: Control, contentRows: (cols: number) => number) {
    const cols = Number(c.get("c"));
    if (c.get("c") === undefined || !Number.isInteger(cols)) throw new Failure("EINVAL", "place needs c=<cols>");
    if (cols < 1 || cols > 1000) throw new Failure("EINVAL", "c out of range");
    const r = c.get("r");
    const auto = r === undefined || r === "auto";
    const rows = auto ? contentRows(cols) : Number(r);
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
    return { cols, rows, auto, win, z };
  }

  /** The cursor's cell now, where a placement goes. */
  private cursorSpot(): Spot {
    const buf = this.term.buffer.active;
    const at: Spot = { kind: buf.type === "normal" ? "normal" : "alt", col: buf.cursorX, row: buf.cursorY };
    if (buf.type === "alternate") at.alt = this.altScreens;
    if (at.kind === "normal") {
      const marker = this.term.registerMarker(0);
      if (marker) at.marker = marker;
      else at.kind = "alt";
    }
    return at;
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
    p.surface.setFit(null);
    p.surface.endPlacement();
    p.surface.park();
  }

  private remove(name: string) {
    this.unplace(name);
    this.surfaces.get(name)?.destroy();
    this.surfaces.delete(name);
  }

  private reset() {
    for (const name of Array.from(this.surfaces.keys())) this.remove(name);
    for (const h of this.held) h.at?.marker?.dispose();
    this.held = [];
  }

  private onBufferChange(type: "normal" | "alternate") {
    if (type === "alternate") this.altScreens++;
    for (const p of Array.from(this.placements.values())) {
      // Surfaces placed on the alternate screen die with it (PROTOCOL §4).
      if (p.kind === "alt" && type === "normal") this.remove(p.surface.name);
    }
    // Leaving the alternate screen drops the commands taken, the touch
    // areas and the menu there, and any change hides the level shown (SPEC
    // §9.6, §10.6, §10.7).
    if (type === "normal") {
      this.taken.alternate.clear();
      this.touchAreas.alternate = [];
    }
    this.menus.change(type);
    this.shownSeq = null;
    this.drawMenu();
    this.reposition();
  }

  // --- Geometry and look ---------------------------------------------------

  /** The run of clicks the last click was in (SurfaceHost.clickCount). */
  private clickRun: { surface: string; el: Element; base: number } | null = null;

  private host(): SurfaceHost {
    return {
      layer: this.ensureLayer(),
      store: this.store,
      event: (surface, kind, target, detail) => {
        // `t` is absent where no element is meant, and a detail with no
        // field is no payload (SPEC §9).
        const c = new Control().set("a", "ev").set("s", surface).set("e", kind);
        if (target !== "") c.set("t", target);
        const fields = detail !== undefined && Object.values(detail).some((v) => v != null);
        this.send(encode(c, fields ? this.writer.body(detail!) : ""));
      },
      browserKey: (e) => this.browserKey(e),
      copyKey: (e) => this.copyKey(e),
      writeClipboard: (text) => void navigator.clipboard?.writeText(text).catch(() => {}),
      readClipboard: () => navigator.clipboard?.readText().catch(() => null) ?? Promise.resolve(null),
      pressed: (keep) => {
        if (keep !== null) this.term.clearSelection();
        for (const [name, s] of this.surfaces) if (name !== keep) s.clearSelection();
      },
      key: (e) => this.terminalKey(e),
      encodeKey: (e) => {
        // What xterm.js sends for the key, kept from the program: its
        // keyboard handling ends in the core service's triggerDataEvent,
        // which is private.
        const cs = (this.term as unknown as { _core?: { coreService?: DataSink } })._core?.coreService;
        if (typeof cs?.triggerDataEvent !== "function") return null;
        let data = "";
        const own = Object.prototype.hasOwnProperty.call(cs, "triggerDataEvent");
        const prev = cs.triggerDataEvent;
        cs.triggerDataEvent = (d: string) => void (data += d);
        this.encoding = true;
        try {
          this.terminalKey(e);
        } finally {
          this.encoding = false;
          if (own) cs.triggerDataEvent = prev;
          else delete (cs as { triggerDataEvent?: unknown }).triggerDataEvent;
        }
        return data;
      },
      keys: this.keys,
      command: (e) => this.command(e),
      typed: (e) => this.menuKey(e),
      sendKey: (data) => {
        const cs = (this.term as unknown as { _core: { coreService: DataSink } })._core.coreService;
        this.throughTerminal(() => cs.triggerDataEvent(data, true));
      },
      focusTerminal: () => {
        if (this.forwarding) this.focusAfter = true;
        else this.term.focus();
      },
      clicked: (name) => {
        for (const [n, s] of this.surfaces) if (n !== name) s.dropWait(true);
      },
      policy: this.policy,
      pageScrolls: this.pageScrolls,
      scrollPage: (dx, dy) => this.scrollPage(dx, dy),
      wheelGesture: (surface, decide) => {
        const now = performance.now();
        const g = this.gesture;
        const same = g !== null && now - g.at < GESTURE_MS && (g.surface === surface || g.route === "terminal");
        const route = same ? g.route : decide();
        this.gesture = { surface, route, at: now };
        return route;
      },
      // A hyperlink (SPEC §9) goes where xterm.js sends an OSC 8 one: the
      // terminal's linkHandler, or its confirm-then-open default, and only
      // for http and https unless the handler allows other schemes.
      // The platform counts clicks (MouseEvent.detail), by the user's own
      // settings; a run is kept to one element of one surface (SPEC §9).
      clickCount: (surface, el, detail) => {
        if (detail < 1) {
          this.clickRun = null;
          return 1;
        }
        const r = this.clickRun;
        if (detail === 1 || !r || r.surface !== surface || r.el !== el) this.clickRun = { surface, el, base: detail };
        return detail - this.clickRun!.base + 1;
      },
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

  /**
   * A key through xterm.js's own keyboard handling, so it is encoded the
   * way the program asked: DECCKM, modifyOtherKeys, the kitty keyboard
   * protocol. A printable key xterm.js leaves to keypress (legacy input)
   * gets one.
   */
  private terminalKey(e: KeyboardEvent) {
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
    this.throughTerminal(() => {
      const ev = new KeyboardEvent(e.type, init);
      ta.dispatchEvent(ev);
      if (e.type === "keydown" && !ev.defaultPrevented && [...e.key].length === 1) {
        const c = e.key.codePointAt(0)!;
        ta.dispatchEvent(new KeyboardEvent("keypress", { ...init, charCode: c, keyCode: c, which: c }));
      }
    });
  }

  /** Something a surface sends through the terminal (a key, or what one
   * stands for). xterm.js focuses the terminal on every keyup; the surface
   * keeps the keyboard, so its focus does nothing meanwhile, and a surface
   * the program blurs meanwhile gives the keyboard back once it is
   * through. */
  private throughTerminal(fn: () => void) {
    const ta = this.term.textarea;
    if (ta) Object.defineProperty(ta, "focus", { value: () => {}, configurable: true });
    this.forwarding = true;
    try {
      fn();
    } finally {
      if (ta) delete (ta as { focus?: unknown }).focus;
      this.forwarding = false;
      if (this.focusAfter) {
        this.focusAfter = false;
        this.term.focus();
      }
    }
  }

  private cellTouch: Touch | null = null;
  private pageScrollBound = false;

  /** Whether the page scrolls, not the terminal (the `scroll` option). */
  private get pageScrolls(): boolean {
    return this.opts.scroll === "page";
  }

  /**
   * Wheels and touches on the cells left to the browser, which scrolls the
   * page (`scroll: "page"`): they stop at the terminal's element, before
   * xterm.js, which would take them for its scrollback, or turn a drag into
   * arrow keys, and cancel the browser's scroll. Nothing here cancels it.
   */
  private bindPageScroll(el: HTMLElement) {
    if (this.pageScrollBound) return;
    this.pageScrollBound = true;
    const stop = (e: Event) => e.stopPropagation();
    for (const type of ["wheel", "touchstart", "touchmove", "touchend", "touchcancel"]) {
      el.addEventListener(type, stop, { capture: true, passive: true });
      this.disposables.push({ dispose: () => el.removeEventListener(type, stop, { capture: true }) });
    }
  }

  /** Scrolls what scrolls the terminal's page: its nearest ancestor that
   * scrolls, or the document. */
  private scrollPage(dx: number, dy: number) {
    let el = this.term.element?.parentElement ?? null;
    for (; el; el = el.parentElement) {
      const o = getComputedStyle(el).overflowY;
      if (/auto|scroll/.test(o) && el.scrollHeight > el.clientHeight) break;
    }
    (el ?? document.scrollingElement ?? document.documentElement).scrollBy(dx, dy);
  }

  private cellWheelBound = false;

  /** A wheel over the cells begins or goes on with a gesture of the
   * terminal's: a document that scrolls under the pointer as the terminal
   * scrolls takes none of it (`wheelGesture`). */
  private bindCellWheel(el: HTMLElement) {
    if (this.cellWheelBound) return;
    this.cellWheelBound = true;
    const wheel = (e: Event) => {
      if (e.isTrusted) this.gesture = { surface: "", route: "terminal", at: performance.now() };
    };
    el.addEventListener("wheel", wheel, { capture: true, passive: true });
    this.disposables.push({ dispose: () => el.removeEventListener("wheel", wheel, { capture: true }) });
  }

  /** Touch on the cells (the `touch` option), once the terminal is open. */
  private bindTouch() {
    const el = this.term.element;
    if (el && this.pageScrolls) return this.bindPageScroll(el);
    if (el) this.bindCellWheel(el);
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
        claim: (dx, dy, e, begin) => this.claimCells(dx, dy, e, begin),
        dragMove: (x, y, e) => this.fingerMouse("move", x, y, e),
        dragEnd: (x, y, e) => this.fingerMouse("up", x, y, e),
        dragCancel: () => {
          const f = this.finger;
          if (f) this.fingerMouse("up", f.x, f.y, f.keys);
        },
      },
      true,
    );
  }

  /** Where the finger of a drag that is the program's mouse (SPEC §9.6)
   * last was, in the page, with the keys held then. */
  private finger: { x: number; y: number; keys: Keys } | null = null;

  /**
   * A touch on the cells that has just gone past the slop, by dx, dy so far
   * (SPEC §9.6). One that began in an area the program named, without Alt
   * and not held as a long press, whose first move goes a way the area
   * drags, is the mouse's primary button: pressed on the cell where it
   * began, then moved to the finger's cell if that is another. Every other
   * touch scrolls, as on any cell.
   */
  private claimCells(dx: number, dy: number, e: TouchEvent, begin: TouchBegin): true | "drag" {
    if (begin.altKey || e.timeStamp - begin.time >= LONG_PRESS_MS) return true;
    const area = this.areaUnder(begin.x, begin.y);
    if (!area || !areaDrags(area, dx, dy)) return true;
    // The cells' Touch measures in the page: the finger is dx, dy back
    // from where it began.
    const [x, y] = [begin.x - dx, begin.y - dy];
    this.fingerMouse("down", begin.x, begin.y, { ...keysOf(e), altKey: false });
    const [c0, r0] = this.screenCell(begin.x, begin.y, true);
    const [c, r] = this.screenCell(x, y, true);
    if (c !== c0 || r !== r0) this.fingerMouse("move", x, y, e);
    return "drag";
  }

  /**
   * The area the program named (SPEC §9.6) under a point in the page, where
   * one applies: while the program has xterm.js report the mouse's buttons
   * (without Alt: `mouseEventsRequireAlt` leaves a finger nothing), and the
   * terminal shows the screen, not its scrollback.
   */
  private areaUnder(x: number, y: number): TouchArea | null {
    const t = this.term;
    const buf = t.buffer.active;
    if (t.modes.mouseTrackingMode === "none" || t.options.mouseEventsRequireAlt || buf.viewportY !== buf.baseY) return null;
    const [col, row] = this.screenCell(x, y, false);
    if (col < 0 || row < 0 || col >= t.cols || row >= t.rows) return null;
    return areaAt(this.touchAreas[buf.type], col, row);
  }

  /** The cell of the screen at a point in the page, from 0 at its top
   * left; `clamp`ed onto the screen as xterm.js reports a mouse past its
   * edge. */
  private screenCell(x: number, y: number, clamp: boolean): [number, number] {
    const screen = this.term.element?.querySelector(".xterm-screen")?.getBoundingClientRect();
    const { cellW, cellH } = this.cell();
    const col = Math.floor((x - (screen?.left ?? 0)) / cellW);
    const row = Math.floor((y - (screen?.top ?? 0)) / cellH);
    if (!clamp) return [col, row];
    return [Math.min(Math.max(col, 0), this.term.cols - 1), Math.min(Math.max(row, 0), this.term.rows - 1)];
  }

  /**
   * The finger of a drag in an area (SPEC §9.6) as the mouse's primary
   * button, pressed, moved or released at a point in the page: replayed on
   * the cells (`pressCells`), so that xterm.js reports it as a mouse's, in
   * the program's mode and encoding, with the keys held. Never with Shift,
   * which on a press makes xterm.js select instead of reporting (but on a
   * Mac), and nothing is selected.
   */
  private fingerMouse(kind: "down" | "move" | "up", x: number, y: number, keys: Keys) {
    const held = { altKey: keys.altKey, ctrlKey: keys.ctrlKey, metaKey: keys.metaKey, shiftKey: false };
    this.finger = kind === "up" ? null : { x, y, keys: held };
    this.pressCells(kind, { ...held, screenX: 0, screenY: 0, buttons: kind === "up" ? 0 : 1, detail: kind === "move" ? 0 : 1 }, x, y);
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
   * release (SPEC §9.2), or a finger's as the mouse (§9.6, `fingerMouse`),
   * replayed on the cells beneath, where xterm.js handles them as its own
   * mouse: a report to the program, with Alt, or its selection
   * (rectangular, with Alt). The press goes to the screen, where xterm.js
   * listens for presses; the moves and the release to its
   * document, where it listens while a button is held. The keyboard goes
   * back to the terminal first, as on a click on the cells (§10.1): a
   * surface that had it sends `blur`.
   */
  private pressCells(kind: "down" | "move" | "up", e: MouseLike, x: number, y: number) {
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
    this.watch();
    return layer;
  }

  /** Binds the terminal's element. A press on the cells drops a surface's
   * selection: there is one (SPEC §11). A press in a surface stays in its
   * frame. Focus coming into the element moves an `a=focus` that waits. */
  private watch() {
    const el = this.term.element;
    if (!el || this.pressed === el) return;
    this.unwatch();
    el.addEventListener("mousedown", this.cellsPressed, true);
    el.addEventListener("focusin", this.focusIn, true);
    this.pressed = el;
  }

  private unwatch() {
    this.pressed?.removeEventListener("mousedown", this.cellsPressed, true);
    this.pressed?.removeEventListener("focusin", this.focusIn, true);
    this.pressed = null;
  }

  /** Whether the page's focus is in the terminal, or nowhere: where
   * `a=focus` may move it. */
  private focusInside(): boolean {
    const el = this.term.element;
    if (!el) return true;
    const doc = el.ownerDocument;
    let a = doc.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return !a || a === doc.body || a === doc.documentElement || el.contains(a);
  }

  // --- Commands in the cells and the menu (SPEC §10.6) -----------------

  /** The paste a `paste` command's key brings (SPEC §10.6), heard before
   * xterm.js's own on its textarea: its text goes with the command, and
   * xterm.js pastes nothing. */
  private bindPaste() {
    const el = this.term.element;
    if (!el || this.pasteOn === el) return;
    this.pasteOn?.removeEventListener("paste", this.onPaste, true);
    el.addEventListener("paste", this.onPaste, true);
    this.pasteOn = el;
  }

  private readonly onPaste = (e: ClipboardEvent) => {
    const p = this.pasting;
    if (!p) return;
    this.pasting = null;
    clearTimeout(p.timer);
    e.preventDefault();
    e.stopImmediatePropagation();
    this.sendCommand("paste", p.key, e.clipboardData?.getData("text/plain") ?? "");
  };

  /**
   * A key of an edit command the program on the active screen takes (SPEC
   * §10.6), named as pressed: the command goes to the program, in place of
   * the key's bytes. A `paste` brings the clipboard's text, from the
   * browser's paste where the key makes one, or else read.
   */
  private command(e: KeyboardEvent): boolean {
    const taken = this.taken[this.term.buffer.active.type];
    if (taken.size === 0) return false;
    // A press has two names, looked up physical first (§10.4). The command
    // carries the one its bytes would have, the character's where it has
    // one: `ctrl+c`, never `ctrl+key_c` (§10.6).
    const names = pressNames(e);
    let name: string | null = null;
    for (const key of names) {
      name = editAction(this.keys.platform, key);
      if (name !== null) break;
    }
    const k = names[names.length - 1] ?? "";
    if (name === null || !taken.has(name)) return false;
    this.commandCodes.add(e.code);
    if (name !== "paste") {
      e.preventDefault();
      this.sendCommand(name, k);
      return true;
    }
    if (this.pasting) clearTimeout(this.pasting.timer);
    // A key the user typed on the cells pastes, as the browser's default
    // action; one a surface gave on, or a browser that makes no paste of
    // it, has the clipboard read.
    const read = () => {
      this.pasting = null;
      void (navigator.clipboard?.readText().catch(() => "") ?? Promise.resolve("")).then((text) => this.sendCommand("paste", k, text));
    };
    if (!e.isTrusted || this.forwarding) {
      e.preventDefault();
      read();
    } else this.pasting = { key: k, timer: setTimeout(read, 0) };
    return true;
  }

  /** The event `command` (SPEC §10.6): of no surface and no element, with
   * the key that made it where one did. A paste's text is left out where
   * the clipboard holds none. */
  private sendCommand(name: string, key?: string, text?: string) {
    const c = new Control().set("a", "ev").set("e", "command");
    this.send(encode(c, this.writer.body({ name, key, text: text || undefined })));
  }

  // --- The program's menu (SPEC §10.7) --------------------------------------

  /** A key's name as this host reads it (`mod` read), or null. */
  private readonly read = (k: string) => readKey(this.keys.platform, k);
  /** A key as the menu shows it (myelin key names §6): read, with arrows
   * and Tab as symbols. */
  private readonly show = (k: string) => displayKey(this.read(k) ?? k);

  /** The program's menu on the active screen. */
  private menu(): Menu | null {
    return this.menus.get(this.term.buffer.active.type);
  }

  /** The level shown: the keyed items of the level `shownSeq` reaches. */
  private level() {
    const m = this.menu();
    return m && this.shownSeq ? shownLevel(m, this.shownSeq, this.read) : null;
  }

  /**
   * The keyed items of the level shown, as the program sent them, or null
   * when none shows: what the conformance vectors' `menu: shown` checks.
   */
  shownMenu(): { key: string; label: string; group: boolean; enabled: boolean }[] | null {
    const l = this.level();
    return l ? l.items.map((i) => ({ key: i.key, label: i.label, group: isGroup(i), enabled: i.enabled })) : null;
  }

  /**
   * The items of the active screen's menu that have a name (SPEC §10.7), in
   * its order, for a page that lists them in a command palette of its own:
   * each under its groups' labels, with the keys that reach it, `mod` read
   * as the platform does, in myelin key names (a page shows them with
   * `displayKey`, §6). The addon draws no palette; `pick` runs an item.
   */
  menuItems(): MenuEntry[] {
    const m = this.menu();
    return m ? entries(m, (k) => this.read(k) ?? k) : [];
  }

  /**
   * Picks the item the active screen's menu names `name` (SPEC §10.7), for
   * a page's own command palette: `command` goes to the program with just
   * the name. A `copy` while the terminal has text selected copies it
   * instead, and a `paste` brings the clipboard's text, as the terminal's
   * Edit menu does. Returns whether anything was picked: not a disabled
   * item, a name no item has, or no menu.
   */
  pick(name: string): boolean {
    const m = this.menu();
    const item = m && find(m, name);
    if (!item?.enabled) return false;
    if (name === "copy" && this.term.hasSelection()) {
      navigator.clipboard?.writeText(this.term.getSelection()).catch(() => {});
    } else if (name === "paste") {
      void (navigator.clipboard?.readText().catch(() => "") ?? Promise.resolve("")).then((text) => this.sendCommand("paste", undefined, text));
    } else this.sendCommand(name);
    return true;
  }

  /** A key typed on the cells or in a surface while a level of the
   * program's menu shows (SPEC §10.7): Escape, and a key the level does not
   * list, hide it. The key still goes where it would without the menu. */
  private menuKey(e: KeyboardEvent) {
    const keys = pressNames(e);
    if (this.shownSeq === null || keys.length === 0) return;
    // A level that shows nothing lists no key: any key hides it.
    if (!hides(this.level()?.items ?? [], keys, this.read)) return;
    this.shownSeq = null;
    this.drawMenu();
  }

  /**
   * Draws the level of the program's menu shown (SPEC §10.7) at the bottom
   * right of the screen, on cells, over the surfaces too. A title row, the
   * keys typed and their group's label, then each key that can follow with
   * what it does, in columns of at most `COLUMN_ITEMS`. A group's label has
   * a `+`, and a disabled item is dimmed.
   */
  private drawMenu() {
    const m = this.level();
    if (!m) {
      this.menuEl?.remove();
      this.menuEl = null;
      return;
    }
    let layer: HTMLDivElement;
    try {
      layer = this.ensureLayer();
    } catch {
      return; // not open yet
    }
    const { cellW, cellH } = this.cell();
    const o = this.term.options;
    const p = palette(o.theme);
    const accent = p.ansi[p.dark ? 12 : 4]!;
    const el = (this.menuEl ??= document.createElement("div"));
    el.className = "hotty-menu";
    el.replaceChildren();
    Object.assign(el.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "",
      height: "",
      boxSizing: "border-box",
      padding: `0 ${cellW}px`,
      background: boxBackground(p),
      color: p.fg,
      fontFamily: o.fontFamily ?? "monospace",
      fontSize: `${o.fontSize ?? 15}px`,
      lineHeight: `${cellH}px`,
      whiteSpace: "pre",
      zIndex: "7",
      pointerEvents: "none",
    });
    const span = (text: string, style: Partial<CSSStyleDeclaration>) => {
      const s = document.createElement("span");
      s.textContent = text;
      Object.assign(s.style, style);
      return s;
    };
    const title = document.createElement("div");
    title.append(span(this.shownSeq!.map(this.show).join(" "), { color: accent }));
    if (m.label) title.append(" " + m.label);
    const cols = document.createElement("div");
    Object.assign(cols.style, { display: "flex", gap: `${2 * cellW}px` });
    const per = Math.max(1, Math.ceil(m.items.length / Math.max(1, Math.ceil(m.items.length / COLUMN_ITEMS))));
    for (let i = 0; i < m.items.length; i += per) {
      const col = document.createElement("div");
      for (const item of m.items.slice(i, i + per)) {
        const group = isGroup(item);
        let label = group && !item.label.startsWith("+") ? `+${item.label}` : item.label;
        const chars = [...label];
        if (chars.length > LABEL_CHARS) label = chars.slice(0, LABEL_CHARS - 1).join("") + "…";
        const row = document.createElement("div");
        row.style.height = `${cellH}px`;
        if (!item.enabled) row.style.opacity = "0.5";
        else if (group) row.style.color = p.ansi[5]!;
        row.append(span(this.show(item.key), { color: accent, fontWeight: "bold" }), " " + label);
        col.append(row);
      }
      cols.append(col);
    }
    el.append(title, cols);
    if (el.parentElement !== layer) layer.append(el);
    // On whole cells, in the bottom right corner of the screen.
    const w = Math.min(this.term.cols, Math.ceil(el.offsetWidth / cellW));
    const h = Math.min(this.term.rows, Math.ceil(el.offsetHeight / cellH));
    Object.assign(el.style, {
      width: `${w * cellW}px`,
      height: `${h * cellH}px`,
      left: `${(this.term.cols - w) * cellW}px`,
      top: `${(this.term.rows - h) * cellH}px`,
      overflow: "hidden",
    });
  }

  private browserKey(e: KeyboardEvent): boolean {
    return (this.opts.browserKeys ?? browserKeys)(e);
  }

  /** A copy key while something is selected (SPEC §11): the selection goes
   * to the clipboard, and the key no further, the browser's copy included.
   * A selection in a surface's document is copied by its keymap, which may
   * leave the key to the program; one on the cells by `copyKeys`. A focused
   * text field's selection is the field's keymap's (Surface.fieldKey). */
  private copyKey(e: KeyboardEvent): boolean {
    const surfaces = [...this.surfaces.values()].sort((a, b) => Number(b.hasKeyboard()) - Number(a.hasKeyboard()));
    for (const s of surfaces) {
      const got = s.selectionCopy(e);
      if (got === null) continue;
      if (got === false) return false;
      return this.copied(e, got);
    }
    if (!(this.opts.copyKeys ?? copyKeys)(e) || !this.term.hasSelection()) return false;
    return this.copied(e, this.term.getSelection());
  }

  /** `text` goes to the clipboard, and the key `e` no further. */
  private copied(e: KeyboardEvent, text: string): true {
    e.preventDefault();
    if (e.type === "keydown") navigator.clipboard?.writeText(text).catch(() => {});
    return true;
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
    this.css = hostCss(o.theme, { cellW, cellH, px: this.px(), fontFamily: o.fontFamily ?? "monospace", fontSize: o.fontSize ?? 15 });
    return this.css;
  }

  /** One device pixel in CSS pixels (`--hotty-px`, SPEC §8), the opposite of
   * `scale`. */
  private px(): number {
    return 1 / (window.devicePixelRatio || 1);
  }

  private scheme(): Scheme {
    return palette(this.term.options.theme).dark ? "dark" : "light";
  }

  /** On every render: did the cell size, font, theme or pixel density
   * change? A new pixel density (a zoom) changes `--hotty-px` and draws the
   * surfaces again, and tells the program nothing (SPEC §5.3). */
  private checkMetrics() {
    const { cellW, cellH } = this.cell();
    const o = this.term.options;
    const key = `${cellW}x${cellH}|${this.px()}|${this.font()}|${JSON.stringify(o.theme ?? {})}`;
    if (key === this.metrics.key) return;
    const first = this.metrics.cellW === 0;
    this.metrics = { cellW, cellH, key };
    if (first) this.told = { cellW, cellH, font: this.font() };
    else this.settle();
    if (this.surfaces.size === 0) return;
    const css = this.hostCss();
    const scheme = this.scheme();
    for (const s of this.surfaces.values()) s.setHostCss(css, scheme);
    this.reposition();
  }

  /** What sets the cell's size, besides the pixel density. */
  private font(): string {
    const o = this.term.options;
    return `${o.fontFamily}|${o.fontSize}|${o.lineHeight}|${o.letterSpacing}`;
  }

  /** The capabilities the program hears: it asked for them with its query,
   * and answers differ from them in `caps` (SPEC §4). */
  private hear(caps: Body): Body {
    const { cellW, cellH } = this.cell();
    this.heard = caps;
    this.told = { cellW, cellH, font: this.font() };
    return caps;
  }

  /** Once the cell, font and theme settle, the program hears what changed.
   * xterm.js may take a font and its cell in two renders, so this waits for
   * both. */
  private settle() {
    if (this.capsTimer) clearTimeout(this.capsTimer);
    this.capsTimer = setTimeout(() => {
      this.capsTimer = null;
      this.tellCaps();
    }, 100);
  }

  /**
   * Sends `caps` (SPEC §4, §9) with every field that differs from what the
   * program last heard, to a program that asked for the capabilities. A
   * zoom changes `scale` alone and sends nothing, and moves the cell only by
   * device pixel rounding, with the font kept: that is not a new `cellcss`.
   */
  private tellCaps() {
    const { cellW, cellH } = this.cell();
    const font = this.font();
    const t = this.told;
    const owed = (font !== t.font && (cellW !== t.cellW || cellH !== t.cellH)) || Math.abs(cellW - t.cellW) > 1 || Math.abs(cellH - t.cellH) > 1;
    if (owed) this.told = { cellW, cellH, font };
    const heard = this.heard;
    if (!heard) return;
    const now = this.capabilities(String(heard.v));
    const same = (a: unknown, b: unknown) => JSON.stringify(a, plain) === JSON.stringify(b, plain);
    const changed: Record<string, Value> = {};
    for (const [k, v] of Object.entries(now)) {
      if (v == null || (k === "cellcss" && !owed) || same(v, heard[k])) continue;
      changed[k] = v;
    }
    if (Object.keys(changed).every((k) => k === "scale")) return;
    this.heard = { ...heard, ...changed };
    this.send(encode(new Control().set("a", "ev").set("e", "caps"), this.writer.body(changed)));
  }
}

/** A body's value as JSON would show it, a `Float` by its value. */
const plain = (_: string, x: unknown) => (x instanceof Float ? { float: x.value } : x);

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
 * WebKit), before `deltaX`/`deltaY`. A real wheel's own values are kept. On
 * a constructed event (a touch drag's) they are the browser's guess: 0 in
 * some versions, in Chromium 15x the delta itself, with the sign of a wheel
 * the other way, so the drag scrolled backwards. Its values are worked out
 * here instead, so that the scrollback moves as far as the finger, and the
 * way it moves: the scrollable moves 50 pixels per 120 of wheelDelta.
 */
function legacyWheelDelta(ev: WheelEvent, from: WheelEvent) {
  if (!("wheelDeltaY" in WheelEvent.prototype)) return; // Firefox reads deltaY
  const legacy = from as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number };
  const real = from.isTrusted;
  const pixels = from.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 : from.deltaMode === WheelEvent.DOM_DELTA_LINE ? 20 : 400;
  const x = (real && legacy.wheelDeltaX) || -from.deltaX * pixels * (120 / 50);
  const y = (real && legacy.wheelDeltaY) || -from.deltaY * pixels * (120 / 50);
  Object.defineProperty(ev, "wheelDeltaX", { value: x });
  Object.defineProperty(ev, "wheelDeltaY", { value: y });
}
