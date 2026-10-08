// A text field's keys (SPEC §10.2, §10.4) beyond the shared vectors: keys
// named from what the program would read in the encoding it enabled, the
// fields whose caret the browser hides, rows as a textarea wraps them, the
// user's selection, and editing hosts.
import { expect, test, type Page } from "@playwright/test";
import { open, send, surface, take, write } from "./helpers.ts";

const STYLE = "<style>body{margin:0}input,textarea,div{font:16px monospace}</style>";

async function field(page: Page, html: string, id: string, rows = 4) {
  await open(page, "?pty=0");
  await send(page, { a: "doc", s: "f", q: "2" }, STYLE + html);
  await send(page, { a: "place", s: "f", c: "60", r: String(rows), q: "2" });
  await send(page, { a: "focus", s: "f", t: id, q: "2" });
  await take(page);
}

/** The values the `input` events since the last call carried. */
async function inputs(page: Page): Promise<string[]> {
  return (await take(page)).msgs.filter((m) => m.get("e") === "input").map((m) => (m.json as { value: string }).value);
}

test("with the kitty keyboard protocol on, keys are named from its encoding, and the program still gets the rest in it", async ({ page }) => {
  await field(page, `<input id=t data-on=input value=abc data-keys="Control+a=line-start">`, "t");
  await write(page, "\x1b[=1;1u"); // disambiguate: Control+a is CSI 97;5u
  await take(page);
  await page.keyboard.press("End");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("x");
  expect(await inputs(page)).toEqual(["xabc"]);
  await page.keyboard.press("Control+e");
  await page.keyboard.press("Escape");
  expect((await take(page)).raw).toBe("\x1b[101;5u\x1b[27u");
});

test("an email field is text while focused, so the actions can place its caret; the program sees its own type", async ({ page }) => {
  await field(page, `<input id=e type=email data-on=input value="ab@c" data-keys="Control+a=line-start Alt+f=word-forward">`, "e");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("x");
  expect(await inputs(page)).toEqual(["xab@c"]);
  const attrs = () => page.evaluate(() => (window as unknown as { hotty: { addon: { inspect(s: string, id: string): { attrs: Record<string, string> } } } }).hotty.addon.inspect("f", "e").attrs);
  expect((await attrs()).type).toBe("email");
  expect(await surface(page, "f").locator("#e").evaluate((el: HTMLInputElement) => el.type)).toBe("text");
  await send(page, { a: "blur", s: "f", q: "2" });
  expect(await surface(page, "f").locator("#e").evaluate((el: HTMLInputElement) => el.type)).toBe("email");
  expect((await attrs()).type).toBe("email");
});

test("a number field types what a number holds, and edits with its keymap", async ({ page }) => {
  await field(page, `<input id=n type=number data-on=input value=12 data-keys="Control+a=line-start">`, "n");
  await page.keyboard.press("End");
  await page.keyboard.type("x3");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("-");
  expect(await inputs(page)).toEqual(["123", "-123"]);
});

test("a textarea's rows are as it wraps them: ArrowDown goes to the next row of a long line", async ({ page }) => {
  // 7 columns: "aaaa bbbb cccc" wraps after "aaaa " and "bbbb ".
  await field(page, `<textarea id=t data-on=input rows=4 style="width:7ch;padding:0;border:0;resize:none">aaaa bbbb cccc</textarea>`, "t", 6);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("x");
  expect(await inputs(page)).toEqual(["aaaa bxbbb cccc"]);
});

test("the user's selection: a delete action deletes it, a move collapses it, and Shift with a move moves", async ({ page }) => {
  await field(page, `<input id=t data-on=input value="one two three">`, "t");
  const select = (a: number, b: number) => surface(page, "f").locator("#t").evaluate((el: HTMLInputElement, [a, b]) => el.setSelectionRange(a, b), [a, b] as const);
  await select(4, 7);
  await page.keyboard.press("Backspace");
  expect(await inputs(page)).toEqual(["one  three"]);
  await select(4, 6);
  await page.keyboard.press("ArrowLeft"); // to the selection's start
  await page.keyboard.type("x");
  await select(0, 3);
  await page.keyboard.press("ArrowRight"); // to its end
  await page.keyboard.press("Shift+ArrowRight"); // moves, selects nothing
  await page.keyboard.type("y");
  expect(await inputs(page)).toEqual(["one x three", "one yx three"]);
});

test("an editing host edits with its keymap: words and lines as SPEC §10.2 has them", async ({ page }) => {
  await field(page, `<div id=d contenteditable data-keys="Control+w=delete-word-backward Control+a=line-start Control+k=delete-to-line-end">foo bar baz</div>`, "d");
  // An editing host keeps a space at the end as a no-break space.
  const text = () => surface(page, "f").locator("#d").evaluate((el) => el.textContent!.replace(/\u00a0/g, " "));
  await page.keyboard.press("End");
  await page.keyboard.press("Control+w");
  expect(await text()).toBe("foo bar ");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+k");
  expect(await text()).toBe("f");
  expect((await take(page)).raw).toBe("");
});
