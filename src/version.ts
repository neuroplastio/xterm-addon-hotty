/**
 * The addon's version, as its capabilities report it (SPEC §4): package.json's
 * without its prerelease part (0.4.0 for 0.4.0-next.1), since SPEC §4's
 * version is dot-separated numbers only. A unit test keeps the two equal so.
 * Its MAJOR.MINOR is the highest hotty version the addon speaks (`SPEAKS`),
 * and its PATCH is the addon's own (gov P-5 rule 6): 0.5.2 speaks hotty 0.5.
 * 0.4.0, which speaks hotty 0.4, is the first so numbered, after
 * 0.1.0-next.1 to 0.1.0-next.21.
 * A program tells hosts apart by name
 * and version: under HOST every version takes `a=delta`. Before the scope, as
 * `xterm-addon-hotty`, 0.1.0 named no version and took `a=patch`, and 0.2.0
 * took `a=delta`.
 */
export const VERSION = "0.5.2";

/** The host's name in its capabilities (SPEC §4): the package's. */
export const HOST = "@neuroplastio/xterm-addon-hotty";
