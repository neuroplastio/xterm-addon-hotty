// Builds the addon (dist/hotty-xterm.js) and the demo page (dist/).
import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
const common = { bundle: true, format: "esm", target: "es2022", sourcemap: true, logLevel: "warning" };
await esbuild.build({ ...common, entryPoints: ["src/index.ts"], outfile: "dist/hotty-xterm.js", external: ["@xterm/xterm"] });
await esbuild.build({ ...common, entryPoints: ["demo/main.ts"], outfile: "dist/demo.js" });
cpSync("node_modules/@xterm/xterm/css/xterm.css", "dist/xterm.css");
cpSync("demo/index.html", "dist/index.html");
