// A hit asks the browser what is there without moving its pointer (SPEC §9.7).
import { expect, test } from "@playwright/test";
import { delta, open, send, surface, take, write } from "./helpers.ts";

test("hit uses the scrolled document and its window, beneath another surface and in a backdrop", async ({ page }) => {
  await open(page);
  const rows = `<style>body{margin:0}div{height:var(--hotty-cell-h);width:100%}</style>` +
    Array.from({ length: 10 }, (_, i) => `<div id=r${i} data-on=drop>${i}</div>`).join("");
  await send(page, { a: "doc", s: "s", scroll: "1", q: "2" }, rows);
  await send(page, { a: "place", s: "s", c: "10", r: "6", x: "2", y: "1", w: "4", h: "2", C: "1", q: "2" });
  await expect(surface(page, "s").locator("#r0")).toBeAttached();
  await delta(page, { s: "s", q: "2" }, { op: "scroll", v: "scroll-end" });
  await expect.poll(() => surface(page, "s").locator("html").evaluate((el) => el.scrollTop / el.clientHeight)).toBeGreaterThan(0.5);
  await send(page, { a: "doc", s: "cover", q: "2" }, "<button>cover</button>");
  await send(page, { a: "place", s: "cover", c: "10", r: "6", z: "10", C: "1", q: "2" });
  await take(page);
  const hit = async (c: string, r: string) => {
    await send(page, { a: "hit", s: "s", c, r });
    const { msgs, raw } = await take(page);
    expect(raw).toBe("");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.get("re")).toBe("hit");
    return msgs[0]!.body;
  };
  expect(await hit("2", "1")).toEqual({ t: "r5" });
  expect(await hit("1", "1")).toEqual({});
  expect(await hit("2", "3")).toEqual({});
  await send(page, { a: "hide", s: "cover", q: "2" });
  await send(page, { a: "place", s: "s", c: "10", r: "6", b: "1", C: "1", q: "2" });
  expect(await hit("2", "1")).toEqual({ t: "r5" });
  await send(page, { a: "hide", s: "s", q: "2" });
  expect(await hit("2", "1")).toEqual({});
});

test("hit replies during synchronized output and changes no hover or focus", async ({ page }) => {
  await open(page);
  await send(page, { a: "doc", s: "s", q: "2" },
    `<style>body{margin:0}#row{height:var(--hotty-cell-h)}</style><div id=row data-on=drop><input id=f></div>`);
  await send(page, { a: "place", s: "s", c: "30", r: "3", q: "2" });
  await send(page, { a: "focus", s: "s", t: "f", q: "2" });
  await take(page);
  const hovered = () => surface(page, "s").locator("html").evaluate((el) => Array.from(el.ownerDocument.querySelectorAll(":hover"), (n) => n.id));
  const before = await hovered();
  await write(page, "\x1b[?2026h");
  await send(page, { a: "hit", s: "s", c: "1", r: "0" });
  const { msgs } = await take(page);
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.body).toEqual({ t: "row" });
  expect(await hovered()).toEqual(before);
  await expect(surface(page, "s").locator("#f")).toBeFocused();
  await write(page, "\x1b[?2026l");
});
