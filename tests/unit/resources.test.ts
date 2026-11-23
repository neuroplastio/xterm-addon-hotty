// A store belongs to one session (SPEC §7.1, §12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../src/resources.ts";
import { Assembler } from "../../src/wire.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

test("stores cannot resolve, replace or delete each other's same-named resource", async () => {
  const a = new Store(10), b = new Store(10);
  a.put("same", "text/plain", bytes("a"));
  assert.equal(b.url("same"), null);
  assert.equal(b.remove("same"), false);
  b.put("same", "text/plain", bytes("b"));
  assert.equal(await (await fetch(a.url("same")!)).text(), "a");
  b.remove("same");
  assert.equal(await (await fetch(a.url("same")!)).text(), "a");
  const old = a.url("same")!;
  a.clear();
  assert.equal(a.url("same"), null);
  await assert.rejects(fetch(old));
  a.put("same", "text/plain", bytes("0123456789"));
  assert.equal(await (await fetch(a.url("same")!)).text(), "0123456789");
  a.clear();
  b.clear();
});

test("a full reset cannot finish a resource begun in the previous session", async () => {
  const a = new Assembler();
  await a.feed("a=res:id=old:m=1;YQ==");
  a.reset();
  const out = await a.feed("m=0");
  assert.ok(out.every((d) => d.kind !== "command" || d.command.control.get("a") !== "res"));
});

test("only CSS resources resolve in stylesheet positions", async () => {
  const store = new Store();
  const names = new Set<string>();
  const resolveStyle = () => store.resolveUrl("cid:theme", names, undefined, "style-src");
  store.put("theme", "TEXT/CSS; charset=utf-8", bytes("p {color:red}"));
  assert.equal((await fetch(resolveStyle())).headers.get("Content-Type"), "text/css");
  store.put("theme", "text/css-invalid", bytes("p {color:red}"));
  assert.equal(resolveStyle(), "about:invalid");
  assert.ok(names.has("theme"));
  store.clear();
});
