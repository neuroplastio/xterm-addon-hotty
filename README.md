# xterm-addon-hotty: HOTTY for xterm.js

A [HOTTY](https://github.com/neuroplastio/hotty) host as an addon for
xterm.js, where the **browser is the engine**. Every surface is a real
document in a sandboxed iframe. It shares no code with hotty-blitz, the
other implementation, and passes the same conformance vectors. The HOTTY
repository's example programs run unchanged in a browser tab.

```
npm install @neuroplastio/xterm-addon-hotty @xterm/xterm
```

The package is an ES module with its TypeScript declarations, for xterm.js
6, and has no dependencies. A commit not yet released installs from git
(`github:neuroplastio/xterm-addon-hotty#<commit>`): npm builds it as it
installs it (`prepare`).

```ts
import { Terminal } from "@xterm/xterm";
import { HottyAddon } from "@neuroplastio/xterm-addon-hotty";

const term = new Terminal({
  // Optional: key releases for programs that need them (games), SPEC §10.3.
  vtExtensions: { kittyKeyboard: true },
});
term.loadAddon(new HottyAddon());
term.open(element);
// term.onData → your pty, as usual: replies and events travel that way too.
```

### Links and the network

A surface fetches nothing from the network unless the page grants it, and
the document asks for it (SPEC §7.2):

```ts
new HottyAddon({
  // The host's half of the network policy: directive → origins, or "https:".
  network: { "img-src": ["https://example.com"] },
});
```

- A document asks with `<meta name="hotty-network" content="img-src
  https://example.com">` and gets what both allow; its `<base href>` sets
  its base URL, so relative images and links resolve (§7.3). The capability
  reply reports the grant as `net`.
- **Links** show, hover and copy as the links they are. A click is a
  `click` event for the program, with `href` (the program's value) and
  `url` (resolved), whether the link has an `id` or not. The addon never
  opens one itself (§9). The context menu's own "open in new tab" and "copy
  link" work as on any page.
- **Hyperlinks**, links with `target="_blank"` and a `url`, are the
  terminal's, as OSC 8 links are (§9). One without a `url` (a relative
  `href` with no base, say) is the program's, as any other link. They go where xterm.js sends an OSC 8 link: the
  terminal's `linkHandler` (`activate`, `hover`, `leave`, with the link's
  cells as the range), or xterm.js's confirm-then-open default. Only
  `http` and `https` go through, unless the handler sets
  `allowNonHttpProtocols`. The program hears nothing of them.
- The page's own CSP must allow the granted origins too (below).

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
| addon | `src/addon.ts` | OSC handler, replies through `term.input(…, false)`, placement, synchronized output, RIS, the alternate screen, zoom and theme, and keys a surface does not use, through xterm.js's own keyboard handling |
| surface | `src/surface.ts` | one sandboxed iframe per surface; events, focus and key routing |
| keys | `src/keys.ts` | SPEC §10.2, §10.4: key names, the keys in what the terminal sends, keymaps (`data-keys`), and the actions on a field's text |
| deltas | `src/delta.ts` | SPEC §6: the ops and morph |
| resources | `src/resources.ts`, `src/resolver.ts` | `cid:` as `blob:` URLs; sanitizing everything before it reaches a live document |
| host stylesheet | `src/hostcss.ts` | §8 from `term.options` (theme, font, cell size), in a cascade layer: the palette, `--hotty-accent`, and controls, focus, links and selection in the terminal's colours |

- **Placement.** On the normal buffer a surface hangs from a marker, which is
  public API (decorations need `allowProposedApi`). It scrolls with the text,
  stays visible while any of its rows is, and dies when its line leaves the
  scrollback. On the alternate buffer, where markers do not work, it sits on
  fixed cells and dies with the screen. The iframe never
  moves in the DOM, since that would reload it; only its box moves.
- **Windows and hiding** (SPEC §5.2, §5.4). The iframe keeps the surface's
  whole size inside a box the size of the window, offset by the window's
  corner, so a new window moves the iframe and lays nothing out. A hidden
  surface's box is `display: none`: its document stays, and the browser
  skips its style, layout and paint until it is placed again.
- **A transparent document shows the cells beneath it.** The frame's
  colour scheme is the document's (the theme's, as the host stylesheet
  declares it): were they to differ, the browser would paint the frame an
  opaque canvas.
- **Stacking** (SPEC §5.2). A placement's `z` is its box's `z-index`, and
  the boxes stand in the layer in the order their surfaces were created,
  so overlapping placements stack as the spec says, and the browser gives
  the pointer to the topmost.
- **The keyboard** (SPEC §10.1). A click takes it only by focusing an
  element that takes focus: an `input`, `select`, `textarea` or `button`, a
  link with an `href` that is not a hyperlink, a details' first `summary`,
  an editing host, or a `tabindex` of 0 or more (a `label` counts as its
  control). A click on anything else, a hyperlink included, sends no
  `focus`, and on a surface that had the keyboard it sends `blur`. The browser focuses the frame on any click; once the press
  is done, the addon gives that focus back to the terminal, so text
  selection works as usual. A right click leaves focus where the browser
  put it, so the context menu's Copy copies the surface's selection.
- **A text field's keys** (SPEC §10.2, §10.4) are the program's keymap.
  Each key goes through xterm.js's keyboard handling, with what it would
  send the program kept back, and is named from that, so a field sees the
  key the program would read, in the encoding the program enabled. The
  field's keymap (the default, then each `data-keys` from the root to the
  field) decides: an action, which the addon does itself on the field's
  text with the editing commands, so the browser sends `input` and
  `change` as for typing; a character, which the browser types; or the
  program's, which gets what xterm.js encoded. Details:
  - Enter that submits, in an `input`, is the browser's own implicit
    submission; another key bound to `submit` does the same through the
    form's default button, or the form.
  - A textarea's rows are as it wraps them: a hidden copy of its text,
    with the same width and font, measures where each position is.
  - An email or number field, whose caret the browser keeps to itself, is
    `text` while focused (inspection still reports its type), and a number
    field types only what a number holds.
  - An editing host's actions use the selection's moves, a character at a
    time where the words and lines need to see the text.
- **Drags** (SPEC §9.1, a draft on hotty's `drag` branch). A mouse's or a
  pen's primary press on an element with `drag` in its `data-on` and an id
  reports `dragstart`, then `drag` each time the element under the pointer
  changes (each cell while there is none), then `dragend`, with the
  surface's cell and the keys held. The frame's root element captures the
  pointer (`setPointerCapture`) until the release, so the moves keep coming
  over the cells, other surfaces and outside the page, and none reach
  xterm.js's mouse reporting; the root is never replaced, so deltas do not
  lose the capture. The browser clicks the root on a captured release, so
  the drag reports the click itself when it ends where it began. The host
  stylesheet makes the elements that opt in unselectable, important in its
  layer, whatever the document's CSS. A touch never drags.
- **Presses** (SPEC §5.2, §9: `p=1` on `a=place`). Every primary press of a
  mouse or a pen in the window reports `press` on its pointerdown, before
  the drag and the focus it causes; a tap reports it on the mousedown the
  browser makes for it. A press on a hyperlink is the terminal's.
- **Fit** (SPEC §5.2, §9: `f=1` on `a=place`). The program hears `fit`
  with the rows the document needs at the placement's width whenever they
  differ from the rows it heard last, starting from the placement's own;
  the placement keeps its size. The rows are measured as for `r=auto`: the
  frame is laid out at that width and 1px high, then restored in the same
  task. A check waits for the next frame, so a frame sends one `fit` at
  most, with the rows it draws. Each of these asks for a check:
  - a document or a delta;
  - a resource arriving or changing;
  - the host stylesheet changing (cell size, font);
  - an image, a stylesheet or a font loading, whether a `cid:` resource or
    one from the network;
  - the root's or the body's box changing size (a `<details>` the user
    opens, say).

  A surface out of view checks once it is shown again. A check lays the
  document out a second time, so only placements with `f=1` pay for it.
- **Presses with Alt** (SPEC §9.2) are the program's. The frame cancels the
  press's mousedown (no focus, selection, drag or hyperlink), reports
  nothing, and captures the pointer on its root until the release; the
  addon replays the press on xterm.js's screen and the moves and release on
  its document, where xterm.js listens, as it replays wheels: a mouse report
  with Alt, or with reporting off, xterm.js's rectangular selection. A
  surface that had the keyboard gives it back first (`blur`). The browser's
  click on the release is not the surface's. Firefox drops the pressed
  element's `:hover` only at the next move.
- **Detached surfaces** (SPEC §5.5: `a=detach`, or `d=1` on `a=doc`) send no
  events and never take the keyboard. Their `input`, `select`, `textarea`
  and `button` elements carry a `disabled` of the addon's own, which
  inspection and morphs do not see, and which a delta cannot remove. Hover,
  selection, `<details>` and hyperlinks work as before. Only a hyperlink
  shows the hand, whatever the document's `cursor`; other links show the
  text pointer.
- **The browser's keys stay the browser's** (the `browserKeys` option):
  - reload (F5, and Ctrl or Cmd with R);
  - zoom (Ctrl or Cmd with +, − or 0);
  - full screen (F11);
  - the developer tools (F12, and Ctrl+Shift with I, J or C);
  - on a Mac, everything with Cmd.

  Neither the terminal nor a surface holding the keyboard sends them to the
  program, and the browser acts on them. A terminal cannot know which keys
  a program binds, so these are the browser's own. The addon installs
  xterm.js's custom key handler for this, so a page passes its own list
  here, not to xterm.js. The default is exported, so a page can add keys
  of its own:

  ```ts
  import { HottyAddon, browserKeys } from "@neuroplastio/xterm-addon-hotty";

  new HottyAddon({ browserKeys: (e) => browserKeys(e) || (e.ctrlKey && e.key === "k") });
  ```
- **Nothing in a surface scrolls unless its document asks** (SPEC §5.3, §9):
  - It shows no scrollbars, and pans nothing on a touch
    (`touch-action: none`). Any scroll offset the browser sets goes back to
    zero, except a text field's own text.
  - A wheel over a surface goes to the terminal, and so does a touch drag,
    as wheel events at the finger. After the finger lifts, the drag keeps
    going and slows down.
  - Taps and long presses stay the surface's.
  - On the cells, the addon handles touch too (the `touch` option, on by
    default), in place of xterm.js's own. A drag scrolls as over a surface.
    A tap is a click for the program: a press and a release at the finger.
    xterm.js 6.1's own touch handling sends wheel reports with no position
    (`NaN`, which a program reads as typing) and turns taps into nothing.
  - Ctrl and the wheel stay the browser's zoom.
  - xterm.js's scrollable reads the legacy `wheelDeltaY` where browsers have
    it, so a forwarded wheel carries one, worked out from the drag: on a
    constructed event the browser's own has the wrong sign in Chromium 15x.
  - A drag is measured in the page, not in the surface, which moves as the
    terminal scrolls.
  - **A page that scrolls itself** (`scroll: "page"`): for a page that shows
    a program's output whole, with the terminal as tall as what it shows,
    such as a document printed by a program. Wheels and touch drags over
    the surfaces and the cells are left to the browser, which scrolls the
    page natively, with its own momentum, and the program hears no wheel.
    xterm.js never sees them, since it would take a drag for its
    scrollback, or turn it into arrow keys. Surfaces pan on a touch
    (`touch-action: manipulation`), and over an element of the document
    that the browser would scroll instead (`overflow: auto`), the addon
    scrolls the page itself.

    ```ts
    new HottyAddon({ scroll: "page" });
    ```
- **A document that scrolls** (`scroll=1`, `2` or `3` on `a=doc`, SPEC
  §5.1, §5.3; the capabilities say `"scroll": true`):
  - Along the axes it asked for, the browser scrolls it as it scrolls a
    page: the root and every `overflow: auto` or `scroll` element, with
    the browser's scrollbars, which take pixels inside the frame, never
    cells. The root pans on a touch along those axes (`touch-action:
    pan-y`, `pan-x`).
  - Along an axis it did not ask for, the root and every element whose
    `overflow` there is `auto` or `scroll` are `overflow: hidden`, important
    in the host's layer: no scrollbar, and nothing the user does moves it.
    CSS cannot select by a computed value, so the addon reads it after each
    document, delta and host stylesheet, and marks those elements with an
    attribute of its own, which inspection and morphs do not see.
  - **Gestures.** A wheel gesture's first event decides where it goes, as
    a browser latches scrolling to what it began on (a gesture is wheels
    less than 150ms apart): to the document while the innermost box under
    the pointer that can move that way can (the browser scrolls it), else
    on to the terminal, as over the cells, unless `overscroll-behavior`
    stops it. A gesture begun over the cells stays the terminal's when a
    surface comes under the pointer. A touch drag decides the same way once
    it has a direction: the browser pans the document, or the drag goes to
    the terminal as before.
  - **Keys.** While the surface has the keyboard, the keys a browser
    scrolls with and the focused element does not use (SPEC §10.2) scroll
    the innermost box, from the focused element outward, that can move
    that way: the arrows by 40 pixels, Page Up and Page Down, Space and
    Shift+Space by seven eighths of the box, Home and End to the ends. The
    addon scrolls the box itself, since the browser's own action may be the
    element's (a radio button's arrows). Where nothing can move that way,
    the key goes on to the program, as any key the surface does not use.
  - Focus scrolls an element into view, as the browser does. The program
    hears nothing of scrolling. A delta keeps the offsets, and so do hiding
    and placing again; a new document starts at the top left. `r=auto` and
    `fit` measure the document with its root clipped, so the root's
    scrollbar does not make its lines wrap.
  - Where the page scrolls (`scroll: "page"`), the browser chains a
    gesture from the document to the page natively.
- **Where an element is** (SPEC §9: `area` on `click` and `press`): the
  cells of its bounding box in the frame, as the user sees it, scrolled
  included, divided by the cell size. An edge within half a device pixel of
  a cell's counts as on it, since layout rounds positions to fractions of a
  pixel. A press with no id carries none.
- **Cursor.** After `a=place` the cursor moves below the surface, as in the
  native host. xterm.js has no public API for that, so the addon uses the same
  private calls as the official image addon.
- **What xterm.js sends for a key** a text field names (SPEC §10.4) is read
  from its core service's `triggerDataEvent`, also private, which the addon
  holds back while the key goes through xterm.js's keyboard handling.
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
   `data:`, become absolute URLs where the network policy allows them (the
   page's grant and the document's request, both), and fail closed as
   `about:invalid` for everything else. A document's `<base>` and
   `<meta name="hotty-network">` are read before they are removed.
2. **The iframe:**
   - `sandbox="allow-same-origin allow-forms"`: no scripts, popups or
     navigation. `allow-forms` is there only so that `submit` fires; the
     submission is cancelled.
   - A CSP `<meta>` written by the parser before any program markup:
     `default-src 'none'`, with `data:` and `blob:` allowed for images,
     media and fonts, and the page's `network` grant; inline styles allowed,
     and `form-action 'none'`. It holds the page's grant on its own: a
     reference the sanitizer misses reaches nothing the page did not grant.
     Network URLs inside `cid:` stylesheets are not fetched (a stylesheet
     resource serves surfaces with different policies); a `<link>` to the
     stylesheet on the network, or a `<style>`, is.

With the CSP removed, 9 requests get through, all from CSS (`@import`, `url()`
and `@font-face`). With the sanitizer passing URLs through, the CSP alone
stops everything. `position: fixed` stays inside the surface's own viewport.

**The embedding page's CSP applies inside the surfaces too** (about:blank
iframes inherit it, and it can only be narrowed). A page that embeds xterm.js
already has to allow inline styles, because xterm's DOM renderer sets them.
For HOTTY it must also allow `data:` and `blob:` images, fonts and media, and
whatever origins it grants in `network`. This is the recommended policy (with
no network grant), and `tests/e2e/embedder.spec.ts` checks it:

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
  - the embedder's web fonts inside surfaces (system fonts work);
  - `hover` (§9.4, `v=1` on `a=place`): `EVENTS` does not list it, so a
    program never asks, and the vectors that require it are skipped. The
    frame would report the nearest id on `pointerover` with no button
    down, and out on leaving the frame, an Alt press, or a release
    outside it.

## Costs

Measured 2026-09-29 in headless Chromium 153 (`bench/`):

- **A surface** takes 4.7 ms to create and place, 8.7 ms of main-thread time
  with its first frame, and 1.2 MB of memory.
- **The dashboard** costs 4.9 ms of main-thread time per frame at 10 Hz.
- **Large documents** cost Chrome more per frame as they grow: its PrePaint
  walks the tree. A one-cell delta costs 8.4 ms of main-thread time per frame
  at 4,096 cells and 46 ms at 262,144. CSS containment brings the latter to
  30 ms; hotty-blitz does it in about 0.1 ms.
- **Bub-n-Bros** (`examples/bubbros.py`) costs about 4 ms per frame: deltas to
  seven sprites out of about 380.

## Tests

`npm run check` runs:

- the typecheck, the build and the declarations (what `npm pack` ships);
- the unit tests (`node --test`: the wire, keys, decoding the reference Python
  client, and the conformance vectors' wire, keys, keymap and edit
  sections);
- the Playwright tests, against Chromium (and Firefox once installed:
  `npx playwright install firefox`):
  - the protocol and the conformance vectors;
  - interaction, with `form.py` through the bridge;
  - text fields' keymaps beyond the vectors (`fields.spec.ts`);
  - the hostile page and the embedder's CSP;
  - Bub-n-Bros with kitty keys (skipped unless the game is fetched).

`bench/measure.mjs` and `bench/trace.mjs` produce the cost numbers.

## Licence

Apache-2.0 ([LICENSE](LICENSE)). xterm.js itself is MIT.
