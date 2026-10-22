// The browser's own keys stay the browser's (the browserKeys option): the
// terminal leaves them alone and so does a surface holding the keyboard, so
// reload, zoom and the developer tools work. Every other key is the
// program's. And where the shared vectors do not look: a prefix (SPEC
// §10.5), the program's menu (§10.7) on a surface and in the cells, a paste
// command's text (§10.6).
import { expect, type Page, test } from "@playwright/test";
import { Writer } from "../../src/msgpack.ts";
import { Control, encode } from "../../src/wire.ts";
import type { MenuEntry } from "../../src/menu.ts";
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
<main data-keys="mod+k=prefix"><button id=a>A</button><button id=b data-keys="g=prefix">B</button><input id=f></main>`;

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

// The program's menu (SPEC §10.7): a level of it shown, and its items for
// the page.

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
      key: "ctrl+x",
      label: "Leader",
      enabled: true,
      items: [
        { key: "b", label: "Switch", name: "switch", enabled: true },
        { key: "f", label: "files", enabled: false, items: [{ key: "o", label: "Open", name: "open", enabled: false }] },
      ],
    },
  ],
};

/** The alpha of an element's background: below 1, so that Chromium does not
 * cull the cells under it, and at the wrong place (boxBackground). */
const alpha = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const c = getComputedStyle(document.querySelector(s)!).backgroundColor;
    const m = /[/,]\s*([\d.]+)\)$/.exec(c);
    return m ? Number(m[1]) : 1;
  }, selector);

/** The program's menu, and the level of it its keys reach shown. */
const showMenu = async (page: Page, seq = ["ctrl+x"]) => {
  await write(page, encode(new Control([["a", "menu"]]), new Writer().body(tree).slice()));
  await write(page, encode(new Control([["a", "menu"], ["show", "1"]]), new Writer().body({ seq }).slice()));
};

/** What the addon gives the page for the menu, called in the page. */
type Addon = { menuItems(): MenuEntry[]; pick(n: string): boolean };
const addon = <T>(page: Page, f: (a: Addon) => T) => page.evaluate(`(${f})(window.hotty.addon)`) as Promise<T>;

test("the program's menu shows until it sends none, or a key it does not list, in the cells", async ({ page }) => {
  await open(page, "?pty=0");
  await page.evaluate(() => window.hotty.term.focus());
  await showMenu(page);
  await expect.poll(() => menu(page)).toEqual(["ctrl+x Leader", "b Switch", "f +files"]);
  // A disabled item is dimmed.
  expect(await page.evaluate(() => (document.querySelector(".hotty-menu > div:last-child > div > div:last-child") as HTMLElement).style.opacity)).toBe("0.5");
  // A hair short of opaque.
  expect(await alpha(page, ".hotty-menu")).toBeGreaterThan(0.99);
  expect(await alpha(page, ".hotty-menu")).toBeLessThan(1);
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
  await expect.poll(() => menu(page)).toEqual(["ctrl+x Leader", "b Switch", "f +files"]);
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
  await expect.poll(async () => (await take(page)).msgs.map((m) => [m.get("e"), m.body])).toEqual([["command", { name: "paste", key: "ctrl+v", text: "hi" }]]);
  await send(page, { a: "edit", q: "2" });
  await page.keyboard.press("Control+v");
  // xterm.js's own: ^V, which it sends in place of a paste.
  await expect.poll(async () => (await take(page)).raw).toBe("\x16");
});

test("the capabilities report the key settings and the menu", async ({ page }) => {
  await open(page, "?pty=0");
  await send(page, { a: "q", v: "0.5" });
  const caps = (await take(page)).msgs[0]!.body as Record<string, unknown>;
  expect(caps.mod).toBe("ctrl");
  expect(caps.edit).toEqual({ "select-all": ["ctrl+a"], copy: ["ctrl+c"], cut: ["ctrl+x"], paste: ["ctrl+v"], undo: ["ctrl+z"], redo: ["ctrl+shift+z", "ctrl+y"] });
  expect(caps.features).toContain("menu");
  expect(caps).not.toHaveProperty("keys");
  expect(caps).not.toHaveProperty("menu");
});

test("a menu is kept for each screen; a level shown goes with a change of screen, and menuItems() and pick() follow it", async ({ page }) => {
  await open(page, "?pty=0");
  await showMenu(page);
  await expect.poll(() => menu(page)).not.toBeNull();
  expect((await addon(page, (a) => a.menuItems())).map((e) => e.name)).toEqual(["switch", "open"]);
  await write(page, "\x1b[?1049h");
  expect(await menu(page)).toBeNull();
  // The alternate screen has no menu of its own yet: nothing to list or pick.
  expect(await addon(page, (a) => a.menuItems())).toEqual([]);
  expect(await addon(page, (a) => a.pick("switch"))).toBe(false);
  await send(page, { a: "menu", q: "2" }, new Writer().body({ items: [{ label: "Alt", name: "alt", enabled: true }] }));
  expect(await addon(page, (a) => a.menuItems())).toEqual([{ name: "alt", label: "Alt", keys: "", enabled: true }]);
  expect(await addon(page, (a) => a.pick("alt"))).toBe(true);
  // Leaving the alternate screen drops its menu; the main screen's stays.
  await write(page, "\x1b[?1049l");
  expect((await addon(page, (a) => a.menuItems())).map((e) => e.name)).toEqual(["switch", "open"]);
  expect(await addon(page, (a) => a.pick("alt"))).toBe(false);
  expect(await addon(page, (a) => a.pick("switch"))).toBe(true);
  expect((await take(page)).msgs.map((m) => [m.get("e"), m.body])).toEqual([["command", { name: "alt" }], ["command", { name: "switch" }]]);
});

// What a page's own command palette lists and picks (SPEC §10.7): the addon
// draws none.

test("menuItems() lists the named items under their groups' labels with their keys; pick() sends command with the name, and nothing for a disabled item, an unknown name or no menu", async ({ page }) => {
  await open(page, "?pty=0");
  await page.evaluate(() => window.hotty.term.focus());
  // No menu: nothing to list or pick.
  expect(await addon(page, (a) => a.menuItems())).toEqual([]);
  expect(await addon(page, (a) => a.pick("quit"))).toBe(false);
  await write(page, encode(new Control([["a", "menu"]]), new Writer().body({
    label: "Files",
    items: [
      { key: "mod+x", label: "Leader", enabled: true, items: [
        { key: "f", label: "File", enabled: true, items: [
          { key: "n", label: "New file", name: "file-new", enabled: true },
          { key: "r", label: "Rename", name: "file-rename", enabled: false },
        ] },
        { key: "q", label: "Quit", name: "quit", enabled: true },
      ] },
      { label: "Reload", name: "reload", enabled: true },
      { key: "g", name: "go", enabled: true },
    ],
  }).slice()));
  await take(page);
  // mod as the platform reads it; a group's items under its label; no keys
  // for an item no key reaches, and the name for one with no label.
  expect(await addon(page, (a) => a.menuItems())).toEqual([
    { name: "file-new", label: "Leader › File › New file", keys: "ctrl+x f n", enabled: true },
    { name: "file-rename", label: "Leader › File › Rename", keys: "ctrl+x f r", enabled: false },
    { name: "quit", label: "Leader › Quit", keys: "ctrl+x q", enabled: true },
    { name: "reload", label: "Reload", keys: "", enabled: true },
    { name: "go", label: "go", keys: "g", enabled: true },
  ]);
  // A pick sends command with the name and no key, and types nothing; a
  // disabled item, a name no item has, and no name pick nothing.
  expect(await addon(page, (a) => a.pick("quit"))).toBe(true);
  expect(await addon(page, (a) => a.pick("reload"))).toBe(true);
  expect(await addon(page, (a) => a.pick("file-rename"))).toBe(false);
  expect(await addon(page, (a) => a.pick("nothing"))).toBe(false);
  expect(await addon(page, (a) => a.pick(""))).toBe(false);
  const { msgs, raw } = await take(page);
  expect(msgs.map((m) => [m.get("e"), m.body])).toEqual([["command", { name: "quit" }], ["command", { name: "reload" }]]);
  expect(raw).toBe("");
  // A new menu is the items; a=menu with no body leaves none.
  await write(page, encode(new Control([["a", "menu"]]), new Writer().body({ items: [{ label: "Reload now", name: "reload", enabled: true }, { label: "Other", name: "other" }] }).slice()));
  expect(await addon(page, (a) => a.menuItems())).toEqual([
    { name: "reload", label: "Reload now", keys: "", enabled: true },
    { name: "other", label: "Other", keys: "", enabled: false },
  ]);
  expect(await addon(page, (a) => a.pick("other"))).toBe(false);
  await send(page, { a: "menu", q: "2" });
  expect(await addon(page, (a) => a.menuItems())).toEqual([]);
  expect(await addon(page, (a) => a.pick("reload"))).toBe(false);
  expect((await take(page)).msgs).toHaveLength(0);
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

// A press given to the program as pressed stays the program's as bytes
// (SPEC §10.4): by the physical name, in a field that selects all with ctrl+a.

test("ctrl+key_a bound to program or prefix sends ctrl+a to the program; a prefix then gives it x", async ({ page }) => {
  await open(page, "?pty=0");
  await page.evaluate(() => window.hotty.term.focus());
  await send(page, { a: "doc", s: "x", q: "2" }, `<input id=a data-on=input value=ab data-keys="ctrl+key_a=program"><input id=b data-on=input data-keys="ctrl+key_a=prefix">`);
  await send(page, { a: "place", s: "x", c: "20", r: "3", q: "2" });
  await send(page, { a: "focus", s: "x", t: "a", q: "2" });
  await take(page);
  await page.keyboard.press("Control+a");
  expect((await take(page)).raw).toBe("\x01");
  // The field did not select all: typing appends.
  await page.keyboard.press("End");
  await page.keyboard.press("c");
  expect(evs((await take(page)).msgs)).toEqual([["input", "x", "a"]]);
  await send(page, { a: "focus", s: "x", t: "b", q: "2" });
  await take(page);
  await page.keyboard.press("Control+a");
  expect((await take(page)).raw).toBe("\x01");
  await page.keyboard.press("x");
  const { raw, msgs } = await take(page);
  expect(raw).toBe("x");
  expect(evs(msgs)).toEqual([]);
});
