// Where a frame's main-thread time goes, by Chrome trace event name.
//   node bench/trace.mjs "<query>" [seconds]
import { chromium } from "@playwright/test";
const [q, secs = "4"] = process.argv.slice(2);
const port = Number(process.env.PORT ?? 8765);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/?${q}`);
await page.waitForFunction(() => window.hotty?.frames.length > 5, null, { timeout: 60000 });
await page.waitForTimeout(3000);
const cdp = await page.context().newCDPSession(page);
const events = [];
cdp.on("Tracing.dataCollected", (e) => events.push(...e.value));
const done = new Promise((r) => cdp.once("Tracing.tracingComplete", r));
await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
const f0 = await page.evaluate(() => window.hotty.frames.length);
await page.waitForTimeout(Number(secs) * 1000);
const frames = (await page.evaluate(() => window.hotty.frames.length)) - f0;
await cdp.send("Tracing.end");
await done;
// Complete events ("X") on renderer main threads, by name.
const main = new Set(events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain").map((e) => `${e.pid}:${e.tid}`));
const sum = new Map();
let draws = 0;
for (const e of events) {
  if (e.name === "DrawFrame" || e.name === "Commit") draws += e.name === "Commit" ? 1 : 0;
  if (e.ph !== "X" || !main.has(`${e.pid}:${e.tid}`)) continue;
  sum.set(e.name, (sum.get(e.name) ?? 0) + (e.dur ?? 0) / 1000);
}
const top = [...sum].sort((a, b) => b[1] - a[1]).slice(0, 14);
console.log(`${q}: ${frames} patch batches, ${draws} commits in ${secs} s; main-thread ms per commit:`);
for (const [n, ms] of top) console.log(`  ${n.padEnd(40)} ${(ms / Math.max(draws, 1)).toFixed(3)}`);
await browser.close();
