// The protocol, command by command (SPEC §3-§7), as hotty-blitz's
// tests/host.rs checks it on the other hosts.

import { expect, test, type Page } from "@playwright/test";
import { HOST, VERSION } from "../../src/version.ts";
import { Control, encode } from "../../src/wire.ts";
import { cell, cmd, open, send, surface, take, write } from "./helpers.ts";

test.beforeEach(async ({ page }) => open(page));

test("a=q answers with capabilities", async ({ page }) => {
  await send(page, { a: "q", n: "7" });
  const { msgs } = await take(page);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.get("a")).toBe("ok");
  expect(msgs[0]!.get("n")).toBe("7");
  const caps = msgs[0]!.json as { v: string; ops: string[]; cell: { w: number; h: number }; scroll: boolean; host: string; version: string };
  expect(caps.v).toBe("0.1");
  expect(caps.scroll).toBe(true);
  expect(caps.host).toBe(HOST);
  expect(caps.version).toBe(VERSION);
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
  await send(page, { a: "delta", s: "x", op: "text", t: "nope", q: "1" }, "x");
  await send(page, { a: "delta", s: "x", op: "text", t: "nope", q: "2" }, "x");
  const { msgs } = await take(page);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.get("a")).toBe("err");
  expect((msgs[0]!.json as { code: string }).code).toBe("ENOTARGET");
});

test("delta ops change the document as §6 says", async ({ page }) => {
  await send(page, { a: "doc", s: "x", q: "2" }, "<ul id=list><li id=a>a</li><li id=b>b</li></ul><p id=p style='color: red'>p</p>");
  await send(page, { a: "place", s: "x", c: "40", r: "10", q: "2" });
  const d = surface(page, "x");
  const q = { s: "x", q: "2" };
  await send(page, { a: "delta", ...q, op: "text", t: "a" }, "A");
  await send(page, { a: "delta", ...q, op: "append", t: "list" }, "<li id=c>c</li><li id=b>B</li>");
  await send(page, { a: "delta", ...q, op: "prepend", t: "list" }, "<li id=z>z</li>");
  await send(page, { a: "delta", ...q, op: "attr", t: "p", k: "class" }, "note");
  await send(page, { a: "delta", ...q, op: "unattr", t: "p", k: "style" });
  await send(page, { a: "delta", ...q, op: "var", t: "p", k: "w" }, "42");
  await send(page, { a: "delta", ...q, op: "after", t: "p" }, "<p id=q>q</p>");
  await send(page, { a: "delta", ...q, op: "remove", t: "z" });
  await expect(d.locator("#list li")).toHaveText(["A", "B", "c"]);
  await expect(d.locator("#p")).toHaveAttribute("class", "note");
  await expect(d.locator("#p")).not.toHaveAttribute("style", /color/);
  expect(await d.locator("#p").evaluate((el) => (el as HTMLElement).style.getPropertyValue("--w"))).toBe("42");
  await expect(d.locator("#q")).toHaveText("q");
  // morph by id with no target; a missing id is reported.
  await send(page, { a: "delta", s: "x", op: "morph" }, "<p id=q>Q!</p><p id=missing></p>");
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
  await send(page, { a: "delta", s: "f", t: "f", q: "2" }, "<form id=f><input id=name value='server'><span id=n>1</span></form>");
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
  await send(page, { a: "delta", s: "x", op: "text", t: "p", q: "2" }, "1");
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

test("a window shows part of the surface: the document keeps its size, the pointer hits what shows", async ({ page }) => {
  const { w, h } = await cell(page);
  const rows = Array.from({ length: 8 }, (_, i) => `<button id=b${i} style="display:block;box-sizing:border-box;width:100%;height:var(--hotty-cell-h);border:0;padding:0;margin:0">row ${i}</button>`).join("");
  await send(page, { a: "doc", s: "x", q: "2" }, `<body style="margin:0">${rows}</body>`);
  await write(page, "\x1b[3;5H");
  await send(page, { a: "place", s: "x", c: "20", r: "8", x: "2", y: "2", w: "10", h: "3", q: "2" });
  const box = page.locator('.hotty-surface[data-surface="x"]');
  const bb = (await box.boundingBox())!;
  const screen = (await page.locator(".xterm-screen").boundingBox())!;
  // The window's cells at the cursor, and the cursor below them.
  expect([Math.round((bb.x - screen.x) / w), Math.round((bb.y - screen.y) / h)]).toEqual([4, 2]);
  expect([Math.round(bb.width / w), Math.round(bb.height / h)]).toEqual([10, 3]);
  expect(await page.evaluate(() => window.hotty.term.buffer.active.cursorY)).toBe(5);
  // The document is laid out at the surface's size, whatever shows.
  const d = surface(page, "x");
  const [vw, vh] = await d.locator("body").evaluate(() => [innerWidth, innerHeight]);
  expect(Math.abs(vw - 20 * w)).toBeLessThanOrEqual(1);
  expect(vh).toBe(8 * h);
  // The window's middle row is the surface's row 3.
  await take(page);
  await page.mouse.click(bb.x + bb.width / 2, bb.y + 1.5 * h);
  const { msgs } = await take(page);
  expect(msgs.filter((m) => m.get("e") === "click").map((m) => m.get("t"))).toEqual(["b3"]);
});

test("z stacks overlapping placements, and among equals the surface created later is above", async ({ page }) => {
  const doc = (id: string) => `<button id=${id} style="position:absolute;left:0;top:0;right:0;bottom:0;border:0">${id}</button>`;
  await send(page, { a: "doc", s: "a", q: "2" }, doc("a"));
  await send(page, { a: "doc", s: "b", q: "2" }, doc("b"));
  await write(page, "\x1b[2;2H");
  await send(page, { a: "place", s: "a", c: "10", r: "3", C: "1", q: "2" });
  await send(page, { a: "place", s: "b", c: "10", r: "3", C: "1", q: "2" });
  const bb = (await page.locator('.hotty-surface[data-surface="a"]').boundingBox())!;
  const click = async () => {
    await take(page);
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    const { msgs } = await take(page);
    return msgs.filter((m) => m.get("e") === "click").map((m) => m.get("t"));
  };
  // Both at z 0: b, created later, is above.
  expect(await click()).toEqual(["b"]);
  // a placed again above.
  await send(page, { a: "place", s: "a", c: "10", r: "3", C: "1", z: "1", q: "2" });
  expect(await click()).toEqual(["a"]);
  // z belongs to the placement: placed again without it, a is back at 0.
  await send(page, { a: "place", s: "a", c: "10", r: "3", C: "1", q: "2" });
  expect(await click()).toEqual(["b"]);
  await send(page, { a: "place", s: "b", c: "10", r: "3", C: "1", z: "-1", q: "2" });
  expect(await click()).toEqual(["a"]);
  // Out of range, or not a number: EINVAL.
  await send(page, { a: "place", s: "b", c: "10", r: "3", C: "1", z: "1001" });
  const { msgs } = await take(page);
  expect(msgs.at(-1)!.get("a")).toBe("err");
  expect((msgs.at(-1)!.json as { code: string }).code).toBe("EINVAL");
});

test("a transparent document shows the cells beneath it: the frame's colour scheme is the document's", async ({ page }) => {
  // Red cells, and over them a surface whose background is transparent.
  await write(page, "\x1b[2;2H\x1b[41m" + " ".repeat(20) + "\x1b[m\x1b[3;2H\x1b[41m" + " ".repeat(20) + "\x1b[m\x1b[2;2H");
  await send(page, { a: "doc", s: "t", q: "2" }, "<style>:root, body { background: transparent }</style><p id=p>see through</p>");
  await send(page, { a: "place", s: "t", c: "20", r: "2", C: "1", q: "2" });
  const box = page.locator('.hotty-surface[data-surface="t"]');
  const frame = box.locator("iframe");
  expect(await frame.evaluate((f) => getComputedStyle(f).colorScheme)).toBe("dark");
  // The pixel at the surface's corner, off the text, is the cell's red.
  const bb = (await box.boundingBox())!;
  const png = await page.screenshot({ clip: { x: bb.x + bb.width - 3, y: bb.y + bb.height - 3, width: 1, height: 1 } });
  const [r, g, b] = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = "data:image/png;base64," + data;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }, png.toString("base64"));
  expect(r).toBeGreaterThan(g + 60);
  expect(r).toBeGreaterThan(b + 60);
});

test("hide removes the placement and keeps the document for the next place", async ({ page }) => {
  await send(page, { a: "doc", s: "x", q: "2" }, "<input id=i><p id=p>one</p>");
  await send(page, { a: "place", s: "x", c: "20", r: "2", q: "2" });
  const box = page.locator('.hotty-surface[data-surface="x"]');
  await expect(box).toBeVisible();
  const d = surface(page, "x");
  await d.locator("#i").fill("typed");
  await send(page, { a: "focus", s: "x", t: "i", q: "2" });
  await take(page);
  await send(page, { a: "hide", s: "x" });
  await expect(box).toBeHidden();
  const { msgs } = await take(page);
  // Answered, and the keyboard went back to the terminal.
  expect(msgs.map((m) => [m.get("a"), m.get("re") ?? m.get("e")])).toEqual(
    expect.arrayContaining([["ok", "hide"], ["ev", "blur"]]),
  );
  // Deltas apply while hidden; placing again shows it as it is, input kept.
  await send(page, { a: "delta", s: "x", op: "text", t: "p", q: "2" }, "two");
  await send(page, { a: "place", s: "x", c: "20", r: "2", q: "2" });
  await expect(box).toBeVisible();
  await expect(d.locator("#p")).toHaveText("two");
  await expect(d.locator("#i")).toHaveValue("typed");
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

test("a browser's zoom keeps the font, and the program hears no `resize`", async ({ page }) => {
  // SPEC §5.3. Under a zoom, xterm.js's WebGL and canvas renderers round
  // the cell to device pixels, so the cell in CSS px moves a little with no
  // new font. The DOM renderer here keeps it, so the test moves it as they
  // would, and draws again.
  await send(page, { a: "doc", s: "x", q: "2" }, "<p>x</p>");
  await send(page, { a: "place", s: "x", c: "20", r: "3", q: "2" });
  await take(page);
  await page.evaluate(() => {
    const t = window.hotty.term as unknown as {
      rows: number;
      refresh(a: number, b: number): void;
      _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } };
    };
    const cell = t._core._renderService.dimensions.css.cell;
    cell.width = Math.round(cell.width * 1.1) / 1.1;
    cell.height += 1 / 1.1;
    t.refresh(0, t.rows - 1);
  });
  // Past the addon's 100 ms settling.
  await page.waitForTimeout(400);
  expect((await take(page)).msgs.filter((m) => m.get("e") === "resize")).toEqual([]);
});

/** The `fit` events the program heard (SPEC §5.2), once there are `n`; a
 * few frames later, none more. */
async function fits(page: Page, n: number): Promise<unknown[]> {
  const got: unknown[] = [];
  const poll = async () => {
    for (const m of (await take(page)).msgs) if (m.get("a") === "ev" && m.get("e") === "fit") got.push(m.json);
    return got.length;
  };
  await expect.poll(poll).toBe(n);
  await page.waitForTimeout(100);
  expect(await poll()).toBe(n);
  return got;
}

/** The cell height the addon lays surfaces out with, in CSS pixels. */
const cellH = (page: Page) =>
  page.evaluate(() => (window.hotty.term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { height: number } } } } } })._core._renderService.dimensions.css.cell.height);

test("f=1: the user opening a details is heard as `fit`, and the placement keeps its size", async ({ page }) => {
  const h = await cellH(page);
  await send(
    page,
    { a: "doc", s: "x", q: "2" },
    "<style>body{margin:0} summary{display:block;height:var(--hotty-cell-h)} p{margin:0;height:calc(3 * var(--hotty-cell-h))}</style>" +
      "<details><summary>more</summary><p>three rows</p></details>",
  );
  await send(page, { a: "place", s: "x", c: "20", r: "auto", f: "1" });
  expect((await take(page)).msgs.find((m) => m.get("re") === "place")!.get("r")).toBe("1");
  await surface(page, "x").locator("summary").click();
  expect(await fits(page, 1)).toEqual([{ r: 4 }]);
  expect(Math.round((await page.locator('.hotty-surface[data-surface="x"]').boundingBox())!.height)).toBe(Math.round(h));
});

test("f=1: deltas in one frame are heard once, with the rows drawn", async ({ page }) => {
  await send(page, { a: "doc", s: "x", q: "2" }, `<style>body{margin:0}</style><div id=d style="height: calc(var(--n, 1) * var(--hotty-cell-h))"></div>`);
  await send(page, { a: "place", s: "x", c: "20", r: "auto", f: "1", q: "2" });
  await fits(page, 0);
  const delta = (n: string) => cmd({ a: "delta", s: "x", op: "var", t: "d", k: "n", q: "2" }, n);
  await write(page, delta("3") + delta("5"));
  expect(await fits(page, 1)).toEqual([{ r: 5 }]);
  // Back to what the program heard within a frame: nothing to hear.
  await write(page, delta("2") + delta("5"));
  await fits(page, 0);
});

test("f=1: a new cell size is heard when the rows the document needs change", async ({ page }) => {
  const h0 = await cellH(page);
  await send(page, { a: "doc", s: "x", q: "2" }, "<style>body{margin:0}</style><div style='height: 120px'></div>");
  await send(page, { a: "place", s: "x", c: "20", r: "auto", f: "1" });
  expect((await take(page)).msgs.find((m) => m.get("re") === "place")!.get("r")).toBe(String(Math.ceil(120 / h0)));
  await page.evaluate(() => ((window.hotty.term as unknown as { options: { fontSize: number } }).options.fontSize = 30));
  await expect.poll(() => cellH(page)).toBeGreaterThan(h0 * 1.5);
  const want = Math.ceil(120 / (await cellH(page)));
  expect(want).toBeLessThan(Math.ceil(120 / h0));
  expect(await fits(page, 1)).toEqual([{ r: want }]);
});
