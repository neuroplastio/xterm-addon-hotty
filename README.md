# xterm-addon-hotty: HOTTY for xterm.js

A [HOTTY](https://github.com/neuroplastio/hotty) host as an addon for
xterm.js, where the **browser is the engine**. Every surface is a real
document in a sandboxed iframe. It shares no code with hotty-blitz, the
other implementation, and passes the same conformance vectors. The HOTTY
repository's example programs run unchanged in a browser tab.

```ts
import { Terminal } from "@xterm/xterm";
import { HottyAddon } from "xterm-addon-hotty";

const term = new Terminal({
  // Optional: key releases for programs that need them (games), SPEC §10.3.
  vtExtensions: { kittyKeyboard: true },
});
term.loadAddon(new HottyAddon());
term.open(element);
// term.onData → your pty, as usual: replies and events travel that way too.
```

## Try it

Clone [neuroplastio/hotty](https://github.com/neuroplastio/hotty) next to
this repository (or set `HOTTY_DIR`), then:

```
npm ci && npm run build
python3 serve.py --examples      # /?run=card, /?run=dash, /?run=form, /?run=grid, /?run=bubbros
python3 serve.py -- python3 ../hotty/examples/dash.py   # any program, at /
```

`serve.py` is the test bridge: an HTTP server for `dist/` and a WebSocket to a
pty. It uses the standard library only, and listens on 127.0.0.1 because it
runs programs for whoever connects.

## How it works

| piece | file | what it does |
| --- | --- | --- |
| wire | `src/wire.ts` | OSC 7279 control parsing, chunk reassembly, base64, zlib through `DecompressionStream`, and reply encoding |
| addon | `src/addon.ts` | OSC handler, replies through `term.input(…, false)`, placement, synchronized output, RIS, the alternate screen, zoom and theme |
| surface | `src/surface.ts` | one sandboxed iframe per surface; events, focus and key routing |
| patches | `src/patch.ts` | SPEC §6: the ops and morph |
| resources | `src/resources.ts`, `src/resolver.ts` | `cid:` as `blob:` URLs; sanitizing everything before it reaches a live document |
| host stylesheet | `src/hostcss.ts` | §7 from `term.options` (theme, font, cell size), in a cascade layer |
| keys | `src/keys.ts` | keys a surface does not use, encoded as terminal input |

- **Placement.** On the normal buffer a surface hangs from a marker, which is
  public API (decorations need `allowProposedApi`). It scrolls with the text,
  stays visible while any of its rows is, and dies when its line leaves the
  scrollback. On the alternate buffer, where markers do not work, it sits on
  fixed cells and dies with the screen. The iframe never
  moves in the DOM, since that would reload it; only its box moves.
- **Cursor.** After `a=place` the cursor moves below the surface, as in the
  native host. xterm.js has no public API for that, so the addon uses the same
  private calls as the official image addon.
- **Cell size** comes from xterm's render service (also private), with a
  measured fallback.
- **xterm.js 6.1** is needed for the kitty keyboard protocol
  (`vtExtensions.kittyKeyboard`); the addon itself works with 6.0.

## Security

Program markup is untrusted: it may come from `cat`, or from a server on the
far side of SSH. Two independent layers stand between it and the page, and a
test checks each one (`tests/e2e/hostile.spec.ts`):

1. **The sanitizer** (`resolver.ts`) works on inert parses. It removes
   `script`, `iframe`, `object`, `embed`, `base`, `meta` and any `link` that
   is not a stylesheet. It also removes `on*`, `srcdoc`, `autofocus` and
   `ping`. URL attributes resolve to `blob:` for `cid:`, stay as they are for
   `data:`, and fail closed as `about:invalid` for everything else.
2. **The iframe:**
   - `sandbox="allow-same-origin allow-forms"`: no scripts, popups or
     navigation. `allow-forms` is there only so that `submit` fires; the
     submission is cancelled.
   - A CSP `<meta>` written by the parser before any program markup:
     `default-src 'none'`, with `data:` and `blob:` allowed for images,
     media and fonts, inline styles allowed, and `form-action 'none'`.

With the CSP removed, 9 requests get through, all from CSS (`@import`, `url()`
and `@font-face`). With the sanitizer passing URLs through, the CSP alone
stops everything. `position: fixed` stays inside the surface's own viewport.

**The embedding page's CSP applies inside the surfaces too** (about:blank
iframes inherit it, and it can only be narrowed). A page that embeds xterm.js
already has to allow inline styles, because xterm's DOM renderer sets them.
For HOTTY it must also allow `data:` and `blob:` images, fonts and media. This
is the recommended policy, and `tests/e2e/embedder.spec.ts` checks it:

```
default-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:
```

## Differences from hotty-blitz

- **Pixels differ.** The browser renders, so text, form controls and
  antialiasing look like the browser's. The cell footprint is the same (§9).
- **More events.** The browser gives `resize` (after zoom or a font change) and
  native `<select>`, IME and spellcheck.
- **Not here yet:**
  - §9's text in xterm's buffer (search, serialize, and a selection across a
    surface);
  - following content that scrolls on the alternate screen;
  - the embedder's web fonts inside surfaces (system fonts work).

## Costs

Measured 2026-09-29 in headless Chromium 153 (`bench/`):

- **A surface** takes 4.7 ms to create and place, 8.7 ms of main-thread time
  with its first frame, and 1.2 MB of memory.
- **The dashboard** costs 4.9 ms of main-thread time per frame at 10 Hz.
- **Large documents** cost Chrome more per frame as they grow: its PrePaint
  walks the tree. A one-cell patch costs 8.4 ms of main-thread time per frame
  at 4,096 cells and 46 ms at 262,144. CSS containment brings the latter to
  30 ms; hotty-blitz does it in about 0.1 ms.
- **Bub-n-Bros** (`examples/bubbros.py`) costs about 4 ms per frame: seven
  sprites patched out of about 380.

## Tests

`npm run check` runs:

- the typecheck and the build;
- the unit tests (`node --test`: the wire, keys, decoding the reference Python
  client, and the conformance vectors' wire section);
- the Playwright tests, against Chromium (and Firefox once installed:
  `npx playwright install firefox`):
  - the protocol and the conformance vectors;
  - interaction, with `form.py` through the bridge;
  - the hostile page and the embedder's CSP;
  - Bub-n-Bros with kitty keys (skipped unless the game is fetched).

`bench/measure.mjs` and `bench/trace.mjs` produce the cost numbers.

## Licence

Apache-2.0 ([LICENSE](LICENSE)). xterm.js itself is MIT.
