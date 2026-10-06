// Touch, for a terminal with surfaces in it (SPEC §9): a drag scrolls, as a
// wheel does, and keeps going after the finger lifts; a tap and a long press
// stay where they land. A Touch listens on one document or element and turns
// its drags into wheel events at the finger, for the terminal. On the cells it
// also turns a tap into a click.

/** How far a touch moves, in CSS pixels, before it is a drag, not a tap. */
const DRAG_SLOP = 8;
/** A fling's speed is multiplied by this every millisecond. */
const FLING_DECAY = 0.996;
/** A finger that rested this long before lifting does not fling. */
const REST_MS = 80;

export interface TouchHost {
  /** Scroll by dx, dy pixels, at a point in the page (a wheel event for the
   *  terminal). */
  scroll(dx: number, dy: number, pageX: number, pageY: number): void;
  /** A tap at a point in the page, for a Touch that owns taps too. */
  tap?(pageX: number, pageY: number): void;
  /** The listened-to document's point in the page (an iframe's offset). */
  toPage(x: number, y: number): [number, number];
  /** Whether a drag that has just begun, scrolling by dx, dy pixels so far,
   *  is this Touch's. One it declines is the browser's to its end. Absent:
   *  every drag is. */
  claim?(dx: number, dy: number, e: TouchEvent): boolean;
}

export class Touch {
  private touch: { id: number; x0: number; y0: number; x: number; y: number; t: number; t0: number; vx: number; vy: number; dragging: boolean } | null = null;
  private fling = 0;
  private readonly off: (() => void)[] = [];

  /**
   * `exclusive`: every touch here is this Touch's (the cells: xterm.js's own
   * touch handling, which listens on the document, never sees it). Otherwise
   * (a surface) a touch is left alone until it moves. `engage`, if given,
   * says on a touch's start whether it is this Touch's at all: one it
   * declines is the browser's, from start to end.
   */
  constructor(
    target: EventTarget,
    private readonly win: Window,
    private readonly host: TouchHost,
    private readonly exclusive = false,
    private readonly engage?: (e: TouchEvent) => boolean,
  ) {
    const on = (type: string, f: (e: TouchEvent) => void, passive: boolean) => {
      const l = (e: Event) => f(e as TouchEvent);
      target.addEventListener(type, l, { capture: true, passive });
      this.off.push(() => target.removeEventListener(type, l, { capture: true }));
    };
    on("touchstart", (e) => this.start(e), true);
    on("touchmove", (e) => this.move(e), false);
    on("touchend", (e) => this.end(e), !exclusive);
    on("touchcancel", (e) => {
      this.keep(e);
      this.touch = null;
    }, true);
  }

  dispose() {
    this.stopFling();
    for (const f of this.off) f();
  }

  private keep(e: TouchEvent) {
    if (this.exclusive) e.stopPropagation();
  }

  private start(e: TouchEvent) {
    this.keep(e);
    this.stopFling();
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    if (!t || (this.engage && !this.engage(e))) {
      this.touch = null;
      return;
    }
    const [x, y] = this.host.toPage(t.clientX, t.clientY);
    this.touch = { id: t.identifier, x0: x, y0: y, x, y, t: e.timeStamp, t0: e.timeStamp, vx: 0, vy: 0, dragging: false };
  }

  private move(e: TouchEvent) {
    this.keep(e);
    const s = this.touch;
    if (!s) return;
    if (e.touches.length !== 1) {
      this.touch = null; // two fingers: the browser's (a pinch)
      return;
    }
    const t = [...e.changedTouches].find((c) => c.identifier === s.id);
    if (!t) return;
    // In the page, not in the listened-to document: a surface moves as the
    // terminal scrolls, and the finger, in its own coordinates, with it.
    // Measured there, each step of the scroll would read as the finger
    // moving back, and scroll again.
    const [x, y] = this.host.toPage(t.clientX, t.clientY);
    if (!s.dragging && Math.hypot(x - s.x0, y - s.y0) < DRAG_SLOP) return;
    if (!s.dragging && this.host.claim && !this.host.claim(s.x0 - x, s.y0 - y, e)) {
      this.touch = null;
      return;
    }
    s.dragging = true;
    e.preventDefault();
    const dx = x - s.x;
    const dy = y - s.y;
    const dt = Math.max(1, e.timeStamp - s.t);
    s.vx = 0.7 * (dx / dt) + 0.3 * s.vx;
    s.vy = 0.7 * (dy / dt) + 0.3 * s.vy;
    s.x = x;
    s.y = y;
    s.t = e.timeStamp;
    this.host.scroll(-dx, -dy, x, y);
  }

  private end(e: TouchEvent) {
    this.keep(e);
    const s = this.touch;
    if (!s || ![...e.changedTouches].some((c) => c.identifier === s.id)) return;
    this.touch = null;
    if (s.dragging) {
      if (e.timeStamp - s.t < REST_MS) this.startFling(-s.vx, -s.vy, s.x, s.y);
      return;
    }
    if (this.host.tap && e.timeStamp - s.t0 < 500) {
      // The tap is the click: not the browser's own mouse events as well.
      e.preventDefault();
      this.host.tap(s.x, s.y);
    }
  }

  private startFling(vx: number, vy: number, x: number, y: number) {
    let last = this.win.performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const decay = Math.pow(FLING_DECAY, dt);
      vx *= decay;
      vy *= decay;
      if (Math.abs(vx) < 0.02 && Math.abs(vy) < 0.02) {
        this.fling = 0;
        return;
      }
      this.host.scroll(vx * dt, vy * dt, x, y);
      this.fling = this.win.requestAnimationFrame(step);
    };
    this.fling = this.win.requestAnimationFrame(step);
  }

  private stopFling() {
    if (this.fling) this.win.cancelAnimationFrame(this.fling);
    this.fling = 0;
  }
}
