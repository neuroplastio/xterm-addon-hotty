// A surface is untrusted markup from the program's side of a pty: it must
// not run script, reach the network, navigate, open windows or steal focus
// (PROTOCOL §10, D1, D2). The bridge's /leak endpoint records any request that
// gets through; it is same-origin with the page, the most permissive case.

import { expect, test, type Page } from "@playwright/test";
import { Control, encode } from "../../src/wire.ts";
import { open, send, surface, take, write } from "./helpers.ts";

// Its own prefix: other specs record legitimate requests in parallel.
const leak = (tag: string) => `/leak/hostile/${tag}`;
const abs = (page: Page, tag: string) => new URL(leak(tag), page.url()).href;

async function leaks(page: Page): Promise<string[]> {
  const r = await page.request.get("/leaks");
  return (await r.json()) as string[];
}

test("script, requests, navigation, popups and focus theft all fail", async ({ page, context }) => {
  // Links the user asks to open (SPEC §9) are recorded rather than opened.
  await open(page, "?pty=0&record-links");
  const before = await leaks(page);
  await page.evaluate(() => window.hotty.term.focus());
  const L = (t: string) => abs(page, t);
  const doc = `
<head>
  <meta http-equiv="refresh" content="0;url=${L("refresh")}">
  <base href="${L("base/")}">
  <link rel="stylesheet" href="${L("link-css")}">
  <link rel="prefetch" href="${L("prefetch")}">
  <link rel="preload" as="image" href="${L("preload")}">
  <link rel="dns-prefetch" href="${L("dns")}">
  <script>parent.document.title = "pwned-script"; fetch("${L("script-fetch")}")</script>
  <style>
    @import url("${L("import")}");
    @font-face { font-family: X; src: url("${L("font")}"); }
    #bg { background: url("${L("css-bg")}"); font-family: X; width: 10px; height: 10px; }
    #var { background: var(--u); width: 10px; height: 10px; }
    #fixed { position: fixed; inset: 0; pointer-events: none; }
  </style>
</head>
<body>
  <img src="${L("img")}" srcset="${L("srcset")} 2x" onerror="parent.document.title='pwned-onerror'">
  <svg onload="parent.document.title='pwned-svg'"><image href="${L("svg-image")}" width="10" height="10"/><use href="${L("svg-use")}#x"/></svg>
  <video poster="${L("poster")}" src="${L("video")}"></video>
  <iframe src="${L("iframe")}"></iframe>
  <object data="${L("object")}"></object><embed src="${L("embed")}">
  <div id="bg">bg</div><div id="var" style="--u: url('${L("var")}')">v</div>
  <div id="fixed"></div>
  <input id="auto" autofocus>
  <a id="link" href="${L("nav")}" ping="${L("ping")}">link</a>
  <a id="blank" href="${L("blank")}" target="_blank">blank</a>
  <a id="js" href="javascript:parent.document.title='pwned-js'">js</a>
  <form id="f" action="${L("form")}" method="post"><input name="a" value="1"><button id="go">go</button></form>
</body>`;
  await send(page, { a: "doc", s: "h", q: "2" }, doc);
  await send(page, { a: "place", s: "h", c: "60", r: "12", q: "2" });

  // Patches and resources carry hostile content too.
  await send(page, { a: "patch", s: "h", op: "append", t: "bg", q: "2" }, `<img src="${L("patch-img")}" onerror="parent.document.title='pwned-patch'">`);
  await send(page, { a: "patch", s: "h", op: "attr", t: "bg", k: "onclick", q: "2" }, "parent.document.title='pwned-attr'");
  await send(page, { a: "patch", s: "h", op: "attr", t: "auto", k: "src", q: "2" }, L("attr-src"));
  await send(page, { a: "patch", s: "h", op: "var", t: "var", k: "u", q: "2" }, `url('${L("var-patch")}')`);
  await write(page, encode(new Control([["a", "res"], ["id", "evil"], ["type", "text/css"], ["q", "2"]]), `@import url("${L("res-import")}"); body { background: url("${L("res-bg")}") }`));
  await send(page, { a: "patch", s: "h", op: "append", t: "bg", q: "2" }, `<link rel=stylesheet href=cid:evil>`);

  // Autofocus did not take the keyboard from the terminal.
  expect(await page.evaluate(() => document.activeElement?.className)).toContain("xterm-helper-textarea");

  const d = surface(page, "h");
  await d.locator("#link").click();
  await d.locator("#blank").click({ modifiers: ["Control"] });
  await d.locator("#blank").click();
  await d.locator("#js").click();
  await d.locator("#go").click();
  await page.waitForTimeout(1500);

  expect(await page.title()).toBe("HOTTY in xterm.js");
  expect(context.pages()).toHaveLength(1);
  const got = (await leaks(page)).slice(before.length).filter((p) => p.startsWith("/leak/hostile/"));
  expect(got).toEqual([]);
  // Only the user's Ctrl-click opened anything, and only through the host.
  expect(await page.evaluate(() => (window.hotty as unknown as { opened: string[] }).opened)).toEqual([L("blank")]);

  // What reached the live document: none of the dangerous elements or handlers.
  const live = await d.locator("html").evaluate((root) => ({
    // Only the skeleton's own <meta charset>, CSP <meta> and <base> remain
    // (the <base> carries the document's base URL, SPEC §7.3).
    dropped: [...root.querySelectorAll("script, iframe, object, embed, base, meta")]
      .map((el) => el.outerHTML)
      .filter((h) => !/^<meta charset="utf-8">$|^<meta http-equiv="Content-Security-Policy"|^<base href="[^"]*">$/.test(h)),
    handlers: [...root.querySelectorAll("*")].flatMap((el) => [...el.attributes].filter((a) => a.name.startsWith("on")).map((a) => a.name)),
    ping: root.querySelector("#link")?.getAttribute("ping") ?? null,
    fixed: (() => {
      const r = root.querySelector("#fixed")!.getBoundingClientRect();
      return [r.width, r.height];
    })(),
    viewport: [root.ownerDocument.defaultView!.innerWidth, root.ownerDocument.defaultView!.innerHeight],
  }));
  expect(live.dropped).toEqual([]);
  expect(live.handlers).toEqual([]);
  expect(live.ping).toBeNull();
  // position: fixed stays inside the surface's own viewport.
  expect(live.fixed).toEqual(live.viewport);

  // The program still hears the user: the link click and the form.
  const { msgs } = await take(page);
  const evs = msgs.filter((m) => m.get("a") === "ev").map((m) => `${m.get("e")}:${m.get("t")}`);
  expect(evs).toContain("click:link");
  expect(evs).toContain("submit:f");
  const link = msgs.find((m) => m.get("e") === "click" && m.get("t") === "link")!;
  expect((link.json as { href: string }).href).toBe(L("nav"));
});
