// Surfaces live in about:blank iframes, which inherit the embedding page's
// CSP; a policy can only be narrowed, so the page must allow what surfaces use.

import { expect, test } from "@playwright/test";
import { Control, encode } from "../../src/wire.ts";
import { open, send, surface, write } from "./helpers.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

async function styledSurface(page: import("@playwright/test").Page) {
  await write(page, encode(new Control([["a", "res"], ["id", "dot"], ["type", "image/png"], ["q", "2"]]), new Uint8Array(png)));
  await send(page, { a: "doc", s: "x", q: "2" }, "<style>#p{color:rgb(255,0,0)}</style><p id=p style='font-weight:700'>styled</p><img id=i src=cid:dot>");
  await send(page, { a: "place", s: "x", c: "30", r: "3", q: "2" });
  const p = surface(page, "x").locator("#p");
  const img = surface(page, "x").locator("#i");
  return {
    color: await p.evaluate((el) => getComputedStyle(el).color),
    weight: await p.evaluate((el) => getComputedStyle(el).fontWeight),
    image: await img.evaluate((el) => (el as HTMLImageElement).decode().then(() => true, () => false)),
  };
}

test("under the recommended page policy, surfaces are styled and show cid: images", async ({ page }) => {
  await open(page, "?pty=0&csp=recommended");
  expect(await styledSurface(page)).toEqual({ color: "rgb(255, 0, 0)", weight: "700", image: true });
});

test("under style-src 'self', surfaces lose their styles (as xterm.js loses its own)", async ({ page }) => {
  await open(page, "?pty=0&csp=strict");
  const got = await styledSurface(page);
  expect(got.color).not.toBe("rgb(255, 0, 0)");
  expect(got.image).toBe(false);
});
