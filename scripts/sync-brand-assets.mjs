// Copies brand binaries from this repo into the consuming site's public/, so
// the browser fetches them from fixed URLs the bundler does not own (the
// favicon). CSS-imported binaries (the Conthrax @font-face) flow through the
// bundler instead and land fingerprinted in the build output.
//
// Run from the consumer's root, as its postinstall:
//   node ../contracts/scripts/sync-brand-assets.mjs
// Idempotent.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const targets = [
  { from: "../brand/assets/logo.svg", to: "public/favicon.svg" },
];

for (const { from, to } of targets) {
  const src = fileURLToPath(new URL(from, import.meta.url));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(src, to);
  console.log(`sync:brand  ${from}  ->  ${to}`);
}
