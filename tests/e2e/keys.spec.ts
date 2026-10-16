// The browser's own keys stay the browser's (the browserKeys option): the
// terminal leaves them alone and so does a surface holding the keyboard, so
// reload, zoom and the developer tools work. Every other key is the
// program's. And where the shared vectors do not look: a prefix (SPEC
// §10.5), the program's menu (§10.7) on a surface and in the cells, a paste
// command's text (§10.6).
import { expect, type Page, test } from "@playwright/test";
import { Writer } from "../../src/msgpack.ts";
import { Control, encode } from "../../src/wire.ts";
import { cmd, open, send, surface, take, write } from "./helpers.ts";

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

const evs = (msgs: Awaited<ReturnType<typeof take>>["msgs"]) => msgs.filter((m) => m.get("a") === "ev").map((m) => [m.get("e"), m.get("s"), m.get("t")]);

// A prefix (SPEC §10.5).

const PREFIX = `<style>body{margin:0}button{display:block;margin:0;padding:0;border:0;box-sizing:border-box;font:inherit;height:var(--hotty-cell-h);width:calc(6*var(--hotty-cell-w))}</style>
<main data-keys="Mod+k=prefix"><button id=a>A</button><button id=b data-keys="g=prefix">B</button><input id=f></main>`;

async function prefixed(page: Page, scroll = "") {
  await open(page, "?pty=0");
  await page.evaluate(() => window.hotty.term.focus());
  await send(page, { a: "doc", s: "x", q: "2", ...(scroll ? { scroll } : {}) }, PREFIX);
  await send(page, { a: "place", s: "x", c: "20", r: "3", q: "2" });
  await take(page);
}

test("a key bound to prefix on an ancestor starts one from any element in it, text field included", async ({ page }) => {
  await prefixed(page);
  await send(page, { a: "focus", s: "x", t: "a", q: "2" });
  await page.keyboard.press("Control+k");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Escape");
  await page.keyboard.press("x");
  const { raw, msgs } = await take(page);
  // Control+k, Tab, Shift+Tab (CSI Z), Escape and x: all the program's.
  expect(raw).toBe("\x0b\t\x1b[Z\x1bx");
  expect(evs(msgs)).toEqual([]);
  // The program gives the keys back by focusing, with no t: focus stays where it is.
  await send(page, { a: "focus", s: "x", q: "2" });
  await page.keyboard.press(" ");
  expect(evs((await take(page)).msgs)).toEqual([["click", "x", "a"]]);
  // In a text field, the same: it types nothing until it is given back.
  await send(page, { a: "focus", s: "x", t: "f", q: "2" });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("hi");
  expect((await take(page)).raw).toBe("\x0bhi");
  await send(page, { a: "focus", s: "x", t: "f", q: "2" });
  await page.keyboard.type("ok");
  await expect(surface(page, "x").locator("#f")).toHaveValue("ok");
});

test("a prefix scrolls nothing and ends with the keyboard: a=blur, the surface hidden, the user's press", async ({ page }) => {
  await open(page, "?pty=0");
  await page.evaluate(() => window.hotty.term.focus());
  const rows = Array.from({ length: 12 }, (_, i) => `<div>row ${i}</div>`).join("");
  await send(page, { a: "doc", s: "x", scroll: "1", q: "2" }, `<main id=m tabindex=0 data-keys="g=prefix">${rows}</main><button id=b>b</button>`);
  await send(page, { a: "place", s: "x", c: "20", r: "4", q: "2" });
  await send(page, { a: "focus", s: "x", t: "m", q: "2" });
  const top = () => surface(page, "x").locator("html").evaluate((el) => el.scrollTop);
  await take(page);
  // Not a prefix: the document scrolls with PageDown.
  await page.keyboard.press("PageDown");
  await expect.poll(top).toBeGreaterThan(0);
  expect((await take(page)).raw).toBe("");
  // After one, PageDown is the program's and scrolls nothing.
  const at = await top();
  await page.keyboard.press("g");
  await page.keyboard.press("PageDown");
  expect(await top()).toBe(at);
  expect((await take(page)).raw).toBe("g\x1b[6~");
  // A press that focuses an element ends it; the program hears the focus.
  await surface(page, "x").locator("#b").click();
  expect(evs((await take(page)).msgs)).toEqual([["focus", "x", "b"], ["click", "x", "b"]]);
  await page.keyboard.press("Tab");
  expect(evs((await take(page)).msgs)).toEqual([["blur", "x", undefined]]);
  // Hidden with a prefix on: the keyboard goes back, and a new focus is a fresh start.
  await send(page, { a: "focus", s: "x", t: "m", q: "2" });
  await page.keyboard.press("g");
  await send(page, { a: "hide", s: "x", q: "2" });
  await send(page, { a: "place", s: "x", c: "20", r: "4", q: "2" });
  await send(page, { a: "focus", s: "x", t: "b", q: "2" });
  await take(page);
  await page.keyboard.press("Tab");
  expect(evs((await take(page)).msgs)).toEqual([["blur", "x", undefined]]);
});

// The program's menu (SPEC §10.7): a level of it shown, and its palette.

/** The menu's text, row by row; null when none shows. */
const menu = (page: Page) =>
  page.evaluate(() => {
    const m = document.querySelector<HTMLElement>(".hotty-menu");
    if (!m) return null;
    const rows = [m.firstElementChild as HTMLElement, ...m.querySelectorAll<HTMLElement>(":scope > div:last-child > div > div")];
    return rows.map((r) => r.textContent);
  });

const tree = {
  label: "Buffers",
  items: [
    {
      key: "Control+x",
      label: "Leader",
      enabled: true,
      items: [
        { key: "b", label: "Switch", name: "switch", enabled: true },
        { key: "f", label: "files", enabled: false, items: [{ key: "o", label: "Open", name: "open", enabled: false }] },
      ],
    },
  ],
};

/** The program's menu, and the level of it its keys reach shown. */
const showMenu = async (page: Page, seq = ["Control+x"]) => {
  await write(page, encode(new Control([["a", "menu"]]), new Writer().body(tree).slice()));
  await write(page, encode(new Control([["a", "menu"], ["show", "1"]]), new Writer().body({ seq }).slice()));
};

test("the program's menu shows until it sends none, or a key it does not list, in the cells", async ({ page }) => {
  await open(page, "?pty=0");
  await page.evaluate(() => window.hotty.term.focus());
  await showMenu(page);
  await expect.poll(() => menu(page)).toEqual(["Control+x Leader", "b Switch", "f +files"]);
  // A disabled item is dimmed.
  expect(await page.evaluate(() => (document.querySelector(".hotty-menu > div:last-child > div > div:last-child") as HTMLElement).style.opacity)).toBe("0.5");
  await page.keyboard.press("b");
  expect(await menu(page)).not.toBeNull();
  await page.keyboard.press("q");
  expect(await menu(page)).toBeNull();
  expect((await take(page)).raw).toBe("bq");
  // Escape hides it too, and the key still reaches the program.
  await showMenu(page);
  await expect.poll(() => menu(page)).not.toBeNull();
  await page.keyboard.press("Escape");
  expect(await menu(page)).toBeNull();
  expect((await take(page)).raw).toBe("\x1b");
  // A body that is no menu is EINVAL.
  await page.evaluate(() => window.hotty.write(`\x1b]7279;a=menu;kQE=\x1b\\`));
  const { msgs } = await take(page);
  expect(msgs[0]!.get("a")).toBe("err");
});

test("a program on a surface shows its menu too: Escape and a key it does not list hide it, a key it lists does not, typed to a surface", async ({ page }) => {
  await open(page, "?pty=0");
  await send(page, { a: "doc", s: "x", q: "2" }, `<button id=a data-keys="b=prefix">a</button><input id=f>`);
  await send(page, { a: "place", s: "x", c: "20", r: "3", q: "2" });
  await send(page, { a: "focus", s: "x", t: "a", q: "2" });
  await showMenu(page);
  await expect.poll(() => menu(page)).toEqual(["Control+x Leader", "b Switch", "f +files"]);
  await take(page);
  // A listed key is the program's, after the prefix, and the menu stays.
  await page.keyboard.press("b");
  await page.keyboard.press("f");
  expect(await menu(page)).not.toBeNull();
  expect((await take(page)).raw).toBe("bf");
  await page.keyboard.press("z");
  expect(await menu(page)).toBeNull();
  expect((await take(page)).raw).toBe("z");
  // Escape, in a text field of the surface that uses every other key.
  await showMenu(page);
  await send(page, { a: "focus", s: "x", t: "f", q: "2" });
  await page.keyboard.type("b");
  expect(await menu(page)).not.toBeNull();
  await page.keyboard.type("q");
  expect(await menu(page)).toBeNull();
  await showMenu(page);
  await page.keyboard.press("Escape");
  expect(await menu(page)).toBeNull();
  await expect(surface(page, "x").locator("#f")).toHaveValue("bq");
});

test("a=menu with no body, another screen and a full reset hide the program's menu", async ({ page }) => {
  await open(page, "?pty=0");
  await showMenu(page);
  await expect.poll(() => menu(page)).not.toBeNull();
  await send(page, { a: "menu", q: "2" });
  expect(await menu(page)).toBeNull();
  await showMenu(page);
  await write(page, "\x1b[?1049h");
  expect(await menu(page)).toBeNull();
  await showMenu(page);
  await write(page, "\x1b[?1049l");
  expect(await menu(page)).toBeNull();
  await showMenu(page);
  await write(page, "\x1bc");
  expect(await menu(page)).toBeNull();
});

test("a paste command brings the clipboard's text, from the browser's paste; with none taken the key is the program's", async ({ page, browserName, context }) => {
  test.skip(browserName !== "chromium", "Playwright sets the clipboard in Chromium only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "?pty=0");
  await page.evaluate(() => navigator.clipboard.writeText("hi"));
  await page.evaluate(() => window.hotty.term.focus());
  await send(page, { a: "edit", take: "paste", q: "2" });
  await page.keyboard.press("Control+v");
  await expect.poll(async () => (await take(page)).msgs.map((m) => [m.get("e"), m.body])).toEqual([["command", { name: "paste", key: "Control+v", text: "hi" }]]);
  await send(page, { a: "edit", q: "2" });
  await page.keyboard.press("Control+v");
  // xterm.js's own: ^V, which it sends in place of a paste.
  await expect.poll(async () => (await take(page)).raw).toBe("\x16");
});

test("the capabilities report the key settings and the menu", async ({ page }) => {
  await open(page, "?pty=0");
  await send(page, { a: "q", v: "0.3" });
  const caps = (await take(page)).msgs[0]!.body as Record<string, unknown>;
  expect(caps.mod).toBe("Control");
  expect(caps.edit).toEqual({ "select-all": ["Control+a"], copy: ["Control+c"], cut: ["Control+x"], paste: ["Control+v"], undo: ["Control+z"], redo: ["Control+Z", "Control+y"] });
  expect(caps.features).toContain("menu");
  expect(caps).not.toHaveProperty("keys");
  expect(caps).not.toHaveProperty("menu");
});

test("a menu is kept for each screen; a level shown and the palette go with a change of screen", async ({ page }) => {
  await open(page, "?pty=0");
  type Addon = { openPalette(): void; paletteOpen: boolean; pick(n: string): boolean };
  const addon = (f: (a: Addon) => unknown) => page.evaluate(`(${f})(window.hotty.addon)`);
  await showMenu(page);
  await expect.poll(() => menu(page)).not.toBeNull();
  await addon((a) => a.openPalette());
  expect(await addon((a) => a.paletteOpen)).toBe(true);
  await write(page, "\x1b[?1049h");
  expect(await menu(page)).toBeNull();
  expect(await addon((a) => a.paletteOpen)).toBe(false);
  // The alternate screen has no menu of its own yet: nothing to pick.
  expect(await addon((a) => a.pick("switch"))).toBe(false);
  await send(page, { a: "menu", q: "2" }, new Writer().body({ items: [{ label: "Alt", name: "alt", enabled: true }] }));
  expect(await addon((a) => a.pick("alt"))).toBe(true);
  // Leaving the alternate screen drops its menu; the main screen's stays.
  await write(page, "\x1b[?1049l");
  expect(await addon((a) => a.pick("alt"))).toBe(false);
  expect(await addon((a) => a.pick("switch"))).toBe(true);
  expect((await take(page)).msgs.map((m) => [m.get("e"), m.body])).toEqual([["command", { name: "alt" }], ["command", { name: "switch" }]]);
});

// The palette (SPEC §10.7).

const rowsOf = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".hotty-palette-row"), (r) => [r.firstElementChild!.textContent, r.lastElementChild!.textContent, r.classList.contains("selected"), r.style.opacity === "0.5"]),
  );

test("the palette filters rows, moves with the arrows, picks with Enter and closes on Escape; nothing typed reaches the program", async ({ page }) => {
  await open(page, "?pty=0&palette-key=Mod%2BShift%2Bm");
  await page.evaluate(() => window.hotty.term.focus());
  await write(page, encode(new Control([["a", "menu"]]), new Writer().body({
    label: "Files",
    items: [
      { key: "Control+x", label: "Leader", enabled: true, items: [
        { key: "f", label: "File", enabled: true, items: [
          { key: "n", label: "New file", name: "file-new", enabled: true },
          { key: "r", label: "Rename", name: "file-rename", enabled: false },
        ] },
        { key: "q", label: "Quit", name: "quit", enabled: true },
      ] },
      { label: "Reload", name: "reload", enabled: true },
    ],
  }).slice()));
  await take(page);
  // The palette key opens it; the title is the menu's label.
  await page.keyboard.press("Control+Shift+M");
  await expect(page.locator(".hotty-palette")).toBeVisible();
  await expect(page.locator(".hotty-palette > div:first-child")).toHaveText("Files");
  expect(await rowsOf(page)).toEqual([
    ["Leader › File › New file", "Control+x f n", true, false],
    ["Leader › File › Rename", "Control+x f r", false, true],
    ["Leader › Quit", "Control+x q", false, false],
    ["Reload", "", false, false],
  ]);
  // Typing filters; the selection moves to the first row that is enabled.
  await page.keyboard.type("file REN");
  expect(await rowsOf(page)).toEqual([["Leader › File › Rename", "Control+x f r", false, true]]);
  for (let i = 0; i < 8; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("le ");
  expect((await rowsOf(page)).map((r) => r[0])).toEqual(["Leader › File › New file", "Leader › File › Rename", "Leader › Quit"]);
  // Arrows skip the disabled row; Control+n and Control+p move too.
  await page.keyboard.press("ArrowDown");
  expect((await rowsOf(page)).map((r) => r[2])).toEqual([false, false, true]);
  await page.keyboard.press("Control+p");
  expect((await rowsOf(page)).map((r) => r[2])).toEqual([true, false, false]);
  // The selection stops at the ends.
  await page.keyboard.press("ArrowUp");
  expect((await rowsOf(page)).map((r) => r[2])).toEqual([true, false, false]);
  await page.keyboard.press("Control+n");
  await page.keyboard.press("Control+n");
  expect((await rowsOf(page)).map((r) => r[2])).toEqual([false, false, true]);
  await page.keyboard.press("Enter");
  await expect(page.locator(".hotty-palette")).toHaveCount(0);
  const { msgs, raw } = await take(page);
  expect(msgs.map((m) => [m.get("e"), m.body])).toEqual([["command", { name: "quit" }]]);
  expect(raw).toBe("");
  // Nothing to pick; Escape closes, and the terminal has the keyboard again.
  await page.keyboard.press("Control+Shift+M");
  await page.keyboard.type("zzz");
  await expect(page.locator(".hotty-palette")).toContainText("Nothing to pick");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator(".hotty-palette")).toHaveCount(0);
  await page.keyboard.press("a");
  const after = await take(page);
  expect(after.msgs).toHaveLength(0);
  expect(after.raw).toBe("a");
  // A click on an enabled row picks it; a menu sent while it is open
  // refreshes the rows and keeps the filter.
  await page.keyboard.press("Control+Shift+M");
  await page.keyboard.type("reload");
  await write(page, encode(new Control([["a", "menu"]]), new Writer().body({ items: [{ label: "Reload now", name: "reload", enabled: true }, { label: "Other", name: "other", enabled: true }] }).slice()));
  expect(await rowsOf(page)).toEqual([["Reload now", "", true, false]]);
  await page.locator(".hotty-palette-row").click();
  await expect(page.locator(".hotty-palette")).toHaveCount(0);
  expect((await take(page)).msgs.map((m) => [m.get("e"), m.body])).toEqual([["command", { name: "reload" }]]);
});

test("a pick of paste sends the clipboard's text, and of copy with text selected copies it and sends nothing", async ({ page, browserName, context }) => {
  test.skip(browserName !== "chromium", "Playwright sets the clipboard in Chromium only");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "?pty=0");
  const pick = (n: string) => page.evaluate((n) => (window.hotty as unknown as { addon: { pick(n: string): boolean } }).addon.pick(n), n);
  await write(page, encode(new Control([["a", "menu"]]), new Writer().body({ items: [{ label: "Paste", name: "paste", enabled: true }, { label: "Copy", name: "copy", enabled: true }] }).slice()));
  await page.evaluate(() => navigator.clipboard.writeText("hi"));
  await take(page);
  expect(await pick("paste")).toBe(true);
  await expect.poll(async () => (await take(page)).msgs.map((m) => [m.get("e"), m.body])).toEqual([["command", { name: "paste", text: "hi" }]]);
  await write(page, "selected");
  await page.evaluate(() => (window.hotty.term as unknown as { selectAll(): void }).selectAll());
  expect(await pick("copy")).toBe(true);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("selected");
  expect((await take(page)).msgs).toHaveLength(0);
});
