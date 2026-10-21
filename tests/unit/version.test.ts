// The host name and version the capabilities report are the package's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SPEAKS } from "../../src/addon.ts";
import { HOST, VERSION } from "../../src/version.ts";
import { readVectors } from "../hotty.ts";

test("VERSION is package.json's version without its prerelease part", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  // SPEC §4: dot-separated numbers, so 0.4.0-next.1 reports 0.4.0.
  assert.match(VERSION, /^\d+(\.\d+)*$/);
  assert.equal(VERSION, pkg.version.replace(/-.*$/, ""));
});

test("HOST is package.json's name", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(HOST, pkg.name);
});

// gov P-5 rule 6: a host's MAJOR.MINOR is the highest hotty version it
// speaks, which the vectors it passes are for. hotty 0.4 is 0.4.x.
test("VERSION's MAJOR.MINOR is the hotty version the addon speaks", () => {
  assert.equal(VERSION.split(".").slice(0, 2).join("."), SPEAKS[0]);
  assert.equal(readVectors().version, SPEAKS[0]);
});
