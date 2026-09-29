// Costs of the browser host: per surface, and per frame.
//
//   node bench/measure.mjs [--port 8765] [--seconds 8] [--only surfaces|frames]
//
// Needs serve.py running with --examples. Chrome's own counters (CDP
// Performance.getMetrics) give main-thread, style and layout time; CPU is
// read from /proc for every Chromium process of this run (found by its
// profile directory), so raster and compositing count too.

import { chromium } from "@playwright/test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOTTY_DIR } from "../tests/hotty.ts";
import { Control, encode } from "../src/wire.ts";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const port = Number(arg("--port", 8765));
const seconds = Number(arg("--seconds", 8));
const only = arg("--only", null);
const base = `http://127.0.0.1:${port}/`;
const HZ = 100; // USER_HZ on Linux

const profile = mkdtempSync(join(tmpdir(), "hotty-bench-"));
const context = await chromium.launchPersistentContext(profile, { viewport: { width: 1200, height: 800 } });
const page = context.pages()[0] ?? (await context.newPage());
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");

function chromiumPids() {
  // The browser process carries the profile path; renderers and the GPU
  // process are its descendants.
  const all = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  const parent = new Map();
  const roots = [];
  for (const p of all) {
    try {
      const s = readFileSync(`/proc/${p}/stat`, "utf8");
      parent.set(p, s.slice(s.lastIndexOf(")") + 2).split(" ")[1]);
      if (readFileSync(`/proc/${p}/cmdline`, "utf8").includes(profile)) roots.push(p);
    } catch { /* exited */ }
  }
  const out = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [p, pp] of parent) if (!out.has(p) && out.has(pp)) (out.add(p), (grew = true));
  }
  return [...out];
}
function ticks(pids) {
  let t = 0;
  for (const p of pids) {
    try {
      const s = readFileSync(`/proc/${p}/stat`, "utf8");
      const r = s.slice(s.lastIndexOf(")") + 2).split(" ");
      t += Number(r[11]) + Number(r[12]);
    } catch { /* exited */ }
  }
  return t;
}
function rssMB(pids) {
  let kb = 0;
  for (const p of pids) {
    try {
      kb += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${p}/status`, "utf8"))[1]);
    } catch { /* exited */ }
  }
  return kb / 1024;
}
async function metrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

if (only !== "frames") {
  // Per surface: time to create one (a=doc + place) and memory, over 50.
  await page.goto(base + "?pty=0");
  await page.waitForFunction(() => window.hotty !== undefined);
  const card = readFileSync(join(HOTTY_DIR, "corpus", "01-card.html"), "utf8");
  const cmd = (pairs, payload = "") => encode(new Control(Object.entries(pairs)), payload);
  await page.waitForTimeout(500);
  const pids = chromiumPids();
  const rss0 = rssMB(pids);
  const n = 50;
  const m0 = await metrics();
  const ms = [];
  for (let i = 0; i < n; i++) {
    const data = cmd({ a: "doc", s: `c${i}`, q: "2" }, card) + cmd({ a: "place", s: `c${i}`, c: "60", r: "8", C: "1", q: "2" });
    ms.push(await page.evaluate(async (d) => {
      const t = performance.now();
      await window.hotty.write(d);
      const applied = performance.now() - t;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return applied;
    }, data));
  }
  await page.waitForTimeout(1000);
  const m1 = await metrics();
  const rss1 = rssMB(chromiumPids());
  ms.sort((a, b) => a - b);
  const per = (k) => (((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000) / n;
  console.log(`surfaces: ${n} cards (corpus/01-card.html) in ${pids.length} Chromium processes`);
  console.log(`  a=doc + a=place (iframe, parse, sanitize, adopt): median ${ms[n >> 1].toFixed(2)} ms, p90 ${ms[Math.floor(n * 0.9)].toFixed(2)} ms`);
  console.log(`  main thread per surface ${per("TaskDuration").toFixed(2)} ms (style ${per("RecalcStyleDuration").toFixed(2)}, layout ${per("LayoutDuration").toFixed(2)})`);
  console.log(`  RSS +${((rss1 - rss0) / n).toFixed(2)} MB per surface (${rss0.toFixed(0)} → ${rss1.toFixed(0)} MB)`);
}

if (only !== "surfaces") {
  const workloads = [
    ["dash 10 Hz", "run=dash&args=--hz+10"],
    ["dash full rate", "run=dash&args=--hz+100000"],
    ["grid nested 4,096 · 10 Hz", "run=grid&args=--cells+4096"],
    ["grid nested 262,144 · 10 Hz", "run=grid&args=--cells+262144"],
    ["  … with CSS containment", "run=grid&args=--cells+262144+--contain"],
    ["grid nested 4,096 · full", "run=grid&args=--cells+4096+--hz+100000"],
    ["grid nested 262,144 · full", "run=grid&args=--cells+262144+--hz+100000"],
    ["  … with CSS containment", "run=grid&args=--cells+262144+--contain+--hz+100000"],
    ["grid flat 10,000 · full", "run=grid&args=--cells+10000+--fanout+0+--hz+100000"],
    ["grid flat 50,000 · full", "run=grid&args=--cells+50000+--fanout+0+--hz+100000"],
  ];
  console.log("\nworkload                        patches/s  frames/s  main ms/frame  style  layout  apply ms/batch  chromium CPU");
  for (const [label, q] of workloads) {
    await page.goto(base + "?" + q);
    await page.waitForFunction(() => window.hotty?.frames.length > 5, null, { timeout: 60000 });
    await page.waitForTimeout(q.includes("262144") ? 6000 : 2000);
    const pids = chromiumPids();
    // Rendered frames: one requestAnimationFrame per frame the page produces.
    await page.evaluate(() => {
      window.__raf = 0;
      const tick = () => {
        window.__raf++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const f0 = await page.evaluate(() => window.hotty.frames.length);
    const r0 = await page.evaluate(() => window.__raf);
    const m0 = await metrics();
    const t0 = ticks(pids);
    const w0 = Date.now();
    await page.waitForTimeout(seconds * 1000);
    const wall = (Date.now() - w0) / 1000;
    const t1 = ticks(pids);
    const m1 = await metrics();
    const rendered = (await page.evaluate(() => window.__raf)) - r0;
    const batches = await page.evaluate((f0) => window.hotty.frames.slice(f0), f0);
    const patches = batches.reduce((a, f) => a + f.commands, 0);
    const apply = batches.reduce((a, f) => a + f.applyMs, 0) / Math.max(batches.length, 1);
    // Frames that actually changed something: at most one per batch.
    const frames = Math.max(Math.min(rendered, batches.length), 1);
    const per = (k) => (((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000) / frames;
    const cpu = ((t1 - t0) / HZ / wall) * 100;
    console.log(
      `${label.padEnd(31)} ${(patches / wall).toFixed(0).padStart(9)}  ${(frames / wall).toFixed(0).padStart(8)}  ${per("TaskDuration").toFixed(2).padStart(13)}  ${per("RecalcStyleDuration").toFixed(2).padStart(5)}  ${per("LayoutDuration").toFixed(2).padStart(6)}  ${apply.toFixed(3).padStart(14)}  ${cpu.toFixed(0).padStart(11)}%`,
    );
  }
}
await context.close();
