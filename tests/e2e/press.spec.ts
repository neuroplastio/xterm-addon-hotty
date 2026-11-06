// `p` belongs to the surface, 1 on and 0 off, held until sent again (SPEC
// §5.2): placing a surface again turns presses on or off without a reload.
import { expect, test, type Page } from "@playwright/test";
import { open, send, surface, take } from "./helpers.ts";

const presses = async (page: Page) =>
  (await take(page)).msgs.filter((m) => m.get("e") === "press").map((m) => m.get("t"));

/** A left click on the element, where it is now. */
async function click(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

async function center(page: Page, s: string, id: string) {
  const b = (await surface(page, s).locator(id).boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2] as const;
}

const place = (page: Page, p: string) => send(page, { a: "place", s: "x", c: "20", r: "3", p, q: "2" });

test.describe("placing again turns presses on and off", () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
    await send(page, { a: "doc", s: "x", q: "2" }, `<style>body{margin:0}u{display:block}</style><u id=i>i</u>`);
  });

  test("p=0 then p=1: the next click reports a press", async ({ page }) => {
    await place(page, "0");
    let [x, y] = await center(page, "x", "#i");
    await click(page, x, y);
    expect(await presses(page)).toEqual([]);
    // The cursor moved past the first placement: this one is elsewhere.
    await place(page, "1");
    [x, y] = await center(page, "x", "#i");
    await click(page, x, y);
    await expect.poll(() => presses(page)).toEqual(["i"]);
  });

  test("p=1 then p=0: the next click reports none", async ({ page }) => {
    await place(page, "1");
    let [x, y] = await center(page, "x", "#i");
    await click(page, x, y);
    await expect.poll(() => presses(page)).toEqual(["i"]);
    await place(page, "0");
    [x, y] = await center(page, "x", "#i");
    await click(page, x, y);
    // A press that was reported would be there by now: the click is.
    await surface(page, "x").locator("#i").click();
    expect(await presses(page)).toEqual([]);
  });
});
