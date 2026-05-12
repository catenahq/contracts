// Smoke test: ensure the package resolves + exports the expected
// shape. Run with `node packages/brand/test.js`. Will be replaced
// by an apps-level Vitest suite once an app actually consumes
// @catena/brand.
import { breakpoints, minWidth, accent, baseFontSize } from "./src/index.js";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

assert.equal(typeof breakpoints, "object");
assert.equal(breakpoints.lg, 1024, "breakpoints.lg drift");
assert.equal(minWidth("md"), "(min-width: 768px)");
assert.equal(minWidth(900), "(min-width: 900px)");
assert.throws(() => minWidth("nope"), /unknown breakpoint/);

assert.match(accent, /^#[0-9a-f]{6}$/i, "accent must be a hex color");
assert.equal(baseFontSize, 16);

// CSS variable contract: every file must declare :root{} and the
// canonical accent variable must live in colors.css.
const colorsCss = readFileSync(join(here, "tokens/colors.css"), "utf8");
assert.match(colorsCss, /:root\s*\{/);
assert.match(colorsCss, /--catena-accent:/);

const typographyCss = readFileSync(join(here, "tokens/typography.css"), "utf8");
assert.match(typographyCss, /--catena-font-sans:/);

const spacingCss = readFileSync(join(here, "tokens/spacing.css"), "utf8");
assert.match(spacingCss, /--catena-space-4:/);

console.log("@catena/brand: ok");
