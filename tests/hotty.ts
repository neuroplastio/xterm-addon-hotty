// Where the HOTTY repository is: its conformance vectors, examples and
// reference client are this addon's test material. HOTTY_DIR, or a checkout
// next to this one (a plain clone at ../hotty, or the worktree layout at
// ../../hotty/main).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const HOTTY_DIR = ((): string => {
  if (process.env.HOTTY_DIR) return resolve(process.env.HOTTY_DIR);
  for (const c of [resolve(root, "../hotty"), resolve(root, "../../hotty/main")]) {
    if (existsSync(join(c, "SPEC.md"))) return c;
  }
  throw new Error("no HOTTY checkout: set HOTTY_DIR, or clone neuroplastio/hotty next to this repository");
})();
