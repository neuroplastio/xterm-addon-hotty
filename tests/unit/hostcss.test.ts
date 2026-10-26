// The font hosts ship: its faces from the `fonts` directory, and its place
// in the terminal's font list, just before `monospace`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fontFaces, fontStack } from "../../src/hostcss.ts";

test("the font goes just before monospace, which ends every stack", () => {
  const ours = '"AdwaitaMono Nerd Font Propo"';
  assert.equal(fontStack("", true), `${ours}, monospace`);
  assert.equal(fontStack("monospace", true), `${ours}, monospace`);
  assert.equal(fontStack('"IBM Plex Mono", ui-monospace, monospace', true), `"IBM Plex Mono", ui-monospace, ${ours}, monospace`);
  assert.equal(fontStack("Iosevka", true), `Iosevka, ${ours}, monospace`);
  // ui-monospace is a family of its own, not monospace.
  assert.equal(fontStack("ui-monospace", false), "ui-monospace, monospace");
  assert.equal(fontStack("Iosevka, monospace", false), "Iosevka, monospace");
});

test("the faces are the package's files, in the directory given; none without one", () => {
  assert.deepEqual(fontFaces(""), []);
  const faces = fontFaces("https://example.com/f/");
  const want = [[400, "normal"], [700, "normal"], [400, "italic"], [700, "italic"]] as const;
  assert.equal(faces.length, want.length);
  for (const [face, [weight, style]] of faces.map((f, i) => [f, want[i]!] as const)) {
    const file = /url\("https:\/\/example\.com\/f\/([^"]+)"\)/.exec(face)![1];
    assert.ok(existsSync(new URL(`../../fonts/${file}`, import.meta.url)), file);
    assert.match(face, new RegExp(`font-weight: ${weight}; font-style: ${style};`));
  }
});
