// Interaction (PROTOCOL §8, Q-0005's lean): the browser does hover, focus and
// editing; the program hears events, and the keys a surface does not use.

import { expect, test } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
import { open, sansArea, send, surface, take, write } from "./helpers.ts";

const evs = (msgs: Awaited<ReturnType<typeof take>>["msgs"]) =>
  msgs.filter((m) => m.get("a") === "ev").map((m) => [m.get("e"), m.get("t"), sansArea(m.json)]);

test("form.py runs unchanged: typing, Tab, Space, a click, Esc, q", async ({ page }, info) => {
  const log = info.outputPath("form-events.jsonl");
  rmSync(log, { force: true });
  await page.goto(`/?run=form&args=${encodeURIComponent(`--log ${log}`)}`);
  const d = surface(page, "form");
  await expect(d.locator("#name")).toBeFocused();
  await page.keyboard.type("Ada Lovelace");
  await page.keyboard.press("Tab");
  await page.keyboard.type("ada@example.com");
  await page.keyboard.press("Tab");
  await page.keyboard.press(" ");
  await d.locator("#save").click();
  await expect(d.locator("#status")).toContainText("saved");
  await page.keyboard.press("Escape");
  await expect(page.locator(".xterm-rows")).toContainText("program has the keyboard");
  await page.keyboard.press("q");
  await expect.poll(() => page.evaluate(() => (window as unknown as { hotty: { exited: boolean } }).hotty.exited)).toBe(true);
  const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const got = lines.filter((l) => l.kind === "event").map((l) => [l.e, l.t, sansArea(l.detail)]);
  // The program focused #name itself: no echo (SPEC §10.1). Each Tab and
  // the click name where focus went, after the change they commit.
  expect(got).toEqual([
    ["change", "name", { value: "Ada Lovelace" }],
    ["focus", "email", null],
    ["change", "email", { value: "ada@example.com" }],
    ["focus", "notify", null],
    ["change", "notify", { checked: true, value: "yes" }],
    ["focus", "save", null],
    ["click", "save", null],
    ["submit", "settings", { name: "Ada Lovelace", email: "ada@example.com", notify: "yes", theme: "dark" }],
    ["blur", "", null],
  ]);
  expect(lines.filter((l) => l.kind === "keys").map((l) => l.data)).toEqual(["\u001b", "q"]);
});

test.describe("without a pty", () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await send(
      page,
      { a: "doc", s: "ui", q: "2" },
      `<button id=b value=v>b</button><button>no id</button><a id=l href="/docs">l</a>
       <span id=s data-on=click>s</span><details><summary id=sum>more</summary>x</details>
       <input id=c type=checkbox value=yes><input id=t data-on=input>
       <form id=f><input name=q value=1><button id=go name=go value=now>go</button></form>`,
    );
    await send(page, { a: "place", s: "ui", c: "60", r: "8", q: "2" });
    await take(page);
  });

  test("clicks, changes, input and submit report with ids", async ({ page }) => {
    const d = surface(page, "ui");
    await d.locator("#b").click();
    await d.getByText("no id").click();
    await d.locator("#l").click();
    await d.locator("#s").click();
    await d.locator("#sum").click();
    await d.locator("#c").click();
    await d.locator("#t").pressSequentially("hi");
    await d.locator("#go").click();
    const got = evs((await take(page)).msgs);
    // Each click on what takes focus names it (SPEC §10.1); the button
    // without an id, and no element around it with one, is focus with no t.
    expect(got).toEqual([
      ["focus", "b", null],
      ["click", "b", { value: "v" }],
      ["focus", "", null],
      ["focus", "l", null],
      ["click", "l", { href: "/docs" }],
      // A span takes no focus: the click gives the keyboard back (§10.1),
      // and the summary takes it again.
      ["blur", "", null],
      ["click", "s", null],
      ["focus", "sum", null],
      ["click", "sum", null],
      ["focus", "c", null],
      ["change", "c", { checked: true, value: "yes" }],
      ["focus", "t", null],
      ["input", "t", { value: "h" }],
      ["input", "t", { value: "hi" }],
      ["change", "t", { value: "hi" }], // committed as focus leaves it
      ["focus", "go", null],
      ["click", "go", { value: "now" }],
      ["submit", "f", { q: "1", go: "now" }],
    ]);
    // The link did not navigate, and <details> opened locally.
    await expect(d.locator("#l")).toBeVisible();
    await expect(d.locator("details")).toHaveAttribute("open", "");
  });

  test("keys the focused control does not use go to the program", async ({ page }) => {
    await send(page, { a: "focus", s: "ui", t: "b", q: "2" });
    await page.keyboard.press("x");
    await page.keyboard.press("ArrowUp");
    await write(page, "\x1b[?1h"); // DECCKM
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Escape"); // the program decides (form.py blurs)
    await send(page, { a: "focus", s: "ui", t: "t", q: "2" });
    await page.keyboard.type("typed");
    const { raw, msgs } = await take(page);
    expect(raw).toBe("x\x1b[A\x1bOA\x03\x1b");
    // No `focus` echoes back for focus the program gave; typing in #t, which
    // asks for them (data-on=input), reports `input` events.
    expect(evs(msgs)).toEqual(["t", "ty", "typ", "type", "typed"].map((v) => ["input", "t", { value: v }]));
  });

  test("keys reach the program in the encoding it enabled: the kitty keyboard protocol", async ({ page }) => {
    // Disambiguate escape codes (flag 1): Escape is CSI 27 u, so a key right
    // after it is not read as Alt+key.
    await write(page, "\x1b[=1;1u");
    await send(page, { a: "focus", s: "ui", t: "b", q: "2" });
    await take(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowDown");
    const { raw } = await take(page);
    expect(raw).toBe("\x1b[27u\x1b[B");
    // The surface kept the keyboard: no blur came back.
    await expect(surface(page, "ui").locator("#b")).toBeFocused();
  });

  test("Tab past the last control gives the keyboard back to the terminal", async ({ page }) => {
    await send(page, { a: "focus", s: "ui", t: "t", q: "2" });
    await page.keyboard.press("Tab"); // → q
    await page.keyboard.press("Tab"); // → go
    await page.keyboard.press("Tab"); // past the last: leave
    const got = evs((await take(page)).msgs);
    expect(got.at(-1)).toEqual(["blur", "", null]);
    expect(await page.evaluate(() => document.activeElement?.className)).toContain("xterm-helper-textarea");
    await page.keyboard.press("z");
    expect((await take(page)).raw).toBe("z");
  });
});

test("p=1: every press in the window is reported, first, until a placement without it", async ({ page }) => {
  await open(page, "?pty=0&record-links");
  await send(
    page,
    { a: "doc", s: "pp", q: "2" },
    `<style>body{margin:0}</style><div id=card><p>plain <b>text</b></p><input id=t></div>` +
      `<a id=h href="https://example.com/" target=_blank>hyper</a><div style="height:40px">nothing with an id</div>`,
  );
  await send(page, { a: "place", s: "pp", c: "60", r: "6", p: "1", q: "2" });
  await take(page);
  const d = surface(page, "pp");
  await d.locator("b").click();
  await d.locator("#t").click();
  await d.getByText("nothing with an id").click();
  // A hyperlink's press is the terminal's: it opens, and is not reported.
  await d.locator("#h").click();
  expect(evs((await take(page)).msgs)).toEqual([
    ["press", "card", null],
    // The press comes before the focus it causes, and before the blur.
    ["press", "t", null],
    ["focus", "t", null],
    ["press", "", null],
    ["blur", "", null],
  ]);
  expect(await page.evaluate(() => [...(window.hotty as unknown as { opened: string[] }).opened])).toEqual(["https://example.com/"]);
  // Placed again without p: no more presses.
  await send(page, { a: "place", s: "pp", c: "60", r: "6", q: "2" });
  await take(page);
  await d.locator("b").click();
  expect(evs((await take(page)).msgs)).toEqual([]);
});
