// Smoke test: ensure the CSS token contract holds. Run with
// `node brand/test.js` from this repo root (also wired as the
// `npm test` entry). Will be replaced by a Vitest suite once the
// test surface grows past this file.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// CSS variable contract: every file must declare :root{} and the
// canonical accent variable must live in colors.css as a hex color.
const colorsCss = readFileSync(join(here, "tokens/colors.css"), "utf8");
assert.match(colorsCss, /:root\s*\{/);
assert.match(colorsCss, /--catena-accent:\s*#[0-9a-f]{6}\s*;/i,
  "accent must be a hex color");

const typographyCss = readFileSync(join(here, "tokens/typography.css"), "utf8");
assert.match(typographyCss, /--catena-font-sans:/);

const spacingCss = readFileSync(join(here, "tokens/spacing.css"), "utf8");
assert.match(spacingCss, /--catena-space-4:/);

// all.css must pull in exactly the three token files.
const allCss = readFileSync(join(here, "tokens/all.css"), "utf8");
for (const f of ["colors.css", "typography.css", "spacing.css"]) {
  assert.match(allCss, new RegExp(f.replace(".", "\\.")),
    `all.css must import ${f}`);
}

console.log("@catena/brand: ok");
