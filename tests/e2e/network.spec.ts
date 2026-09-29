// The network policy and links (SPEC §7.2, §7.3, §9): a surface fetches from
// the network only what the host grants and the document asks for; links show
// and copy as themselves, every click is an event, and only a gesture opens
// one.
import { expect, test, type Page } from "@playwright/test";
import { open, send, surface, take } from "./helpers.ts";

// Only this spec's requests (/leak/net-…): others record theirs in parallel.
async function leaks(page: Page): Promise<string[]> {
  return ((await (await page.request.get("/leaks")).json()) as string[]).filter((p) => p.startsWith("/leak/net-"));
}

function origin(page: Page): string {
  return new URL(page.url()).origin;
}

async function place(page: Page, s: string, html: string) {
  await send(page, { a: "doc", s, q: "2" }, html);
  await send(page, { a: "place", s, c: "30", r: "4", q: "2" });
}

async function clicks(page: Page, n: number) {
  const got: { t: string; detail: Record<string, unknown> }[] = [];
  await expect
    .poll(async () => {
      for (const m of (await take(page)).msgs) {
        if (m.get("a") === "ev" && m.get("e") === "click") got.push({ t: m.get("t") ?? "", detail: m.json as Record<string, unknown> });
      }
      return got.length;
    })
    .toBe(n);
  return got;
}

test("images load when the host grants the origin and the document asks for it", async ({ page }) => {
  await open(page, "?pty=0&net=img-src%20self");
  const o = origin(page);
  const before = (await leaks(page)).length;
  const doc = (tag: string, ask: string) =>
    `<base href="${o}/leak/net-${tag}/">` + (ask ? `<meta name="hotty-network" content="${ask}">` : "") + `<img id=i src="pic.png"><p id=p style="background:url(bg.png)">x</p>`;
  await place(page, "asks", doc("asks", `img-src ${o}`));
  await place(page, "silent", doc("silent", "")); // did not ask
  await place(page, "other", doc("other", "img-src https://example.com")); // asked for what the host did not grant
  await expect.poll(async () => (await leaks(page)).slice(before).sort()).toEqual(["/leak/net-asks/bg.png", "/leak/net-asks/pic.png"]);
  await page.waitForTimeout(500);
  expect((await leaks(page)).slice(before).sort()).toEqual(["/leak/net-asks/bg.png", "/leak/net-asks/pic.png"]);

  // The program's values stand whatever loaded (SPEC §7.1).
  await send(page, { a: "q", n: "1" });
  const caps = (await take(page)).msgs.find((m) => m.get("re") === "q")!.json as { net: object };
  expect(caps.net).toEqual({ "img-src": [o] });
});

test("without the host's grant nothing is fetched, whatever the document asks", async ({ page }) => {
  await open(page);
  const o = origin(page);
  const before = (await leaks(page)).length;
  await place(page, "x", `<base href="${o}/leak/net-ungranted/"><meta name="hotty-network" content="img-src ${o} https:"><img src="pic.png"><img src="${o}/leak/net-ungranted/abs.png">`);
  await page.waitForTimeout(800);
  expect((await leaks(page)).slice(before)).toEqual([]);
  await send(page, { a: "q", n: "1" });
  const caps = (await take(page)).msgs.find((m) => m.get("re") === "q")!.json as { net: object };
  expect(caps.net).toEqual({});
});

test("links: every click is an event; a gesture opens http, https and mailto links", async ({ page, context }) => {
  await open(page, "?pty=0&record-links");
  await place(
    page,
    "l",
    `<base href="https://example.com/blog/"><p><a href="../about">About</a> <a id=ext href="https://other.org/x">Other</a> ` +
      `<a id=mail href="mailto:a@b.example">mail</a> <a id=js href="javascript:void 0">js</a></p>`,
  );
  await take(page);
  const d = surface(page, "l");
  // The link shows and copies as the link it is.
  expect(await d.locator("a").first().evaluate((a) => (a as HTMLAnchorElement).href)).toBe("https://example.com/about");

  await d.getByText("About").click();
  await d.locator("#ext").click({ modifiers: ["Control"] });
  await d.locator("#mail").click({ button: "middle" });
  await d.locator("#js").click({ modifiers: ["Control"] });
  const got = await clicks(page, 4);
  expect(got).toEqual([
    { t: "", detail: { href: "../about", url: "https://example.com/about" } },
    { t: "ext", detail: { href: "https://other.org/x", url: "https://other.org/x", opened: true } },
    { t: "mail", detail: { href: "mailto:a@b.example", url: "mailto:a@b.example", opened: true } },
    { t: "js", detail: { href: "javascript:void 0", url: "javascript:void 0" } },
  ]);
  expect(await page.evaluate(() => (window.hotty as unknown as { opened: string[] }).opened)).toEqual(["https://other.org/x", "mailto:a@b.example"]);
  expect(context.pages()).toHaveLength(1);
});

test("without a base, a relative link reports its href and no url", async ({ page }) => {
  await open(page, "?pty=0&record-links");
  await place(page, "r", `<a id=r href="docs/intro">docs</a>`);
  await take(page);
  await surface(page, "r").locator("#r").click({ modifiers: ["Control"] });
  expect(await clicks(page, 1)).toEqual([{ t: "r", detail: { href: "docs/intro" } }]);
  expect(await page.evaluate(() => (window.hotty as unknown as { opened: string[] }).opened)).toEqual([]);
});
