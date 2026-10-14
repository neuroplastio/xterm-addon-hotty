// Cutting, pasting and undo in a text field (SPEC §10.2, §11): a cut puts
// the selection on the clipboard and deletes it, a paste types the
// clipboard, each is an edit undo takes back, and with nothing to cut the
// key is the program's. The vectors check the history's runs.
import { expect, type Page, test } from "@playwright/test";
import { open, send, surface, take } from "./helpers.ts";

// Meta+v pastes too: a key the browser pastes nothing with, where `Mod` is
// Control (SPEC §10.4).
const DOC = `<div data-keys="Meta+v=paste"><input id=i data-on=input value="one two"><textarea id=a data-on=input></textarea><input id=pw type=password value=secret></div>`;

/** The page with a surface `k`, its field `i` focused, and the clipboard a
 * list the test reads and a text it gives. */
async function setup(page: Page) {
  await open(page, "?pty=0");
  await page.evaluate(() => {
    const w = window as unknown as { copied: string[]; clip: string };
    w.copied = [];
    w.clip = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (t: string) => void w.copied.push(t),
        readText: async () => w.clip,
      },
    });
  });
  await send(page, { a: "doc", s: "k", q: "2" }, DOC);
  await send(page, { a: "place", s: "k", c: "40", r: "8", q: "2" });
  await send(page, { a: "focus", s: "k", t: "i", q: "2" });
  await take(page);
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied.splice(0));
const clip = (page: Page, t: string) => page.evaluate((t) => void ((window as unknown as { clip: string }).clip = t), t);
const value = (page: Page, id: string) => surface(page, "k").locator(`#${id}`).inputValue();
const inputs = async (page: Page) =>
  (await take(page)).msgs.filter((m) => m.get("e") === "input").map((m) => (m.body as { value?: string } | null)?.value);

test("Control+x cuts the selection, and with nothing selected reaches the program", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+x");
  expect(await copied(page)).toEqual(["one two"]);
  expect(await value(page, "i")).toBe("");
  expect(await inputs(page)).toEqual([""]);

  await page.keyboard.press("Control+x");
  expect(await copied(page)).toEqual([]);
  expect((await take(page)).raw).toBe("\x18");

  // Undo puts it back.
  await page.keyboard.press("Control+z");
  expect(await value(page, "i")).toBe("one two");
  expect(await inputs(page)).toEqual(["one two"]);
});

test("a password field has no cut", async ({ page }) => {
  await setup(page);
  await send(page, { a: "focus", s: "k", t: "pw", q: "2" });
  await page.keyboard.press("Control+a");
  await take(page);
  await page.keyboard.press("Control+x");
  expect(await copied(page)).toEqual([]);
  expect((await take(page)).raw).toBe("\x18");
});

test("a key bound to paste that the browser does not paste with (Meta+v) types the clipboard, an input without its line breaks, and undo takes it back", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("End");
  await clip(page, " three\nfour");
  await page.keyboard.press("Meta+v");
  await expect.poll(() => value(page, "i")).toBe("one two threefour");
  expect((await take(page)).raw).toBe("");

  await send(page, { a: "focus", s: "k", t: "a", q: "2" });
  await page.keyboard.press("Meta+v");
  await expect.poll(() => value(page, "a")).toBe(" three\nfour");

  await page.keyboard.press("Control+z");
  expect(await value(page, "a")).toBe("");
  await page.keyboard.press("Control+y");
  expect(await value(page, "a")).toBe(" three\nfour");
});

test("Control+v is left to the browser's own paste, and the program hears nothing", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("Control+v");
  expect((await take(page)).raw).toBe("");
  expect(await value(page, "i")).toBe("one two");
});
