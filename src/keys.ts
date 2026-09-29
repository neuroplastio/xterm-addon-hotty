// Keys a surface does not use go to the program as ordinary terminal input
// (PROTOCOL §8). xterm.js's own encoder is private, so this is a small one in
// its conventions: xterm-style sequences, CSI 1;<mod> for modified keys, and
// SS3 for the cursor keys in application cursor mode (DECCKM).

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const CSI = "\x1b[";
const SS3 = "\x1bO";

/** The bytes a terminal sends for `e`, or `null` if it sends nothing. */
export function encodeKey(e: KeyLike, applicationCursor: boolean): string | null {
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + (e.metaKey ? 8 : 0);
  const cursor = (final: string) => (mod > 1 ? `${CSI}1;${mod}${final}` : applicationCursor ? `${SS3}${final}` : `${CSI}${final}`);
  const tilde = (n: number) => (mod > 1 ? `${CSI}${n};${mod}~` : `${CSI}${n}~`);
  const fkey = (final: string) => (mod > 1 ? `${CSI}1;${mod}${final}` : `${SS3}${final}`);
  switch (e.key) {
    case "ArrowUp":
      return cursor("A");
    case "ArrowDown":
      return cursor("B");
    case "ArrowRight":
      return cursor("C");
    case "ArrowLeft":
      return cursor("D");
    case "Home":
      return cursor("H");
    case "End":
      return cursor("F");
    case "Insert":
      return tilde(2);
    case "Delete":
      return tilde(3);
    case "PageUp":
      return tilde(5);
    case "PageDown":
      return tilde(6);
    case "F1":
      return fkey("P");
    case "F2":
      return fkey("Q");
    case "F3":
      return fkey("R");
    case "F4":
      return fkey("S");
    case "F5":
      return tilde(15);
    case "F6":
      return tilde(17);
    case "F7":
      return tilde(18);
    case "F8":
      return tilde(19);
    case "F9":
      return tilde(20);
    case "F10":
      return tilde(21);
    case "F11":
      return tilde(23);
    case "F12":
      return tilde(24);
    case "Enter":
      return e.altKey ? "\x1b\r" : "\r";
    case "Tab":
      return e.shiftKey ? `${CSI}Z` : "\t";
    case "Backspace":
      return e.ctrlKey ? "\x08" : e.altKey ? "\x1b\x7f" : "\x7f";
    case "Escape":
      return "\x1b";
  }
  if ([...e.key].length !== 1) return null; // Shift, Dead, Unidentified, …
  let ch = e.key;
  if (e.ctrlKey) {
    const c = ch.toUpperCase().charCodeAt(0);
    if (c >= 0x40 && c <= 0x5f) ch = String.fromCharCode(c - 0x40);
    else if (ch === " " || ch === "2") ch = "\x00";
    else if (ch === "/") ch = "\x1f";
    else if (ch === "?") ch = "\x7f";
  }
  return e.altKey ? `\x1b${ch}` : ch;
}
