// The host name and version the capabilities report are the package's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOST, VERSION } from "../../src/version.ts";

test("VERSION is package.json's version without its prerelease part", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  // SPEC §4: dot-separated numbers, so 0.1.0-next.1 reports 0.1.0.
  assert.match(VERSION, /^\d+(\.\d+)*$/);
  assert.equal(VERSION, pkg.version.replace(/-.*$/, ""));
});

test("HOST is package.json's name", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(HOST, pkg.name);
});
