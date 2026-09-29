// The network policy (SPEC §7.2): parsing, the intersection of the host's
// half and the document's, and matching URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { allows, clean, directiveFor, intersect, parse, source } from "../../src/network.ts";

test("sources are origins or https:", () => {
  assert.equal(source("https://Example.com"), "https://example.com");
  assert.equal(source("https://example.com/"), "https://example.com");
  assert.equal(source("http://localhost:8080"), "http://localhost:8080");
  assert.equal(source("https:"), "https:");
  for (const bad of ["https://example.com/img", "*", "'self'", "data:", "http:", "ftp://x.org", "https://a@b.com", "example.com"]) {
    assert.equal(source(bad), null, bad);
  }
});

test("a document's request parses CSP syntax, keeping only what HOTTY allows", () => {
  assert.deepEqual(parse("img-src https://a.com https:; font-src https://f.org; script-src *; img-src https://b.com"), {
    "img-src": ["https://a.com", "https:", "https://b.com"],
    "font-src": ["https://f.org"],
  });
  assert.deepEqual(parse(""), {});
});

test("the effective policy is what both halves allow", () => {
  const host = clean({ "img-src": ["https://a.com", "https://b.com"], "font-src": ["https:"] });
  assert.deepEqual(intersect(host, parse("img-src https://a.com https://evil.com; font-src https://f.org")), {
    "img-src": ["https://a.com"],
    "font-src": ["https://f.org"],
  });
  // A document asking for any HTTPS origin gets the host's.
  assert.deepEqual(intersect(host, parse("img-src https:")), { "img-src": ["https://a.com", "https://b.com"] });
  // Nothing asked, nothing granted: both are empty.
  assert.deepEqual(intersect(host, parse("")), {});
  assert.deepEqual(intersect({}, parse("img-src https:")), {});
});

test("URLs match by origin and scheme", () => {
  const p = { "img-src": ["https://a.com"], "font-src": ["https:"] };
  assert.ok(allows(p, "img-src", "https://a.com/x/y.png"));
  assert.ok(!allows(p, "img-src", "https://a.com.evil.com/x.png"));
  assert.ok(!allows(p, "img-src", "http://a.com/x.png"));
  assert.ok(!allows(p, "media-src", "https://a.com/v.mp4"));
  assert.ok(allows(p, "font-src", "https://any.org/f.woff2"));
  assert.ok(!allows(p, "font-src", "http://any.org/f.woff2"));
});

test("each attribute has the directive that covers it", () => {
  assert.equal(directiveFor("img", "src"), "img-src");
  assert.equal(directiveFor("source", "srcset"), "img-src");
  assert.equal(directiveFor("video", "poster"), "img-src");
  assert.equal(directiveFor("video", "src"), "media-src");
  assert.equal(directiveFor("link", "href", "stylesheet"), "style-src");
  assert.equal(directiveFor("link", "href", "icon"), null);
  assert.equal(directiveFor("a", "href"), null);
});
