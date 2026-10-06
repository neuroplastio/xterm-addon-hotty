// The host stylesheet (SPEC §8) dresses controls, focus, links and selected
// text in the terminal's palette, in the host's layer, so a document that
// styles its own wins. Checked as computed styles, dark and light.
import { expect, test, type Page } from "@playwright/test";
import { open, send, surface } from "./helpers.ts";

const CONTROLS =
  `<input id=t placeholder=p><textarea id=ta></textarea><select id=s><option>a</option></select>` +
  `<button id=b>b</button><button id=bd disabled>d</button><input type=submit id=sub>` +
  `<input type=checkbox id=c><a id=l href=next>link</a><p id=p>text</p>`;

/** `#rrggbb` as getComputedStyle has it. */
function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/** Computed properties of an element of surface `x`, or of its pseudo-element. */
async function style(page: Page, id: string, props: string[], pseudo?: string): Promise<Record<string, string>> {
  return surface(page, "x")
    .locator(`#${id}`)
    .evaluate(
      (el, [props, pseudo]) => {
        const s = el.ownerDocument.defaultView!.getComputedStyle(el, pseudo ?? null);
        return Object.fromEntries((props as string[]).map((p) => [p, s.getPropertyValue(p).trim()]));
      },
      [props, pseudo] as const,
    );
}

/** What the palette gives every control, for the theme's colours. */
async function dressed(page: Page, c: { fg: string; bg: string; dim: string; accent: string; scheme: string }) {
  const root = await surface(page, "x")
    .locator("html")
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { scheme: s.colorScheme, accent: s.getPropertyValue("--hotty-accent").trim(), accentColor: s.accentColor };
    });
  expect(root.scheme).toBe(c.scheme);
  expect(rgbOf(root.accent)).toBe(rgb(c.accent));
  expect(root.accentColor).toBe(rgb(c.accent));
  // Fields: the foreground on the background, a dim border.
  for (const id of ["t", "ta", "s"]) {
    expect(await style(page, id, ["color", "background-color", "border-top-color", "border-top-width", "border-top-style"]), id).toEqual({
      color: rgb(c.fg),
      "background-color": rgb(c.bg),
      "border-top-color": rgb(c.dim),
      "border-top-width": "1px",
      "border-top-style": "solid",
    });
  }
  // Buttons: the foreground on the dim grey; disabled, dim on the background.
  for (const id of ["b", "sub"]) expect(await style(page, id, ["color", "background-color"]), id).toEqual({ color: rgb(c.fg), "background-color": rgb(c.dim) });
  expect(await style(page, "bd", ["color", "background-color"])).toEqual({ color: rgb(c.dim), "background-color": rgb(c.bg) });
  // A checkbox keeps its own look, in the accent.
  expect(await style(page, "c", ["accent-color", "border-top-width"])).toEqual({ "accent-color": rgb(c.accent), "border-top-width": "0px" });
  expect((await style(page, "t", ["color"], "::placeholder")).color).toBe(rgb(c.dim));
  expect((await style(page, "l", ["color"])).color).toBe(rgb(c.accent));
  expect(await style(page, "p", ["color", "background-color"], "::selection")).toEqual({ color: rgb(c.bg), "background-color": rgb(c.accent) });
  // Focus: a ring in the accent.
  await send(page, { a: "focus", s: "x", t: "t", q: "2" });
  await expect.poll(async () => (await style(page, "t", ["outline-color", "outline-width", "outline-style"]))).toEqual({
    "outline-color": rgb(c.accent),
    "outline-width": "1px",
    "outline-style": "solid",
  });
  await send(page, { a: "blur", s: "x", q: "2" });
}

/** A colour a custom property holds, as getComputedStyle gives colours. */
function rgbOf(hex: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? rgb(hex) : hex;
}

async function setup(page: Page, html = CONTROLS) {
  await open(page);
  await send(page, { a: "doc", s: "x", q: "2" }, html);
  await send(page, { a: "place", s: "x", c: "60", r: "4", q: "2" });
  await expect(surface(page, "x").locator("#t")).toBeVisible();
}

test("controls, focus, links and selected text take the terminal's palette: dark", async ({ page }) => {
  await setup(page);
  // The demo's theme (demo/main.ts): ansi-8 #666666, ansi-12 #7aa6da.
  await dressed(page, { fg: "#c5c8c6", bg: "#1d1f21", dim: "#666666", accent: "#7aa6da", scheme: "dark" });
});

test("controls, focus, links and selected text take the terminal's palette: light, with the accent ansi-4", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const t = window.hotty.term as unknown as { options: { theme: object } };
    t.options.theme = {
      background: "#fdf6e3",
      foreground: "#073642",
      black: "#073642",
      blue: "#268bd2",
      brightBlack: "#93a1a1",
      brightBlue: "#839496",
    };
  });
  await expect(surface(page, "x").locator("html")).toHaveCSS("color-scheme", "light");
  await dressed(page, { fg: "#073642", bg: "#fdf6e3", dim: "#93a1a1", accent: "#268bd2", scheme: "light" });
});

test("a document that styles its own controls wins over the host's palette", async ({ page }) => {
  await setup(page, `<style>button{background:rgb(1,2,3);border:2px dashed rgb(4,5,6)}a{color:rgb(7,8,9)}:root{accent-color:rgb(10,11,12)}</style>${CONTROLS}`);
  expect(await style(page, "b", ["background-color", "border-top-width", "border-top-style", "border-top-color"])).toEqual({
    "background-color": "rgb(1, 2, 3)",
    "border-top-width": "2px",
    "border-top-style": "dashed",
    "border-top-color": "rgb(4, 5, 6)",
  });
  expect((await style(page, "l", ["color"])).color).toBe("rgb(7, 8, 9)");
  expect((await style(page, "c", ["accent-color"]))["accent-color"]).toBe("rgb(10, 11, 12)");
});
