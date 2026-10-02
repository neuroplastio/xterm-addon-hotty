import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOTTY_DIR } from "../hotty.ts";
import { Assembler, Control, decodeAll, encode, text, CHUNK } from "../../src/wire.ts";

const CLIENT = join(HOTTY_DIR, "clients", "python");

test("control pairs parse, encode and mangle reserved characters", () => {
  const c = Control.parse("a=delta:s=x:op=text:t=clock");
  assert.equal(c.get("op"), "text");
  assert.equal(c.encode(), "a=delta:s=x:op=text:t=clock");
  assert.equal(new Control().set("t", "a:b;c=d").encode(), "t=a_b_c_d");
  assert.throws(() => Control.parse("a=q:broken"));
});

test("a long reply is chunked at 4096 and reassembles", async () => {
  const body = "x".repeat(10_000);
  const stream = encode(new Control().set("a", "ev").set("s", "s").set("q", "1"), body);
  const chunks = stream.split("\x1b\\").filter(Boolean);
  assert.equal(chunks.length, Math.ceil(Buffer.from(body).toString("base64").length / CHUNK));
  assert.match(chunks[1]!, /^\x1b\]7279;m=1:q=1;/);
  const [cmd] = await decodeAll(stream);
  assert.equal(text(cmd!.payload), body);
  assert.equal(cmd!.control.get("m"), undefined);
});

test("a chunked command interrupted by another command is reported, and the next one works", async () => {
  const a = new Assembler();
  assert.deepEqual(await a.feed("a=doc:s=x:m=1;AAAA"), [{ kind: "partial" }]);
  const got = await a.feed("a=del:s=x");
  assert.equal(got[0]!.kind, "invalid");
  assert.equal(got[1]!.kind, "command");
});

test("decodes what the reference Python client sends: zlib, chunks, UTF-8", async () => {
  const script = `
import sys; sys.path.insert(0, ${JSON.stringify(CLIENT)})
from hotty import Hotty
import io
out = io.BytesIO()
class W:
    def write(self, b): out.write(b)
    def flush(self): pass
lam = Hotty(out=W())
lam.doc("big", "<p>" + "héllo wörld " * 2000 + "</p>")
lam.text("big", "t", "∑ ok")
sys.stdout.buffer.write(out.getvalue())
`;
  const stream = execFileSync("python3", ["-c", script]).toString("latin1");
  assert.ok(stream.includes("o=z"), "the client compresses large payloads");
  assert.ok(stream.split("\x1b\\").length > 2, "and chunks them");
  const cmds = await decodeAll(stream);
  assert.equal(cmds.length, 2);
  assert.equal(text(cmds[0]!.payload), "<p>" + "héllo wörld ".repeat(2000) + "</p>");
  assert.equal(cmds[1]!.control.get("op"), "text");
  assert.equal(text(cmds[1]!.payload), "∑ ok");
});
