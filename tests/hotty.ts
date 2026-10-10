// Where the HOTTY repository is: its conformance vectors, examples and
// reference client are this addon's test material. HOTTY_DIR, or a checkout
// next to this one (a plain clone at ../hotty, or the worktree layout at
// ../../hotty/main).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Float } from "../src/msgpack.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const HOTTY_DIR = ((): string => {
  if (process.env.HOTTY_DIR) return resolve(process.env.HOTTY_DIR);
  for (const c of [resolve(root, "../hotty"), resolve(root, "../../hotty/main")]) {
    if (existsSync(join(c, "SPEC.md"))) return c;
  }
  throw new Error("no HOTTY checkout: set HOTTY_DIR, or clone neuroplastio/hotty next to this repository");
})();

/**
 * conformance/vectors.json, each number of the type its README gives it: a
 * float, written with a fraction or an exponent (`720.0`), comes back a
 * `Float`, and an int a number. JSON.parse's reviver reads how each number
 * is written from its source text.
 */
export function readVectors() {
  const src = readFileSync(join(HOTTY_DIR, "conformance", "vectors.json"), "utf8");
  return JSON.parse(src, (_key: string, v: unknown, context?: { source?: string }) => {
    if (typeof v !== "number") return v;
    if (context?.source === undefined) throw new Error("JSON.parse gives the reviver no source text: run the Node mise.toml pins");
    return /[.eE]/.test(context.source) ? new Float(v) : v;
  });
}
