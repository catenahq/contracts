#!/usr/bin/env node
// validate-json.mjs
//
// Walks every .json under the contract directories (brand/, pricing/,
// legal/) and confirms each one parses. Also does the minimum
// shape check per file documented in the per-directory READMEs.
//
// Full schema validation (AJV / TypeBox) is a follow-up; this script
// catches the high-frequency class of regression (malformed JSON,
// missing required key) with zero deps.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const CONTRACT_DIRS = ["brand", "pricing", "legal"];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (extname(p) === ".json") yield p;
  }
}

let failures = 0;

function fail(file, message) {
  console.error(`  FAIL ${file}: ${message}`);
  failures++;
}

function ok(file) {
  console.log(`  ok   ${file}`);
}

function validateTiersJson(file, data) {
  if (!Array.isArray(data.tiers)) return fail(file, "missing `tiers` array");
  for (const [i, t] of data.tiers.entries()) {
    for (const key of ["id", "monthlyPriceCents", "displayName"]) {
      if (!(key in t)) return fail(file, `tier[${i}] missing ${key}`);
    }
    for (const locale of ["en", "fr"]) {
      if (!(locale in t.displayName)) return fail(file, `tier[${i}].displayName missing ${locale}`);
    }
  }
  ok(file);
}

function validateMsaJson(file, data) {
  for (const key of ["version", "sourceUrl", "effectiveDate"]) {
    if (!(key in data)) return fail(file, `missing ${key}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(data.version) && data.version !== "PLACEHOLDER") {
    return fail(file, `version must be a 40-char commit SHA or "PLACEHOLDER", got: ${data.version}`);
  }
  ok(file);
}

console.log("validate-json:");
for (const dir of CONTRACT_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = file.slice(ROOT.length + 1);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      fail(rel, `parse error: ${err.message}`);
      continue;
    }
    if (rel === "pricing/tiers.json") validateTiersJson(rel, parsed);
    else if (rel === "legal/msa.json") validateMsaJson(rel, parsed);
    else ok(rel);
  }
}

if (failures > 0) {
  console.error(`\n${failures} validation failure(s).`);
  process.exit(1);
}
console.log("\nall json artifacts valid.");
