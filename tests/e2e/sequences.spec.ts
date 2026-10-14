// Key sequences, edit commands and menus (SPEC §10.5, §10.6) where the
// shared vectors do not look: the which-key menus the addon draws, a wait
// that times out, and a paste command's text.
import { expect, type Page, test } from "@playwright/test";
import { open, send, take, write } from "./helpers.ts";
import { Writer } from "../../src/msgpack.ts";
import { Control, encode } from "../../src/wire.ts";

const DOC = `<div id=k tabindex=0>k</div>
<menu data-key="<leader> f" aria-label=File>
  <button id=new data-key=n>New file</button>
  <button id=open data-key=o aria-label="Open…">o</button>
  <button disabled data-key=d>Delete</button>
</menu>
<button id=top data-key="g g" hidden>Top</button>`;

/** The menu's text, row by row; null when none shows. */
const menu = (page: Page) =>
  page.evaluate(() => {
    const m = document.querySelector<HTMLElement>(".hotty-menu");
    if (!m) return null;
    const rows = [m.firstElementChild as HTMLElement, ...m.querySelectorAll<HTMLElement>(":scope > div:last-child > div > div")];
    return rows.map((r) => r.textContent);
  });

async function setup(page: Page, query = "?pty=0") {
  await open(page, query);
  await send(page, { a: "doc", s: "x", q: "2" }, DOC);
  await send(page, { a: "place", s: "x", c: "20", r: "6", q: "2" });
  await send(page, { a: "focus", s: "x", t: "k", q: "2" });
  await take(page);
}

test("a sequence that waits shows its menu a moment later, the next level replaces it, and running hides it", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("Space");
  expect(await menu(page)).toBeNull();
  await expect.poll(() => menu(page)).toEqual(["Space", "f +File"]);
  await page.keyboard.press("f");
  expect(await menu(page)).toEqual(["Space f File", "n New file", "o Open…", "d Delete"]);
  // The disabled one is dimmed.
  expect(await page.evaluate(() => (document.querySelector(".hotty-menu > div:last-child > div > div:last-child") as HTMLElement).style.opacity)).toBe("0.5");
  await page.keyboard.press("o");
  expect(await menu(page)).toBeNull();
  const { msgs, raw } = await take(page);
  expect(msgs.map((m) => [m.get("e"), m.get("t")])).toEqual([["click", "open"]]);
  expect(raw).toBe("");
});

test("a wait that times out runs the sequence it finishes, or lets its keys go on", async ({ page }) => {
  await setup(page, "?pty=0&key-timeout=200");
  await page.keyboard.press("g");
  await page.waitForTimeout(400);
  expect((await take(page)).raw).toBe("g");
  await page.keyboard.press("Space");
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  // `Space f` finishes none: Space and f go on, to an element that uses
  // neither.
  expect((await take(page)).raw).toBe(" f");
  expect(await menu(page)).toBeNull();
});

test("the program's menu shows until it sends none, or a key it does not list", async ({ page }) => {
  await open(page, "?pty=0");
  await page.evaluate(() => window.hotty.term.focus());
  const body = new Writer().body({ seq: ["Control+x"], label: "Buffers", items: [{ key: "b", label: "Switch", group: false, enabled: true }] });
  await write(page, encode(new Control([["a", "menu"]]), body.slice()));
  await expect.poll(() => menu(page)).toEqual(["Control+x Buffers", "b Switch"]);
  await page.keyboard.press("b");
  expect(await menu(page)).not.toBeNull();
  await page.keyboard.press("q");
  expect(await menu(page)).toBeNull();
  expect((await take(page)).raw).toBe("bq");
  // A body that is no menu is EINVAL.
  await page.evaluate(() => window.hotty.write(`\x1b]7279;a=menu;kQE=\x1b\\`));
  const { msgs } = await take(page);
  expect(msgs[0]!.get("a")).toBe("err");
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

test("the capabilities report the keys", async ({ page }) => {
  await open(page, "?pty=0&key-timeout=1500");
  await send(page, { a: "q", v: "0.2" });
  const caps = (await take(page)).msgs[0]!.body as Record<string, unknown>;
  expect(caps.mod).toBe("Control");
  expect(caps.edit).toEqual({ "select-all": ["Control+a"], copy: ["Control+c"], cut: ["Control+x"], paste: ["Control+v"], undo: ["Control+z"], redo: ["Control+Z", "Control+y"] });
  expect(caps.keys).toEqual({ leader: "Space", timeout: 1500 });
  expect(caps.menu).toBe(true);
  expect(caps.events).toEqual(expect.arrayContaining(["command", "caps"]));
});
