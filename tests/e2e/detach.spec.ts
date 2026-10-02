// Who has the keyboard (SPEC §10.1), and detached surfaces (§5.5): a click
// takes the keyboard only by focusing an element that takes focus, and a
// surface the program is done with reports nothing, never has the keyboard,
// and keeps only what is local. Events arrive on whatever reads the
// terminal's input: after the program exits, a shell would read them as
// typed text.

import { expect, test, type Page } from "@playwright/test";
import { open, send, surface, take } from "./helpers.ts";

const evs = (msgs: Awaited<ReturnType<typeof take>>["msgs"]) =>
  msgs.filter((m) => m.get("a") === "ev").map((m) => [m.get("e"), m.get("t"), m.json]);

/** The terminal has the browser's focus (the surface gave it back). */
async function terminalHasKeyboard(page: Page) {
  await expect.poll(() => page.evaluate(() => document.activeElement?.className ?? "")).toContain("xterm-helper-textarea");
}

/** A press, a move and a release, from one point in the page to another.
 * In Chromium through CDP: Playwright's own drag handling there stalls on a
 * press that moves inside a frame without scripts. */
async function drag(page: Page, browser: string, x0: number, x1: number, y: number) {
  if (browser !== "chromium") {
    await page.mouse.move(x0, y);
    await page.mouse.down();
    await page.mouse.move(x1, y, { steps: 10 });
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  const at = (type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, buttons: number) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
  await at("mouseMoved", x0, 0);
  await at("mousePressed", x0, 1);
  await page.waitForTimeout(30); // the press has settled: the terminal has the keyboard back
  for (let i = 1; i <= 10; i++) await at("mouseMoved", x0 + ((x1 - x0) * i) / 10, 1);
  await at("mouseReleased", x1, 0);
  await cdp.detach();
}

async function place(page: Page, s: string, html: string, extra: Record<string, string> = {}) {
  await send(page, { a: "doc", s, q: "2", ...extra }, html);
  await send(page, { a: "place", s, c: "60", r: "8", q: "2" });
  await take(page);
}

const opened = (page: Page) => page.evaluate(() => [...(window.hotty as unknown as { opened: string[] }).opened]);

test.describe("§10.1: a click takes the keyboard only through an element that takes focus", () => {
  test.beforeEach(async ({ page }) => open(page, "?pty=0&record-links"));

  test("a click on text takes nothing: no focus, and the terminal keeps the keyboard", async ({ page }) => {
    await place(page, "p", `<p id=p>printed text</p><div id=neg tabindex=-1>tabindex -1</div><span id=s data-on=click>s</span><button id=b>b</button>`);
    await page.evaluate(() => window.hotty.term.focus());
    const d = surface(page, "p");
    await d.locator("#p").click();
    await d.locator("#neg").click();
    // An element that asks for clicks reports them, and still takes no focus.
    await d.locator("#s").click();
    await terminalHasKeyboard(page);
    await page.keyboard.press("x");
    const { msgs, raw } = await take(page);
    expect(evs(msgs)).toEqual([["click", "s", null]]);
    expect(raw).toBe("x");
    // A button takes focus, and the keyboard with it.
    await d.locator("#b").click();
    expect(evs((await take(page)).msgs)).toEqual([["focus", "", null], ["click", "b", null]]);
  });

  test("a click on what takes no focus gives the keyboard back: the control commits, then blur", async ({ page }) => {
    await place(page, "f", `<p id=p>label text</p><input id=i>`);
    const d = surface(page, "f");
    await d.locator("#i").click();
    await page.keyboard.type("Ada");
    expect(evs((await take(page)).msgs)).toEqual([["focus", "", null]]);
    await d.locator("#p").click();
    await terminalHasKeyboard(page);
    await page.keyboard.press("y");
    const { msgs, raw } = await take(page);
    expect(evs(msgs)).toEqual([["change", "i", { value: "Ada" }], ["blur", "", null]]);
    expect(raw).toBe("y");
  });

  test("a hyperlink takes nothing: it opens, and the program hears no focus; another link takes the keyboard", async ({ page }) => {
    await place(page, "h", `<input id=i><a id=hyper target=_blank href="https://example.com/x">hyper</a> <a id=own href="/own">own</a>`);
    await page.evaluate(() => window.hotty.term.focus());
    const d = surface(page, "h");
    await d.locator("#hyper").click();
    await terminalHasKeyboard(page);
    expect(evs((await take(page)).msgs)).toEqual([]);
    expect(await opened(page)).toEqual(["https://example.com/x"]);
    await d.locator("#own").click();
    expect(evs((await take(page)).msgs)).toEqual([["focus", "", null], ["click", "own", { href: "/own" }]]);
    // Holding the keyboard, a click on a hyperlink gives it back.
    await d.locator("#i").click();
    await page.keyboard.type("x");
    await d.locator("#hyper").click();
    await terminalHasKeyboard(page);
    expect(evs((await take(page)).msgs)).toEqual([["change", "i", { value: "x" }], ["blur", "", null]]);
    expect(await opened(page)).toEqual(["https://example.com/x", "https://example.com/x"]);
  });

  test("a target=_blank link without a url is no hyperlink: it takes focus, and its click is the program's", async ({ page }) => {
    // No <base>: a relative href has no url (§9).
    await place(page, "r", `<a id=rel target=_blank href="docs/intro">rel</a>`);
    await page.evaluate(() => window.hotty.term.focus());
    await surface(page, "r").locator("#rel").click();
    expect(evs((await take(page)).msgs)).toEqual([["focus", "", null], ["click", "rel", { href: "docs/intro" }]]);
    expect(await opened(page)).toEqual([]);
  });

  test("a click on another surface is elsewhere: the keyboard goes back, and that surface takes nothing", async ({ page }) => {
    await place(page, "a", `<input id=i>`);
    await send(page, { a: "doc", s: "b", q: "2" }, `<p id=p>other text</p>`);
    await send(page, { a: "place", s: "b", c: "60", r: "4", q: "2" });
    await surface(page, "a").locator("#i").click();
    await take(page);
    await surface(page, "b").locator("#p").click();
    await terminalHasKeyboard(page);
    const got = (await take(page)).msgs.filter((m) => m.get("a") === "ev").map((m) => [m.get("s"), m.get("e")]);
    expect(got).toEqual([["a", "blur"]]);
  });
});

test.describe("§5.5: a detached surface", () => {
  test.beforeEach(async ({ page }) => open(page, "?pty=0&record-links"));

  const UI = `<p id=p>Some printed output, to select.</p>
    <button id=b value=v>b</button><a id=l href="/docs">own link</a><span id=s data-on=click>s</span>
    <details id=det><summary id=sum>more</summary>inside</details>
    <form id=f><input id=t name=t data-on=input value=old><input id=c type=checkbox value=yes><button id=go>go</button></form>`;

  test("sends no events of any kind, and its controls do nothing", async ({ page }) => {
    await place(page, "x", UI);
    await place(page, "att", `<p>attached</p>`);
    await send(page, { a: "detach", s: "x", q: "2" });
    await page.evaluate(() => window.hotty.term.focus());
    const d = surface(page, "x");
    for (const id of ["p", "b", "l", "s", "sum", "c", "go"]) await d.locator(`#${id}`).click({ force: true });
    // Typing in its text field: the field is disabled, and the keys are the terminal's.
    const t = (await d.locator("#t").boundingBox())!;
    await page.mouse.click(t.x + t.width / 2, t.y + t.height / 2);
    await page.keyboard.type("new");
    await terminalHasKeyboard(page);
    // A font change resizes both surfaces; only the attached one reports it.
    await page.evaluate(() => ((window.hotty.term as unknown as { options: { fontSize: number } }).options.fontSize = 20));
    const got: [string | undefined, string | undefined][] = [];
    let raw = "";
    await expect
      .poll(async () => {
        const r = await take(page);
        raw += r.raw;
        for (const m of r.msgs) if (m.get("a") === "ev") got.push([m.get("s"), m.get("e")]);
        return got.some(([s, e]) => s === "att" && e === "resize");
      })
      .toBe(true);
    expect(got).toEqual([["att", "resize"]]);
    expect(raw).toBe("new");
    await expect(d.locator("#t")).toHaveValue("old");
    await expect(d.locator("#c")).not.toBeChecked();
    // What is local stays: <details> toggles.
    await expect(d.locator("#det")).toHaveAttribute("open", "");
  });

  test("gives the keyboard back silently: no change, no blur", async ({ page }) => {
    await place(page, "x", UI);
    await send(page, { a: "focus", s: "x", t: "t", q: "2" });
    await page.keyboard.type("!");
    await take(page);
    await send(page, { a: "detach", s: "x" });
    await terminalHasKeyboard(page);
    await page.keyboard.press("z");
    const { msgs, raw } = await take(page);
    expect(msgs.map((m) => [m.get("a"), m.get("re") ?? m.get("e")])).toEqual([["ok", "detach"]]);
    expect(raw).toBe("z");
    // What the user typed stays in the document.
    await expect(surface(page, "x").locator("#t")).toHaveValue("!old");
  });

  test("its controls are disabled, those deltas add too, and the document reports the program's attributes", async ({ page }) => {
    await place(page, "x", UI + `<button id=off disabled>off</button><select id=sel><option>o</option></select><textarea id=ta></textarea><fieldset id=fs></fieldset>`);
    await send(page, { a: "detach", s: "x", q: "2" });
    const d = surface(page, "x");
    for (const id of ["b", "t", "c", "go", "sel", "ta"]) await expect(d.locator(`#${id}`)).toBeDisabled();
    expect(await d.locator("#go").evaluate((el) => el.matches(":disabled"))).toBe(true);
    // Only input, select, textarea and button.
    expect(await d.locator("#fs").evaluate((el) => el.matches(":disabled"))).toBe(false);
    const inspect = (id: string) => page.evaluate((id) => (window.hotty as unknown as { addon: { inspect(s: string, id: string): { attrs: Record<string, string> } } }).addon.inspect("x", id).attrs, id);
    expect(await inspect("b")).toEqual({ id: "b", value: "v" });
    expect(await inspect("off")).toEqual({ id: "off", disabled: "" });
    // A control a delta adds is disabled too; the program's unattr does not enable one.
    await send(page, { a: "delta", s: "x", op: "append", t: "f", q: "2" }, "<input id=late>");
    await send(page, { a: "delta", s: "x", op: "unattr", t: "b", k: "disabled", q: "2" });
    await expect(d.locator("#late")).toBeDisabled();
    await expect(d.locator("#b")).toBeDisabled();
    expect(await inspect("late")).toEqual({ id: "late" });
    // A disabled the program writes is its own, and reported.
    await send(page, { a: "delta", s: "x", op: "attr", t: "c", k: "disabled", q: "2" }, "");
    expect(await inspect("c")).toEqual({ id: "c", type: "checkbox", value: "yes", disabled: "" });
    expect(evs((await take(page)).msgs)).toEqual([]);
  });

  test("keeps hyperlinks, hover and selection; only a hyperlink shows the hand", async ({ page, context, browserName }) => {
    await place(
      page,
      "x",
      `<base href="https://example.com/"><style>a { display: block; height: 30px } a, span, .hand { cursor: pointer !important }</style>` +
        `<p id=p>Some printed output, to select.</p><a id=hyper target=_blank href="spec">spec</a><a id=own href="own"><span id=inner>own</span></a>` +
        `<a id=nourl target=_blank href="http://[x">no url</a>` +
        `<button id=btn>b</button><span id=on data-on=click>on</span><p id=hand class=hand>hand</p>`,
      { d: "1" },
    );
    const d = surface(page, "x");
    const rec = () => page.evaluate(() => {
      const h = window.hotty as unknown as { opened: string[]; hovered: string[] };
      return { opened: [...h.opened], hovered: [...h.hovered] };
    });
    await d.locator("#hyper").hover();
    await expect.poll(async () => (await rec()).hovered).toEqual(["https://example.com/spec"]);
    await d.locator("#hyper").click();
    await d.locator("#own").click();
    expect((await rec()).opened).toEqual(["https://example.com/spec"]);
    expect(context.pages()).toHaveLength(1);
    // The hand over the hyperlink only, whatever the document's cursor asks for.
    const cursor = (id: string) => d.locator(`#${id}`).evaluate((el) => getComputedStyle(el).cursor);
    expect(await cursor("hyper")).toBe("pointer");
    expect(await cursor("own")).toBe("text");
    expect(await cursor("inner")).toBe("text");
    // A target=_blank link without a url is no hyperlink (§9): the text pointer.
    expect(await cursor("nourl")).toBe("text");
    // The host's mark on a hyperlink is not the program's.
    const attrs = await page.evaluate(() => (window.hotty as unknown as { addon: { inspect(s: string, id: string): { attrs: object } } }).addon.inspect("x", "hyper").attrs);
    expect(attrs).toEqual({ id: "hyper", target: "_blank", href: "spec" });
    // It carries the addon's vendor prefix: data-hotty-* is the spec's (§15).
    const live = await d.locator("#hyper").evaluate((el) => Array.from(el.attributes, (a) => a.name).filter((n) => n.startsWith("data-")));
    expect(live).toEqual(["data-xterm-hotty-hyperlink"]);
    for (const id of ["btn", "on", "hand"]) expect(await cursor(id), id).toBe("auto");
    // Selecting text: a drag across the paragraph, while the terminal takes
    // the keyboard back.
    const p = (await d.locator("#p").boundingBox())!;
    await drag(page, browserName, p.x + 1, p.x + p.width - 1, p.y + p.height / 2);
    expect(await d.locator("#p").evaluate((el) => el.ownerDocument.getSelection()!.toString())).toBe("Some printed output, to select.");
    await terminalHasKeyboard(page);
    expect(evs((await take(page)).msgs)).toEqual([]);
  });

  test("an a=doc without d=1 gives it back to the program; until then a=focus is EDETACHED", async ({ page }) => {
    const html = `<button id=b>b</button>`;
    await place(page, "x", html, { d: "1" });
    const d = surface(page, "x");
    // EDETACHED whatever t names, and a=blur does nothing.
    await send(page, { a: "focus", s: "x", t: "b" });
    await send(page, { a: "focus", s: "x", t: "nope" });
    await send(page, { a: "focus", s: "x" });
    expect((await take(page)).msgs.map((m) => (m.json as { code?: string } | null)?.code)).toEqual(["EDETACHED", "EDETACHED", "EDETACHED"]);
    await send(page, { a: "blur", s: "x" });
    expect((await take(page)).msgs.map((m) => [m.get("a"), m.get("re") ?? m.get("e")])).toEqual([["ok", "blur"]]);
    await d.locator("#b").click({ force: true });
    expect(evs((await take(page)).msgs)).toEqual([]);
    await send(page, { a: "doc", s: "x", q: "2" }, html);
    await expect(d.locator("#b")).toBeEnabled();
    await d.locator("#b").click();
    expect(evs((await take(page)).msgs)).toEqual([["focus", "", null], ["click", "b", null]]);
    // Detached again: the keyboard goes back silently.
    await send(page, { a: "doc", s: "x", d: "1", q: "2" }, html);
    await terminalHasKeyboard(page);
    expect(evs((await take(page)).msgs)).toEqual([]);
    await expect(d.locator("#b")).toBeDisabled();
  });
});
