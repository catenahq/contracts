#!/usr/bin/env node
// Sibling-write generator for the scripts shared across the catena repos.
//
// contracts/ is the producer. Every consumer gets a byte-identical copy,
// at the path that repo expects (ops keeps its copy under automation/).
// Consumers must not edit their copy: the shared-sync CI job re-runs this
// script with --check and fails on any difference.
//
// Before this existed the convention was "vendor it verbatim" and six
// copies had reached three distinct contents, two of them missing the
// banned-word scan entirely.
//
// Roots default to siblings of this repo and are overridden per repo with
// CATENAHQ_<REPO>_ROOT, matching the generators in catenahq/ops.
//
//   node scripts/sync-shared.mjs            write the copies
//   node scripts/sync-shared.mjs --check    exit 1 if any copy differs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = resolve(REPO_ROOT, "..");

// One entry per consumer: the env var that overrides its root, the default
// sibling folder name, and where that repo keeps each shared file.
const CONSUMERS = [
  { env: "CATENAHQ_DOCS_ROOT", dir: "docs", paths: { "scripts/check-unicode.mjs": "scripts/check-unicode.mjs" } },
  { env: "CATENAHQ_WEBSITE_ROOT", dir: "website", paths: { "scripts/check-unicode.mjs": "scripts/check-unicode.mjs" } },
  { env: "CATENAHQ_PORTAL_ROOT", dir: "portal", paths: { "scripts/check-unicode.mjs": "scripts/check-unicode.mjs" } },
  { env: "CATENAHQ_TEMPLATES_ROOT", dir: "catena-templates", paths: { "scripts/check-unicode.mjs": "scripts/check-unicode.mjs" } },
  { env: "CATENAHQ_OPS_ROOT", dir: "ops", paths: { "scripts/check-unicode.mjs": "automation/scripts/check-unicode.mjs" } },
];

const check = process.argv.includes("--check");
const drifted = [];
const written = [];
const missing = [];

for (const consumer of CONSUMERS) {
  const root = process.env[consumer.env] || join(WORKSPACE, consumer.dir);
  if (!existsSync(root)) {
    missing.push(`${consumer.dir} (${root})`);
    continue;
  }
  for (const [source, target] of Object.entries(consumer.paths)) {
    const wanted = readFileSync(join(REPO_ROOT, source), "utf-8");
    const targetPath = join(root, target);
    const current = existsSync(targetPath) ? readFileSync(targetPath, "utf-8") : null;
    if (current === wanted) continue;
    if (check) {
      drifted.push(`${consumer.dir}/${target}` + (current === null ? " (absent)" : ""));
      continue;
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, wanted);
    written.push(`${consumer.dir}/${target}`);
  }
}

// A consumer checked out elsewhere is not an error: a single-repo CI job
// only has its own tree. The gate that matters compares one copy against
// this repo, and that runs in the consumer.
if (missing.length > 0) {
  console.log(`Not checked out, skipped: ${missing.join(", ")}`);
}

if (check) {
  if (drifted.length > 0) {
    console.error("Shared scripts differ from catenahq/contracts:");
    console.error("");
    for (const d of drifted) console.error("  " + d);
    console.error("");
    console.error("Run `npm run sync:shared` in catenahq/contracts and commit the result.");
    process.exit(1);
  }
  console.log("Shared scripts: in sync.");
} else {
  if (written.length === 0) {
    console.log("Shared scripts: already in sync, nothing written.");
  } else {
    console.log(`Shared scripts: wrote ${written.length} file(s).`);
    for (const w of written) console.log("  " + w);
  }
}
