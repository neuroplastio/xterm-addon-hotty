/**
 * The addon's version, as its capabilities report it (SPEC §4): package.json's,
 * which a unit test keeps this equal to. A program tells hosts apart by name
 * and version: under HOST every version takes `a=delta`. Before the scope, as
 * `xterm-addon-hotty`, 0.1.0 named no version and took `a=patch`, and 0.2.0
 * took `a=delta`.
 */
export const VERSION = "0.1.0";

/** The host's name in its capabilities (SPEC §4): the package's. */
export const HOST = "@neuroplastio/xterm-addon-hotty";
