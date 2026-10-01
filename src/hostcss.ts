// The host's stylesheet (PROTOCOL §7): the terminal's look, handed to every
// surface. It sits in a cascade layer, so any rule the program writes wins
// over it, as it would over a user-agent sheet.

import type { ITheme } from "@xterm/xterm";

export interface Metrics {
  /** Cell size in CSS pixels. */
  cellW: number;
  cellH: number;
  fontFamily: string;
  fontSize: number;
}

// xterm.js's own defaults (src/browser/services/ThemeService.ts:23-24,
// src/browser/Types.ts:181), for themes that leave colours out.
const DEFAULT_FG = "#ffffff";
const DEFAULT_BG = "#000000";
const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
const DEFAULT_ANSI = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf", "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

export function palette(theme: ITheme | undefined) {
  const fg = theme?.foreground ?? DEFAULT_FG;
  const bg = theme?.background ?? DEFAULT_BG;
  const ansi = ANSI_KEYS.map((k, i) => theme?.[k] ?? DEFAULT_ANSI[i]!);
  return { fg, bg, ansi, dark: luminance(bg) < 0.5 };
}

export function hostCss(theme: ITheme | undefined, m: Metrics): string {
  const p = palette(theme);
  const lines = [
    "@layer hotty-host {",
    ":root {",
    `  color-scheme: ${p.dark ? "dark" : "light"};`,
    `  --hotty-fg: ${p.fg};`,
    `  --hotty-bg: ${p.bg};`,
    ...p.ansi.map((c, i) => `  --hotty-ansi-${i}: ${c};`),
    `  --hotty-cell-w: ${m.cellW}px;`,
    `  --hotty-cell-h: ${m.cellH}px;`,
    `  --hotty-font: ${fontStack(m.fontFamily)};`,
    "  font-family: var(--hotty-font);",
    `  font-size: ${m.fontSize}px;`,
    // An explicit line-height, so that `1rlh` is one terminal row.
    `  line-height: ${m.cellH}px;`,
    "  color: var(--hotty-fg);",
    "  background: var(--hotty-bg);",
    // A surface is a fixed rectangle of cells, and nothing in it scrolls
    // (SPEC §5.3): what does not fit is clipped. The browser pans nothing
    // on a touch (a drag is the terminal's, SPEC §9; the surface forwards
    // it), and nothing shows a scrollbar, even with `overflow: auto`.
    "  overflow: hidden;",
    "  touch-action: none;",
    "}",
    "body { margin: 0; }",
    // An element that opts in to drags selects no text, whatever the
    // document's CSS (SPEC §9.1, §11): important in the host's layer, the
    // first, wins over every rule of the document's.
    "[data-on~=drag], [data-on~=drag] * { -webkit-user-select: none !important; user-select: none !important; }",
    "* { scrollbar-width: none !important; }",
    "::-webkit-scrollbar { display: none !important; }",
    "}",
  ];
  return lines.join("\n");
}

function fontStack(family: string): string {
  const f = family.trim();
  if (!f) return "monospace";
  // xterm's fontFamily is already a CSS font-family list.
  return /monospace\s*$/.test(f) ? f : `${f}, monospace`;
}

/** Relative luminance of a `#rrggbb` (or `#rgb`) colour; 0 for anything else. */
function luminance(color: string): number {
  let hex = color.trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}/i.test(hex)) return 0;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
