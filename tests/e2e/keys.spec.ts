// The browser's own keys stay the browser's (the browserKeys option): the
// terminal leaves them alone and so does a surface holding the keyboard, so
// reload, zoom and the developer tools work. Every other key is the
// program's.
import { expect, test } from "@playwright/test";
import { cmd, open, send, surface, take } from "./helpers.ts";

type Init = { key: string; code: string; keyCode: number; ctrlKey?: boolean };
const F5: Init = { key: "F5", code: "F5", keyCode: 116 };
const ctrlR: Init = { key: "r", code: "KeyR", keyCode: 82, ctrlKey: true };
const up: Init = { key: "ArrowUp", code: "ArrowUp", keyCode: 38 };

test("the terminal leaves the browser's keys to the browser", async ({ page }) => {
  await open(page, "?pty=0");
  await take(page);
  const prevented = await page.evaluate(
    (keys) => {
      const ta = (window.hotty.term as unknown as { textarea: HTMLTextAreaElement }).textarea;
      return keys.map((init) => {
        const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
        ta.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
    },
    [F5, ctrlR, up],
  );
  expect(prevented).toEqual([false, false, true]);
  // Only the arrow reached the program.
  expect((await take(page)).raw).toBe("\x1b[A");
});

test("a page adds keys of its own to the browser's, with the exported default", async ({ page }) => {
  await open(page, "?pty=0&page-key=k");
  await take(page);
  const ctrlK: Init = { key: "k", code: "KeyK", keyCode: 75, ctrlKey: true };
  const prevented = await page.evaluate(
    (keys) => {
      const ta = (window.hotty.term as unknown as { textarea: HTMLTextAreaElement }).textarea;
      return keys.map((init) => {
        const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
        ta.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
    },
    [ctrlK, F5, up],
  );
  expect(prevented).toEqual([false, false, true]);
  expect((await take(page)).raw).toBe("\x1b[A");
});

test("a surface holding the keyboard leaves them to the browser too", async ({ page }) => {
  await open(page, "?pty=0");
  await send(page, { a: "doc", s: "k", q: "2" }, `<input id=i>`);
  await send(page, { a: "place", s: "k", c: "20", r: "2", q: "2" });
  const input = surface(page, "k").locator("#i");
  await input.click();
  await take(page);
  const prevented = await input.evaluate((el, init) => {
    const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, F5);
  expect(prevented).toBe(false);
  expect((await take(page)).raw).toBe("");
});

// A program in the page (the WebAssembly shell, say) answers a key at once:
// xterm.js parses what it writes right after user input, inside the key's
// own dispatch. A surface the program blurs and deletes in that answer
// still gives the keyboard back to the terminal.
test("a surface blurred and deleted in answer to a key gives the keyboard back", async ({ page }) => {
  await open(page, "?pty=0");
  await send(page, { a: "doc", s: "k", q: "2" }, `<input id=i>`);
  await send(page, { a: "place", s: "k", c: "20", r: "2", q: "2" });
  await send(page, { a: "focus", s: "k", t: "i", q: "2" });
  const answer = cmd({ a: "blur", s: "k", q: "2" }) + cmd({ a: "del", s: "k", q: "2" });
  await page.evaluate((answer) => {
    const term = window.hotty.term as unknown as { write(d: string): void; onData(f: (d: string) => void): void };
    term.onData((d) => {
      if (d === "\x04") term.write(answer);
    });
  }, answer);
  await expect(surface(page, "k").locator("#i")).toBeFocused();
  await page.keyboard.press("Control+d");
  await expect(page.locator(".hotty-surface")).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("x");
  expect((await take(page)).raw).toContain("x");
});
