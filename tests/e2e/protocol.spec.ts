// The protocol, command by command (SPEC §3-§7), as hotty-blitz's
// tests/host.rs checks it on the other hosts.

import { expect, test } from "@playwright/test";
import { Control, encode } from "../../src/wire.ts";
import { cell, open, send, surface, take, write } from "./helpers.ts";

test.beforeEach(async ({ page }) => open(page));

test("a=q answers with capabilities", async ({ page }) => {
  await send(page, { a: "q", n: "7" });
  const { msgs } = await take(page);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.get("a")).toBe("ok");
  expect(msgs[0]!.get("n")).toBe("7");
  const caps = msgs[0]!.json as { v: string; ops: string[]; cell: { w: number; h: number } };
  expect(caps.v).toBe("0.1");
  expect(caps.ops).toContain("morph");
  expect(caps.cell.h).toBeGreaterThan(0);
});

test("r=auto fits the content and reports its rows", async ({ page }) => {
  const { h } = await cell(page);
  await send(page, { a: "doc", s: "x" }, "<div style='height: 95px'>tall</div>");
  await send(page, { a: "place", s: "x", c: "30" });
  const { msgs } = await take(page);
  const placed = msgs.find((m) => m.get("re") === "place")!;
  expect(placed.get("r")).toBe(String(Math.ceil(95 / h)));
  await expect(surface(page, "x").locator("div")).toHaveText("tall");
});

test("a missing target is an error, and q quiets replies", async ({ page }) => {
  await send(page, { a: "doc", s: "x", q: "1" }, "<p id=p>hi</p>");
  await send(page, { a: "patch", s: "x", op: "text", t: "nope", q: "1" }, "x");
  await send(page, { a: "patch", s: "x", op: "text", t: "nope", q: "2" }, "x");
  const { msgs } = await take(page);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.get("a")).toBe("err");
  expect((msgs[0]!.json as { code: string }).code).toBe("ENOTARGET");
});

test("patch ops change the document as §5 says", async ({ page }) => {
  await send(page, { a: "doc", s: "x", q: "2" }, "<ul id=list><li id=a>a</li><li id=b>b</li></ul><p id=p style='color: red'>p</p>");
  await send(page, { a: "place", s: "x", c: "40", r: "10", q: "2" });
  const d = surface(page, "x");
  const q = { s: "x", q: "2" };
  await send(page, { a: "patch", ...q, op: "text", t: "a" }, "A");
  await send(page, { a: "patch", ...q, op: "append", t: "list" }, "<li id=c>c</li><li id=b>B</li>");
  await send(page, { a: "patch", ...q, op: "prepend", t: "list" }, "<li id=z>z</li>");
  await send(page, { a: "patch", ...q, op: "attr", t: "p", k: "class" }, "note");
  await send(page, { a: "patch", ...q, op: "unattr", t: "p", k: "style" });
  await send(page, { a: "patch", ...q, op: "var", t: "p", k: "w" }, "42");
  await send(page, { a: "patch", ...q, op: "after", t: "p" }, "<p id=q>q</p>");
  await send(page, { a: "patch", ...q, op: "remove", t: "z" });
  await expect(d.locator("#list li")).toHaveText(["A", "B", "c"]);
  await expect(d.locator("#p")).toHaveAttribute("class", "note");
  await expect(d.locator("#p")).not.toHaveAttribute("style", /color/);
  expect(await d.locator("#p").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--w"))).toBe("42");
  await expect(d.locator("#q")).toHaveText("q");
  // morph by id with no target; a missing id is reported.
  await send(page, { a: "patch", s: "x", op: "morph" }, "<p id=q>Q!</p><p id=missing></p>");
  const { msgs } = await take(page);
  expect(msgs.at(-1)!.get("a")).toBe("err");
  expect((msgs.at(-1)!.json as { detail: string }).detail).toBe("missing");
  await expect(d.locator("#q")).toHaveText("Q!");
});

test("morph keeps element identity and what the user typed", async ({ page }) => {
  await send(page, { a: "doc", s: "f", q: "2" }, "<form id=f><input id=name value=''><span id=n>0</span></form>");
  await send(page, { a: "place", s: "f", c: "40", r: "4", q: "2" });
  await send(page, { a: "focus", s: "f", t: "name", q: "2" });
  await page.keyboard.type("Ada");
  const before = await surface(page, "f").locator("#name").evaluate((el) => ((el as unknown as { mark: number }).mark = 1));
  await send(page, { a: "patch", s: "f", t: "f", q: "2" }, "<form id=f><input id=name value='server'><span id=n>1</span></form>");
  const input = surface(page, "f").locator("#name");
  expect(await input.evaluate((el) => (el as unknown as { mark: number }).mark)).toBe(before);
  await expect(input).toHaveValue("Ada");
  await expect(surface(page, "f").locator("#n")).toHaveText("1");
  // The program takes the keyboard back: the edit commits as `change`, then `blur`.
  await send(page, { a: "blur", s: "f", q: "2" });
  const { msgs } = await take(page);
  const evs = msgs.filter((m) => m.get("a") === "ev").map((m) => [m.get("e"), m.get("t"), m.body]);
  expect(evs).toEqual([["change", "name", JSON.stringify({ value: "Ada" })], ["blur", "", ""]]);
});

test("a stylesheet resource that arrives after the document restyles it", async ({ page }) => {
  await send(page, { a: "doc", s: "x", q: "2" }, "<link rel=stylesheet href=cid:theme><p id=p>styled</p>");
  await send(page, { a: "place", s: "x", c: "30", r: "3", q: "2" });
  const p = surface(page, "x").locator("#p");
  await expect(p).not.toHaveCSS("color", "rgb(255, 0, 0)");
  await send(page, { a: "res", id: "theme", type: "text/css", q: "2" }, "#p { color: rgb(255, 0, 0) }");
  await expect(p).toHaveCSS("color", "rgb(255, 0, 0)");
  // Replacing it restyles again; a morph still sees the program's href.
  await send(page, { a: "res", id: "theme", type: "text/css", q: "2" }, "#p { color: rgb(0, 128, 0) }");
  await expect(p).toHaveCSS("color", "rgb(0, 128, 0)");
});

test("cid: images and stylesheets that name them resolve", async ({ page }) => {
  // A 1×1 red PNG, sent as bytes.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  await write(page, encode(new Control([["a", "res"], ["id", "dot"], ["type", "image/png"], ["q", "2"]]), new Uint8Array(png)));
  await send(page, { a: "doc", s: "x", q: "2" }, "<img id=i src=cid:dot width=20 height=20><div id=b style='width:20px;height:20px;background:url(cid:dot)'></div>");
  await send(page, { a: "place", s: "x", c: "20", r: "3", q: "2" });
  const img = surface(page, "x").locator("#i");
  await expect(img).toHaveAttribute("src", /^blob:/);
  expect(await img.evaluate((el) => (el as HTMLImageElement).decode().then(() => (el as HTMLImageElement).naturalWidth))).toBe(1);
  await expect(surface(page, "x").locator("#b")).toHaveAttribute("style", /url\("blob:/);
  // Deleting the resource fails its references closed.
  await send(page, { a: "del", id: "dot", q: "2" });
  await expect(img).toHaveAttribute("src", "about:invalid");
});

test("synchronized output holds a batch until it ends", async ({ page }) => {
  await send(page, { a: "doc", s: "x", q: "2" }, "<p id=p>0</p>");
  await send(page, { a: "place", s: "x", c: "20", r: "2", q: "2" });
  const p = surface(page, "x").locator("#p");
  await write(page, "\x1b[?2026h");
  await send(page, { a: "patch", s: "x", op: "text", t: "p", q: "2" }, "1");
  await expect(p).toHaveText("0");
  await write(page, "\x1b[?2026l");
  await expect(p).toHaveText("1");
});

test("place puts the surface at the cursor and moves the cursor below it, unless C=1", async ({ page }) => {
  const { w, h } = await cell(page);
  await write(page, "\x1b[3;5H");
  await send(page, { a: "doc", s: "x", q: "2" }, "<p>x</p>");
  await send(page, { a: "place", s: "x", c: "10", r: "4", q: "2" });
  const box = page.locator('.hotty-surface[data-surface="x"]');
  const bb = (await box.boundingBox())!;
  const screen = (await page.locator(".xterm-screen").boundingBox())!;
  expect(Math.round((bb.x - screen.x) / w)).toBe(4);
  expect(Math.round((bb.y - screen.y) / h)).toBe(2);
  expect(await page.evaluate(() => [window.hotty.term.buffer.active.cursorX, window.hotty.term.buffer.active.cursorY])).toEqual([0, 6]);
  await send(page, { a: "place", s: "x", c: "10", r: "4", C: "1", q: "2" });
  expect(await page.evaluate(() => window.hotty.term.buffer.active.cursorY)).toBe(6);
});

test("a surface scrolls with the text and dies when its line leaves the scrollback", async ({ page }) => {
  const { h } = await cell(page);
  await write(page, "\x1b[5;1H");
  await send(page, { a: "doc", s: "x", q: "2" }, "<p>x</p>");
  await send(page, { a: "place", s: "x", c: "10", r: "2", q: "2" });
  const box = page.locator('.hotty-surface[data-surface="x"]');
  const top = async () => Math.round(((await box.boundingBox())!.y - (await page.locator(".xterm-screen").boundingBox())!.y) / h);
  expect(await top()).toBe(4);
  const rows = await page.evaluate(() => window.hotty.term.rows);
  // Scrolling the screen by 3 lines moves the surface up by 3.
  await write(page, `\x1b[${rows};1H` + "\r\n".repeat(3));
  expect(await top()).toBe(1);
  // Scrolled out of view it hides, and scrolling the viewport back shows it.
  await write(page, "\r\n".repeat(rows));
  await expect(box).toBeHidden();
  await page.evaluate((n) => (window.hotty.term as unknown as { scrollLines(n: number): void }).scrollLines(-n), rows);
  await expect(box).toBeVisible();
  await page.evaluate(() => (window.hotty.term as unknown as { scrollToBottom(): void }).scrollToBottom());
  // Past the scrollback (1000 lines by default) its line is gone, and so is the placement.
  await write(page, "\r\n".repeat(1100));
  await page.evaluate(() => (window.hotty.term as unknown as { scrollToTop(): void }).scrollToTop());
  await expect(box).toBeHidden();
  // The surface's document is still there to be placed again.
  await send(page, { a: "place", s: "x", c: "10", r: "2", q: "2" });
  await page.evaluate(() => (window.hotty.term as unknown as { scrollToBottom(): void }).scrollToBottom());
  await expect(box).toBeVisible();
});

test("surfaces on the alternate screen die with it; RIS removes every surface", async ({ page }) => {
  await write(page, "\x1b[?1049h");
  await send(page, { a: "doc", s: "alt", q: "2" }, "<p>alt</p>");
  await send(page, { a: "place", s: "alt", c: "10", r: "2", q: "2" });
  await expect(page.locator('.hotty-surface[data-surface="alt"]')).toBeVisible();
  await write(page, "\x1b[?1049l");
  await expect(page.locator('.hotty-surface[data-surface="alt"]')).toHaveCount(0);
  await send(page, { a: "doc", s: "y", q: "2" }, "<p>y</p>");
  await write(page, "\x1bc");
  await expect(page.locator(".hotty-surface")).toHaveCount(0);
});

test("zlib payloads and chunked commands decode", async ({ page }) => {
  const { OSC } = await import("../../src/wire.ts");
  const { deflateSync } = await import("node:zlib");
  const html = "<p id=p>" + "long ".repeat(4000) + "</p>";
  const b64 = deflateSync(Buffer.from(html)).toString("base64");
  let stream = "";
  for (let i = 0; i < b64.length; i += 4096) {
    const first = i === 0;
    const last = i + 4096 >= b64.length;
    const ctl = first ? `a=doc:s=z:o=z:q=2${last ? "" : ":m=1"}` : `m=${last ? 0 : 1}`;
    stream += `\x1b]${OSC};${ctl};${b64.slice(i, i + 4096)}\x1b\\`;
  }
  await write(page, stream);
  await send(page, { a: "place", s: "z", c: "40", r: "2", q: "2" });
  expect((await surface(page, "z").locator("#p").textContent())!.length).toBe(5 * 4000);
});

test("a font or theme change re-lays out every surface, and the program hears `resize`", async ({ page }) => {
  await send(page, { a: "doc", s: "x", q: "2" }, "<p id=p>x</p>");
  await send(page, { a: "place", s: "x", c: "20", r: "3", q: "2" });
  await take(page);
  const box = page.locator('.hotty-surface[data-surface="x"]');
  const w0 = (await box.boundingBox())!.width;
  await page.evaluate(() => {
    const t = window.hotty.term as unknown as { options: { fontSize: number; theme: object } };
    t.options.fontSize = 22;
    t.options.theme = { ...t.options.theme, background: "#fdf6e3", foreground: "#073642" };
  });
  // The cell size the addon uses (a=q reports it rounded to device pixels).
  const cssCell = () =>
    page.evaluate(() => (window.hotty.term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number } } } } } })._core._renderService.dimensions.css.cell.width);
  await expect.poll(async () => Math.round((await box.boundingBox())!.width) - Math.round(20 * (await cssCell()))).toBe(0);
  expect((await box.boundingBox())!.width).toBeGreaterThan(w0);
  const root = surface(page, "x").locator("html");
  await expect.poll(() => root.evaluate((el) => getComputedStyle(el).getPropertyValue("--hotty-bg").trim())).toBe("#fdf6e3");
  await expect.poll(() => root.evaluate((el) => getComputedStyle(el).colorScheme)).toBe("light");
  await expect.poll(async () => (await take(page)).msgs.some((m) => m.get("e") === "resize")).toBe(true);
});
