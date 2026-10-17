# For agents

xterm-addon-hotty is a hotty host for xterm.js: the browser renders each
surface in a sandboxed iframe. The protocol is `SPEC.md` in
neuroplastio/hotty; this repository implements it and must not grow it.

- **Tests need the hotty repository** (vectors, examples, reference client):
  `HOTTY_DIR`, or a checkout next to this one. `npm run check` is the gate:
  typecheck, build, unit, Playwright.
- **Bodies are msgpack** (SPEC §3.3, `src/msgpack.ts`), each field as the
  type SPEC gives it. JavaScript has one kind of number: the writer takes a
  number as an int, which must be whole, and a float field goes in
  `float()`. It writes no nil (a field with nothing is left out), maps
  only from plain objects, and no key with a lone surrogate (it would go
  out as U+FFFD, perhaps twice). The tests read every body the addon sends
  as an SDK does (SDK.md §3.9: no nil, keys strings each given once, ints
  within 2^53 − 1, …) and with SPEC's types (`tests/msgpack.ts`).
- **Security is two layers**, and each must hold on its own
  (`tests/e2e/hostile.spec.ts`): the sanitizer (`src/resolver.ts`), and the
  iframe's sandbox and CSP (`src/surface.ts`). Never weaken either to make a
  test pass.
- **A behaviour the spec does not state** is a question for the hotty
  repository, not a quiet choice here. If the vectors and this addon
  disagree, fix the addon or propose a spec change there.
- **Private xterm.js APIs and behaviour** (cell size, cursor movement after
  `place`, forwarding keys by dispatching them to xterm.js's textarea,
  which focuses the terminal on keyup, and reading what it sends for a key
  through its core service's `triggerDataEvent`) are isolated in
  `src/addon.ts`.
  Re-run everything when xterm.js is upgraded.
