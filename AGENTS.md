# For agents

xterm-addon-hotty is a HOTTY host for xterm.js: the browser renders each
surface in a sandboxed iframe. The protocol is `SPEC.md` in
neuroplastio/hotty; this repository implements it and must not grow it.

- **Tests need the HOTTY repository** (vectors, examples, reference client):
  `HOTTY_DIR`, or a checkout next to this one. `npm run check` is the gate:
  typecheck, build, unit, Playwright.
- **Security is two layers**, and each must hold on its own
  (`tests/e2e/hostile.spec.ts`): the sanitizer (`src/resolver.ts`), and the
  iframe's sandbox and CSP (`src/surface.ts`). Never weaken either to make a
  test pass.
- **A behaviour the spec does not state** is a question for the hotty
  repository, not a quiet choice here. If the vectors and this addon
  disagree, fix the addon or propose a spec change there.
- **Private xterm.js APIs** (cell size, cursor movement after `place`) are
  isolated in `src/addon.ts`. Re-run everything when xterm.js is upgraded.
