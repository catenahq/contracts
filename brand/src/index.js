/* @catena/brand -- main entry.
 *
 * The CSS variables in tokens/*.css are the source of truth for
 * runtime values. This JS module re-exports the same numbers (and
 * exposes the breakpoints map) for code that needs the values
 * without going through getComputedStyle.
 *
 * Usage in apps:
 *   import "@catena/brand/tokens/all.css";  // load CSS variables
 *   import { breakpoints, accent } from "@catena/brand";
 */

export { breakpoints, minWidth } from "./breakpoints.js";

/** Default accent color (the swap point in colors.css). */
export const accent = "#1e5fb6";

/** Type scale base size in pixels. Matches --catena-fs-base. */
export const baseFontSize = 16;
