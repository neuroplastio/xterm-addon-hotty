# xterm-addon-hotty: hotty for xterm.js

A [hotty](https://github.com/neuroplastio/hotty) host as an addon for
xterm.js, where the **browser is the engine**. Every surface is a real
document in a sandboxed iframe. It shares no code with hotty-blitz, the
other implementation, and passes the same conformance vectors. The hotty
repository's example programs run unchanged in a browser tab.

```
npm install @neuroplastio/xterm-addon-hotty @xterm/xterm
```

The package is an ES module with its TypeScript declarations, for xterm.js
6, and has no dependencies. A release also installs from git by its tag
(`github:neuroplastio/xterm-addon-hotty#v0.4.1`), and a commit not yet
released by its hash (`#<commit>`): npm builds it as it installs it
(`prepare`).

It implements hotty 0.4, whose bodies are msgpack maps (SPEC §3.3) and
whose keys are named by myelin key names 0.1 (§10.4). A
program's query names the versions it speaks (`a=q:n=1:v=0.4`, SPEC §4):
the addon answers a query that lists 0.4 with its capabilities (`v`,
`cellcss`, `scale`, `scheme`, `mod`, `features`, `limits`, `net`, `edit`,
`host`, `version`), and any other with `EVERSION`, so that such a program
finds no host and falls back to text. A command that asks for a reply (`n`)
gets one; a query always does, and every other command is quiet unless it
carries `n`.

0.4.x speaks hotty 0.4; the patch number is this repository's own.

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
| bodies | `src/msgpack.ts` | SPEC §3.3: replies' and events' bodies as msgpack maps, each field as its type; a float field (`scale`, `cellcss`'s `w` and `h`) goes in a `Float`, even when whole. A field with nothing is left out, never nil, and a map is a plain object, keyed by strings, each written once |
| addon | `src/addon.ts` | OSC handler, replies through `term.input(…, false)`, placement, synchronized output, RIS, the alternate screen, zoom and theme, and keys a surface does not use, through xterm.js's own keyboard handling |
| surface | `src/surface.ts` | one sandboxed iframe per surface; events, focus and key routing |
| keys | `src/keys.ts` | SPEC §10.2, §10.4: key names, the keys in what the terminal sends, keymaps (`data-keys`), the `prefix` action, and the actions on a field's text |
| deltas | `src/delta.ts` | SPEC §6, §6.1: a delta body checked whole, then its ops and morph; a failure names the first failing op (`i`) |
| menus | `src/menu.ts` | SPEC §10.7: reading a program's `a=menu` body, the level a sequence reaches, and the entries a page's own palette lists |
| touch | `src/touch.ts` | SPEC §9, §9.1, §9.6: a finger's drag as wheel events and its fling, a tap, a drag a surface claims, and reading the areas a program names in the cells |
| reveal and view | `src/view.ts` | SPEC §6.1, §9.5: the boxes that hold an element, scrolling it into view in them, and whether some of it is shown |
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
  A key that types no text (not a character, or a character with `ctrl`
  or `super`) is offered first as pressed, named from the DOM's event by
  its physical key (`code`: `ctrl+key_w`) and the character it types
  (`key`: `ctrl+w`), the physical one looked up first, before xterm.js
  translates it: on a Mac, Option+Left is `alt+arrow_left`, not the ESC b
  the program would read. A modifier tapped on its own is named on its
  release (`shift_left`, `shift`), which matters to a key bound to
  `prefix`. Otherwise the key goes through xterm.js's
  keyboard handling, with what it would send the program kept back, and
  is named from that, so a field sees the key the program would read, in
  the encoding the program enabled. The field's keymap (the default, then each `data-keys` from the root to the
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
    `text` while focused (inspection still reports its type, and
    `inputmode` keeps the on-screen keyboard), and a number field types
    only what a number holds. CSS that selects on `[type=email]` or
    `[type=number]` does not match it while it is focused.
  - An editing host's actions use the selection's moves, a character at a
    time where the words and lines need to see the text.
- **Keys for the program** (SPEC §10.2). Any focused element has a keymap:
  each `data-keys` from the root to it, over the default only in a text
  field; with nothing focused there is none. A key it binds to `program`
  (named as in a text field; a key with `shift` that is not a character is
  looked up again without it)
  goes to the program as xterm.js encoded it, and the browser does nothing
  with it: a select's arrows pick nothing, and a document that scrolls does
  not scroll. Outside a text field the keymap's other bindings do nothing
  but the scroll actions (below), and a nearer one of a key still cancels a
  farther `program`.
- **Scrolling keys** (SPEC §10.2). Outside a text field, a key the focused
  element does not use and its keymap binds to a scroll action
  (`scroll-down`, `scroll-page-up`, `scroll-half-page-down`, `scroll-end`,
  …) scrolls, along an axis the document asked for: the nearest box from
  the element outward that can still move that way, as a wheel goes, up to
  the root and never the terminal; with nowhere to go, it does nothing and
  the program hears nothing. The addon scrolls as Chromium's keys do: 40
  CSS pixels for a line, 87.5% of the box for a page, half of it for a half
  page, and to the end for `scroll-start` and `scroll-end`. Along an axis
  the document did not ask for, the key goes on as if unbound. A text
  field's keymap leaves scroll actions out, so a field inside a box that
  scrolls with `j` still types `j`.
- **Selects** (SPEC §10.2) are the browser's own: its keys pick, each pick
  is heard at once (`input` with `data-on~=input`, then `change`), and its
  native list opens past the surface. While the list is open it has every
  key: Chromium's keeps them from the document, and where one reaches it
  (`:open`), the addon leaves it to the list.
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
  layer, whatever the document's CSS.

  A touch drags such an element only where its `touch-action` allows no
  pan along the touch's first move past 8 px (the larger delta; a tie is a
  pan). The value is the element's own, met with its ancestors' up to the
  nearest one that scrolls, both included, as Pointer Events have it; the
  host's own `touch-action` on the root (below) is not the document's. The
  touch then reports `press` and `dragstart` at the cell where it began,
  and drags from there as a mouse does; the lift reports `dragend`, and the
  click where it began. A second finger ends it with `dragend` and no
  target, and nothing more is heard until every finger lifts. A long press,
  or Alt held at the touch, never drags. Any other touch pans as below.

  An element that also has `data-steps="<x> [<y>]"` (whole numbers up to
  2^53 − 1, 0 for none along that axis) says where in it the pointer is:
  every event of a drag of it carries `x` and `y`, the pointer's step
  along its border box (`getBoundingClientRect`, as it is at each move),
  rounded to the nearest and clamped to 0 and the count, wherever the
  pointer or the finger is.
  A `drag` also goes out each time the step changes. The counts are read
  when the drag starts; once the element has left the document, the step
  stays as it last was, as it does in a `dragend` that ends a drag early.
  The capabilities report `steps: true`.
- **Presses** (SPEC §5.2, §9: `p=1` on `a=place`). Every primary press of a
  mouse or a pen in the window reports `press` on its pointerdown, before
  the drag and the focus it causes; a tap reports it on the mousedown the
  browser makes for it, and a touch that drags when it becomes a drag. A
  touch that pans presses nothing. A press on a hyperlink is the terminal's.
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
- **Copying** (SPEC §10.2, §11): a surface's selection is copied by its
  keymap, `mod+c` by default (Cmd+C on a Mac, Ctrl+C elsewhere: `mod` is
  `super` or `ctrl`, the platform's, §10.4), and neither the surface nor the
  program hears the key; a document that binds one to `program` gives it
  to the program while its text is selected. A focused field copies its
  selection, never a password field's. With nothing selected the key goes
  where it would: Ctrl+C interrupts. The cells' selection is copied by the
  `copyKeys` option (default: the exported `copyKeys`, Ctrl+C and Cmd+C;
  `() => false` turns it off). There is one selection: a press on the
  cells, or a selection made there, drops a surface's, and a press in a
  surface drops the others'. The browser's own Copy menu copies what is
  selected whatever the keymaps say.
- **Cutting, pasting and undo** (SPEC §10.2): in a surface's focused text
  field, by its keymap, Ctrl+X cuts (to `navigator.clipboard`), Ctrl+V is the browser's
  own paste (an `input` drops line breaks, as HTML's does), and Ctrl+Z,
  Ctrl+Shift+Z and Ctrl+Y undo and redo, each field with its own history,
  kept by the addon so that every browser groups edits as the spec does.
  A key a document binds to `paste` that the browser does not paste with
  reads `navigator.clipboard`. A cut with nothing selected, or in a password
  field, reaches the program. On a Mac, Cmd keys stay the browser's
  (`browserKeys`), its own cut, paste and undo.
- **Prefix** (SPEC §10.5): a key a keymap binds to `prefix` is the
  program's, and while it is on every key, Tab and Escape included, goes to
  the program. It ends when the program focuses (`a=focus`, with no `t` too)
  or blurs, when the surface loses the keyboard or is hidden, or on a press
  in the surface. The browser's own keys (`browserKeys`) stay the browser's.
- **The program's menu** (SPEC §10.7): `a=menu` with a body sets the
  program's menu, a tree of items (`key`, `label`, `name`, `enabled`,
  `items`) nested at most eight deep, and `a=menu` with none leaves it none;
  a body of another shape is `EINVAL`. The addon keeps one for each screen:
  leaving the alternate screen drops its menu, RIS both. `a=menu:show=1`
  shows the level its `seq` reaches (the items that have a key, each shown
  as myelin key names §6 shows it: `←` `→` `↑` `↓`, `⇥` and `⇧⇥`, and
  every other key as its canonical name) at the
  bottom right of the screen, on whole cells, for the cells and a surface
  alike; a menu sent meanwhile shows the same keys' level of the new one.
  `show=0`, Escape, a key the level does not list (typed to the cells or to
  a surface), another screen, or RIS hides it. `shownMenu()` returns the
  level shown (`{key, label, group, enabled}[]`, or null), for tests.
- **A pick, from the page's own palette** (SPEC §10.7): the addon draws no
  palette, since xterm.js has none and a host adds none for a program's
  menu. A page that has a command palette lists a program's actions in it
  and runs them. `menuItems()` returns the items of the active screen's
  menu that have a name, in the menu's order, each `{name, label, keys,
  enabled}` (the exported `MenuEntry`): `label` is its groups' labels and
  its own joined with `" › "` (`Leader › File › New file`; the name where it
  has no label), and `keys` the keys that reach it, space-separated, with
  `mod` read as the platform's, in myelin key names (`ctrl+x f n`; empty
  when no key does; `displayKey()` shows one as §6 does, with `←` for
  `arrow_left`).
  `pick(name)` runs one: `command` with `{name}` and no key, or for `copy`
  with text selected on the cells, the selection copied and nothing sent,
  and for `paste` the clipboard's text with it. It returns false, and
  sends nothing, for a disabled item, an unknown name, or no menu. Both
  follow the active screen and the last `a=menu`, so a page reads
  `menuItems()` each time its palette opens.
- **Touch in the cells** (SPEC §9.6): `a=touch` names cells of the screen
  where a finger drags, `{"areas": [{"c", "r", "w", "h", "drag"}]}`, kept
  per screen as `a=edit` is: leaving the alternate screen drops its areas,
  RIS both, and `a=touch` with no body leaves none. While the program reads
  the mouse (`term.modes.mouseTrackingMode` is not `none`) and the terminal
  shows the screen, not its scrollback, a touch that begins in an area
  without Alt, and whose first move past 8 px goes a way the area drags (the
  larger delta; a tie pans), is the mouse's primary button. The addon
  replays it on the cells as a mouse's press, moves and release, as it
  replays a press with Alt on a surface, so xterm.js reports them in the
  program's own mode and encoding, with Ctrl, Alt and Meta as held, never
  Shift (with a press, xterm.js would select instead). A tap there is a
  click, as on any cell; a long press never drags; a second finger, or a
  touch the browser loses, releases on the last cell. Areas do nothing with
  `touch: false`, with `scroll: "page"`, where the cells' touches are the
  browser's, or with xterm.js's `mouseEventsRequireAlt`. In Chromium, a
  touch that lands within about 10 px of a surface is the surface's: the
  browser's touch adjustment gives it to the frame.
- **Commands in the cells** (SPEC §10.6): `a=edit` is kept per screen, and
  a key of a command taken goes to the program as `command`, after the
  cells' selection is copied (`copyKeys`). A paste brings the text of the
  browser's own paste where the key makes one, as on the cells; from a
  surface it reads `navigator.clipboard`, and keys typed while that reads
  can reach the program first.
- **Nothing in a surface scrolls unless its document asks** (SPEC §5.3, §9):
  - It shows no scrollbars, and pans nothing on a touch
    (`touch-action: none`). Any scroll offset the browser sets goes back to
    zero, except a text field's own text.
  - A wheel over a surface goes to the terminal, and so does a touch that
    pans, as wheel events at the finger. After the finger lifts, the drag keeps
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
    surface comes under the pointer. A touch that pans decides the same way
    once it has a direction: the browser pans the document, or the touch
    goes to the terminal as before. Where the document's `touch-action`
    would stop the browser's pan (a `none` on a box that doesn't drag), the
    addon pans the box itself, so that only a drag element takes a touch
    from scrolling (SPEC §9.1).
  - **Keys.** While the surface has the keyboard, the keys a browser
    scrolls with that the focused element neither uses nor gives the
    program (SPEC §10.2) scroll the innermost box, from the focused
    element outward, that can move that way: the arrows by 40 pixels, Page
    Up and Page Down, Space and Shift+Space by seven eighths of the box,
    Home and End to the ends. The addon scrolls the box itself, since the
    browser's own action may be the element's (a radio button's arrows).
    Where nothing can move that way, the key goes on to the program, as any
    key the surface does not use.
  - Focus scrolls an element into view, as the browser does, and so does
    `reveal` (below). The program hears of scrolling only through `view`
    (below). A delta keeps the offsets, and so do hiding
    and placing again; a new document starts at the top left. `r=auto` and
    `fit` measure the document with its root clipped, so the root's
    scrollbar does not make its lines wrap.
  - Where the page scrolls (`scroll: "page"`), the browser chains a
    gesture from the document to the page natively.
- **Where an element is** (SPEC §9: `area` on `click`, `press` and
  `view`): the cells of its bounding box in the frame, as the user sees it,
  scrolled included, divided by the cell size. An edge within half a device
  pixel of a cell's counts as on it, since layout rounds positions to
  fractions of a pixel. A press with no id carries none.
- **Reveal** (SPEC §6.1: `op=reveal`, the capabilities' `ops` list it)
  scrolls the boxes that hold the target, innermost first and the root
  last, as `scrollIntoView` would with `start`, `end` or `nearest`, but
  only those the document scrolls (`overflow: auto` or `scroll` along an
  axis it asked for, and the root), and never one outside the document:
  the browser's own `scrollIntoView` would scroll the box that shows the
  window, xterm.js's and the page too, and `overflow: hidden` boxes. A box
  holds the target where its containing blocks pass through it, as CSS has
  it: an absolutely positioned element leaves the boxes between it and its
  containing block. Each box's offset is worked out from where the target
  will be once the boxes inside have moved, so all scroll at once, and the
  document's `scroll-behavior: smooth` animates them. A surface not placed
  scrolls nothing; one out of view is laid out unseen for it, as `r=auto`
  measures, and keeps the offsets.
- **View** (SPEC §9.5). The elements
  with `view` in `data-on` and an id are in view where some of their border
  box, as `getBoundingClientRect` has it (transforms included), lies inside
  the window, within the viewport's scrollbars, and inside the scrollport
  of each box that holds and clips it (overflow other than `visible`, or
  paint containment), by more than half a device pixel. An element thinner
  than that, an empty one, is in view where it lies inside, as a cell's top
  edge is the cell's. One `display: none`, `visibility: hidden`, or inside
  a closed `<details>` is not (`checkVisibility`). `end` is the root's
  `scrollTop` within a pixel of its end. When:
  - A check waits for the next frame, so a frame sends one `view` at most,
    and it goes out only when what it carries differs from what the
    program heard last. Each of these asks for one: a placement, a
    document, a delta, a resource, the host stylesheet, an image, a
    stylesheet or a font loading, a `<details>` toggled, a transition or
    an animation ending, the root, the body or an element that reports
    changing size (`ResizeObserver`), and an element that reports coming
    into the window or leaving it (`IntersectionObserver`, with the window
    as its margins).
  - A scroll holds checks until every box it moves has come to rest: its
    `scrollend`, or, where the browser has none, 150 ms without a scroll
    (600 ms stands for a `scrollend` that never came). A gesture's
    momentum and a smooth scroll send one `view`, where they end.
  - Each `a=place` is a new placement, whose first `view` goes out once it
    is drawn, whatever the program heard before; `a=hide` stops them, and
    a placement out of view checks once it is shown again. A new document
    sends one once laid out. A detached surface sends none.
  - Two elements with one id report as one: the first in view.
- **Cursor.** After `a=place` the cursor moves below the surface, as in the
  native host. xterm.js has no public API for that, so the addon uses the same
  private calls as the official image addon.
- **Synchronized output** (SPEC §6.3): the addon holds a batch's commands
  until it ends. A placement in it still goes where the cursor is as it
  comes, and moves the cursor then; only its drawing waits. One with
  `r=auto` that moves the cursor needs its document laid out as it comes,
  so the commands held before it are applied then, and may be drawn before
  the batch ends.
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
For hotty it must also allow `data:` and `blob:` images, fonts and media, and
whatever origins it grants in `network`. This is the recommended policy (with
no network grant), and `tests/e2e/embedder.spec.ts` checks it:

```
default-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:
```

## Differences from hotty-blitz

- **Pixels differ.** The browser renders, so text, form controls and
  antialiasing look like the browser's. The cell footprint is the same (§9).
- **Zoom and fonts.** A zoom or a change of display scale updates
  `--hotty-px` in the host stylesheet (SPEC §8) and sends nothing; a font
  change that moves the cell sends `caps` with the new `cellcss` to programs
  that asked for caps. The browser also gives
  native `<select>`, IME and spellcheck.
- **Not here yet:**
  - §9's text in xterm's buffer (search, serialize, and a selection across a
    surface);
  - following content that scrolls on the alternate screen;
  - the embedder's web fonts inside surfaces (system fonts work);
  - `hover` (§9.4, `v=1` on `a=place`): `features` does not list it, so a
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
- the unit tests (`node --test`: the wire, keys, the keys any focused
  element gives the program, decoding the reference Python client, the
  msgpack bodies, as the reference client reads them, the tests' reader
  against the SDKs' decode vectors, and the conformance vectors' wire,
  keys, keymap and edit sections);
- the Playwright tests, against Chromium (and Firefox once installed:
  `npx playwright install firefox`):
  - the protocol and the conformance vectors. Every body the addon sends
    is read as an SDK reads it, so a nil, a key that is not a string or is
    given twice in one map, or an int past 2^53 − 1 anywhere fails the test
    (SDK.md §3.9), and with its fields' types (`tests/msgpack.ts`); the
    vectors' numbers keep theirs: `720.0` is a float, `720` an int;
  - interaction, with `form.py` through the bridge;
  - text fields' keymaps beyond the vectors (`fields.spec.ts`);
  - the hostile page and the embedder's CSP;
  - Bub-n-Bros with kitty keys (skipped unless the game is fetched).

`bench/measure.mjs` and `bench/trace.mjs` produce the cost numbers.

## Licence

Apache-2.0 ([LICENSE](LICENSE)). xterm.js itself is MIT.
