// The demo page: xterm.js, the HOTTY addon, and a WebSocket to serve.py's pty.
// Tests reach everything through `window.hotty`.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { HottyAddon, type FrameStats } from "../src/index.ts";

const params = new URLSearchParams(location.search);
const term = new Terminal({
  fontFamily: params.get("font") ?? '"MesloLGS Nerd Font Mono", "DejaVu Sans Mono", monospace',
  fontSize: Number(params.get("size") ?? 15),
  cursorBlink: false,
  // Key releases for games (HOTTY SPEC §10.3); xterm.js 6.1+.
  vtExtensions: { kittyKeyboard: true },
  theme: {
    background: "#1d1f21",
    foreground: "#c5c8c6",
    black: "#1d1f21",
    red: "#cc6666",
    green: "#b5bd68",
    yellow: "#f0c674",
    blue: "#81a2be",
    magenta: "#b294bb",
    cyan: "#8abeb7",
    white: "#c5c8c6",
    brightBlack: "#666666",
    brightRed: "#d54e53",
    brightGreen: "#b9ca4a",
    brightYellow: "#e7c547",
    brightBlue: "#7aa6da",
    brightMagenta: "#c397d8",
    brightCyan: "#70c0b1",
    brightWhite: "#eaeaea",
  },
});
const frames: FrameStats[] = [];
const invalid: string[] = [];
const hotty = new HottyAddon({ onFrame: (f) => frames.push(f), onInvalid: (r) => invalid.push(r) });
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(hotty);
term.open(document.getElementById("term")!);
fit.fit();

// What the page sends to the program, for tests that drive the terminal
// without a pty (`?pty=0`).
const sent: string[] = [];
const encoder = new TextEncoder();
let ws: WebSocket | null = null;
term.onData((data) => {
  sent.push(data);
  if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
});

function connect() {
  const url = new URL("ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.search = location.search;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    ws!.send(JSON.stringify({ resize: [term.cols, term.rows] }));
    term.focus();
  };
  ws.onmessage = (m) => term.write(new Uint8Array(m.data as ArrayBuffer));
  ws.onclose = () => {
    exited = true;
    term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n");
  };
}
let exited = false;
term.onResize(({ cols, rows }) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: [cols, rows] }));
});
new ResizeObserver(() => fit.fit()).observe(document.getElementById("term")!);
if (params.get("pty") !== "0") connect();

Object.assign(window, {
  hotty: {
    term,
    addon: hotty,
    frames,
    invalid,
    sent,
    get exited() {
      return exited;
    },
    /** Writes to the terminal as if the program had; resolves once parsed. */
    write: (data: string) => new Promise<void>((resolve) => term.write(data, resolve)),
  },
});
