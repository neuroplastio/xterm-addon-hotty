// The shared protocol vectors (conformance/README.md), run in the browser.
// hotty-blitz runs the same file (crates/hotty-blitz/tests/conformance.rs).

import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOTTY_DIR } from "../hotty.ts";
import { cmd, open, take, write } from "./helpers.ts";

type Step = { send?: Record<string, string>; payload?: string; reply?: Record<string, string> | null; inspect?: [string, string]; expect?: Record<string, unknown> | null };
const vectors = JSON.parse(readFileSync(join(HOTTY_DIR, "conformance", "vectors.json"), "utf8")) as {
  vectors: { name: string; steps: Step[] }[];
};

for (const vector of vectors.vectors) {
  test(vector.name, async ({ page }) => {
    await open(page);
    for (const [i, step] of vector.steps.entries()) {
      const where = `step ${i + 1}`;
      if (step.send) {
        await take(page);
        await write(page, cmd(step.send, step.payload ?? ""));
        const { msgs } = await take(page);
        if (step.reply === undefined) continue;
        if (step.reply === null) {
          expect(msgs, where).toHaveLength(0);
          continue;
        }
        expect(msgs.length, where).toBeGreaterThan(0);
        const got = msgs[0]!;
        const body = (got.json ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(step.reply)) {
          expect(k === "code" || k === "detail" ? body[k] : got.get(k), `${where}: ${k}`).toBe(v);
        }
      } else if (step.inspect) {
        const [s, id] = step.inspect;
        const got = await page.evaluate(([s, id]) => (window as unknown as { hotty: { addon: { inspect(s: string, id: string): unknown } } }).hotty.addon.inspect(s, id), [s, id] as const);
        if (step.expect === null) {
          expect(got, `${where}: #${id}`).toBeNull();
          continue;
        }
        expect(got, `${where}: #${id}`).not.toBeNull();
        for (const [k, v] of Object.entries(step.expect!)) expect((got as Record<string, unknown>)[k], `${where}: #${id} ${k}`).toEqual(v);
      }
    }
  });
}
