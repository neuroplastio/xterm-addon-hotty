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

import type { IDisposable, IMarker, ITerminalAddon, Terminal } from "@xterm/xterm";
import { hostCss, palette } from "./hostcss.ts";
import { OPS, PatchError } from "./patch.ts";
import { clean, type Policy } from "./network.ts";
import { Store } from "./resources.ts";
import { Surface, type SurfaceHost } from "./surface.ts";
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
   * Opens a link the user asked to open (a middle click, a Ctrl, Cmd or
   * Shift click; SPEC §9). Return false if it was not opened. Default: a new
   * tab, without an opener or a referrer.
   */
  openLink?: (url: string) => boolean | void;
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

export const EVENTS = ["click", "change", "input", "submit", "focus", "blur", "resize"];

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

  constructor(options: HottyOptions = {}) {
    this.opts = { maxSurfaces: 64, resourceQuota: 64 << 20, ...options };
    this.policy = clean(options.network);
    this.store = new Store(this.opts.resourceQuota);
    this.store.onChange = (names) => {
      for (const s of this.surfaces.values()) s.resolver.refresh(names);
    };
  }

  activate(term: Terminal): void {
    this.term = term;
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
      term.onRender(() => this.checkMetrics()),
      term.onResize(() => this.checkMetrics()),
      term.onScroll(() => this.reposition()),
      term.onWriteParsed(() => this.reposition()),
    );
  }

  dispose(): void {
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
          s = new Surface(name, this.host(), this.hostCss());
          this.surfaces.set(name, s);
        }
        s.setDocument(text(cmd.payload));
        return;
      }
      case "place":
        return this.place(this.existing(c), c);
      case "patch": {
        const s = this.existing(c);
        s.patcher.apply(c.get("op") ?? "morph", c.get("t"), c.get("k"), text(cmd.payload));
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
      case "focus": {
        const s = this.existing(c);
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
      scheme: palette(this.term.options.theme).dark ? "dark" : "light",
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
    s.autoRows = auto;
    s.setSize(cols, rows, cellW, cellH);
    this.unplace(s.name);

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

    if (c.get("C") !== "1") this.moveCursorBelow(rows);
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
    if (row + s.rows <= 0 || row >= this.term.rows) {
      s.hide();
      return;
    }
    s.setSize(s.cols, s.rows, cellW, cellH);
    s.show(Math.round(p.col * cellW), row * cellH);
  }

  private unplace(name: string) {
    const p = this.placements.get(name);
    if (!p) return;
    this.placements.delete(name);
    for (const d of p.disposables) d.dispose();
    p.marker?.dispose();
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
      input: (bytes) => this.send(bytes),
      focusTerminal: () => this.term.focus(),
      policy: this.policy,
      openLink: (url) => {
        if (this.opts.openLink) return this.opts.openLink(url) !== false;
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
      },
      // Replayed on the terminal's screen, where xterm handles it as its own:
      // scrollback, or mouse reports and arrow keys on the alternate screen.
      wheel: (e, x, y) => {
        this.term.element?.querySelector(".xterm-screen")?.dispatchEvent(
          new WheelEvent("wheel", {
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
          }),
        );
      },
      applicationCursor: () => this.term.modes.applicationCursorKeysMode,
    };
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
    for (const s of this.surfaces.values()) s.setHostCss(css);
    this.reposition();
    if (sizeChanged) {
      // Re-rendered with no program involvement; tell the program the new size.
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        for (const p of this.placements.values()) {
          const s = p.surface;
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
