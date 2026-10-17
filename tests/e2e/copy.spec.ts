// Copying (SPEC §10.2, §11): while something is selected, on the cells or
// in a surface, Ctrl+C copies it and nothing hears the key; with nothing
// selected, the program hears it. A surface's keymap may give the key to
// the program. There is one selection.
import { expect, type Page, test } from "@playwright/test";
import { open, send, surface, take, write } from "./helpers.ts";

const DOC = `<p id=p>Some words to copy</p><input id=i value="field text"><input id=pw type=password value=secret>`;

/** The page with a surface `k`, and the clipboard a list the test reads. */
async function setup(page: Page) {
  await open(page, "?pty=0");
  await page.evaluate(() => {
    const copied: string[] = [];
    (window as unknown as { copied: string[] }).copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void copied.push(t) },
    });
  });
  await send(page, { a: "doc", s: "k", q: "2" }, DOC);
  await send(page, { a: "place", s: "k", c: "40", r: "8", q: "2" });
  await take(page);
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { copied: string[] }).copied.splice(0));

/** Selects the paragraph in the surface's document. */
async function selectParagraph(page: Page) {
  await surface(page, "k")
    .locator("#p")
    .evaluate((p) => p.ownerDocument.getSelection()!.selectAllChildren(p));
}

const surfaceSelection = (page: Page) =>
  surface(page, "k")
    .locator("#p")
    .evaluate((p) => p.ownerDocument.getSelection()!.toString());

test("Ctrl+C copies a surface's selection from the terminal, and interrupts without one", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.hotty.term.focus());
  await page.keyboard.press("Control+c");
  expect(await copied(page)).toEqual([]);
  expect((await take(page)).raw).toBe("\x03");

  await selectParagraph(page);
  await page.keyboard.press("Control+c");
  expect(await copied(page)).toEqual(["Some words to copy"]);
  expect((await take(page)).raw).toBe("");
  // It stays selected.
  expect(await surfaceSelection(page)).toBe("Some words to copy");
});

test("Ctrl+C in a field copies its selection, never a password field's", async ({ page }) => {
  await setup(page);
  const s = surface(page, "k");
  await s.locator("#i").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+c");
  expect(await copied(page)).toEqual(["field text"]);
  expect((await take(page)).msgs.filter((m) => m.get("e") === "key")).toEqual([]);

  await s.locator("#pw").click();
  await page.keyboard.press("Control+a");
  await take(page);
  await page.keyboard.press("Control+c");
  expect(await copied(page)).toEqual([]);
  expect((await take(page)).raw).toBe("\x03");
});

test("the terminal's selection is copied, and there is one selection", async ({ page }) => {
  await setup(page);
  await write(page, "cells\r\n");
  await selectParagraph(page);
  // Selecting on the cells drops the surface's.
  await page.evaluate(() => {
    const t = window.hotty.term as unknown as {
      select(c: number, r: number, n: number): void;
      focus(): void;
      buffer: { active: { cursorY: number; baseY: number } };
    };
    t.focus();
    const b = t.buffer.active;
    t.select(0, b.baseY + b.cursorY - 1, 3);
  });
  expect(await surfaceSelection(page)).toBe("");
  await page.keyboard.press("Control+c");
  expect(await copied(page)).toEqual(["cel"]);
  expect((await take(page)).raw).toBe("");

  // A press in the surface drops the terminal's.
  await surface(page, "k").locator("#p").click();
  expect(await page.evaluate(() => (window.hotty.term as unknown as { hasSelection(): boolean }).hasSelection())).toBe(false);

  // A press on the cells drops the surface's.
  await selectParagraph(page);
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(box.x + box.width - 5, box.y + box.height - 5);
  expect(await surfaceSelection(page)).toBe("");
});

test("a document's keymap may give Control+c to the program while its text is selected", async ({ page }) => {
  await setup(page);
  await send(page, { a: "doc", s: "k", q: "2" }, `<p id=p data-keys="ctrl+c=program ctrl+k=copy">Some words to copy</p>`);
  await selectParagraph(page);
  await page.evaluate(() => window.hotty.term.focus());
  await take(page);
  await page.keyboard.press("Control+c");
  expect(await copied(page)).toEqual([]);
  expect((await take(page)).raw).toBe("\x03");
  await page.keyboard.press("Control+k");
  expect(await copied(page)).toEqual(["Some words to copy"]);
  expect((await take(page)).raw).toBe("");
});

test("copyKeys turns copying the cells off", async ({ page }) => {
  await open(page, "?pty=0&copy=0");
  await write(page, "cells\r\n");
  await page.evaluate(() => {
    const t = window.hotty.term as unknown as { select(c: number, r: number, n: number): void; focus(): void; buffer: { active: { cursorY: number; baseY: number } } };
    t.focus();
    const b = t.buffer.active;
    t.select(0, b.baseY + b.cursorY - 1, 3);
  });
  await take(page);
  await page.keyboard.press("Control+c");
  expect((await take(page)).raw).toBe("\x03");
});
