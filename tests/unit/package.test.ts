// What the package exports is built, not committed (dist/), so npm has to
// build it wherever it makes the package: `prepare` runs when it packs or
// publishes, and when it installs from git. `prepack` alone left a git
// install (github:neuroplastio/xterm-addon-hotty#…) with nothing to import:
// npm packs a git dependency without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("prepare builds what the package exports, for npm and for git", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.prepare, "npm run build && npm run types");
  assert.equal(pkg.scripts.prepack, undefined);
  assert.deepEqual(pkg.files, ["dist/hotty-xterm.js", "dist/hotty-xterm.js.map", "dist/types"]);
});
