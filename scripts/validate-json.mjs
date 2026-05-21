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

function requireKeys(file, obj, keys, where) {
  for (const key of keys) {
    if (!(key in obj)) return fail(file, `${where} missing ${key}`);
  }
  return true;
}

function requireBilingual(file, obj, where) {
  for (const locale of ["en", "fr"]) {
    if (!(locale in obj)) return fail(file, `${where} missing ${locale}`);
  }
  return true;
}

function validateTiersJson(file, data) {
  const topLevelKeys = [
    "currency",
    "supportIncrementMinutes",
    "customTemplateSetupCents",
    "earlyTerminationFeeMultiplier",
    "managedMinimumCommitmentMonths",
    "alacarteHourlyCents",
    "components",
    "supportPacks",
    "installers",
  ];
  if (!requireKeys(file, data, topLevelKeys, "top-level")) return;
  if (data.currency !== "CAD") return fail(file, `currency must be "CAD", got: ${data.currency}`);

  // alacarteHourlyCents: { day, evening, night }
  if (!requireKeys(file, data.alacarteHourlyCents, ["day", "evening", "night"], "alacarteHourlyCents")) return;
  for (const k of ["day", "evening", "night"]) {
    if (typeof data.alacarteHourlyCents[k] !== "number" || data.alacarteHourlyCents[k] <= 0) {
      return fail(file, `alacarteHourlyCents.${k} must be a positive number`);
    }
  }

  // components: server + app (both required)
  if (!requireKeys(file, data.components, ["server", "app"], "components")) return;
  for (const k of ["server", "app"]) {
    const c = data.components[k];
    if (!requireKeys(file, c, ["id", "displayName", "tagline", "monthlyPriceCents", "stripePriceId"], `components.${k}`)) return;
    if (!requireBilingual(file, c.displayName, `components.${k}.displayName`)) return;
    if (!requireBilingual(file, c.tagline, `components.${k}.tagline`)) return;
    if (typeof c.monthlyPriceCents !== "number" || c.monthlyPriceCents <= 0) {
      return fail(file, `components.${k}.monthlyPriceCents must be a positive number`);
    }
  }

  // supportPacks: array (may be empty if à-la-carte-only)
  if (!Array.isArray(data.supportPacks)) return fail(file, "supportPacks must be an array");
  for (const [i, p] of data.supportPacks.entries()) {
    if (!requireKeys(file, p, ["id", "displayName", "hours", "monthlyPriceCents", "stripePriceId"], `supportPacks[${i}]`)) return;
    if (!requireBilingual(file, p.displayName, `supportPacks[${i}].displayName`)) return;
    if (typeof p.hours !== "number" || p.hours <= 0) {
      return fail(file, `supportPacks[${i}].hours must be a positive number`);
    }
    if (typeof p.monthlyPriceCents !== "number" || p.monthlyPriceCents <= 0) {
      return fail(file, `supportPacks[${i}].monthlyPriceCents must be a positive number`);
    }
  }

  // installers: array
  if (!Array.isArray(data.installers)) return fail(file, "installers must be an array");
  for (const [i, inst] of data.installers.entries()) {
    if (!requireKeys(file, inst, ["id", "displayName", "tagline", "oneTimePriceCents", "stripePriceId"], `installers[${i}]`)) return;
    if (!requireBilingual(file, inst.displayName, `installers[${i}].displayName`)) return;
    if (!requireBilingual(file, inst.tagline, `installers[${i}].tagline`)) return;
    if (typeof inst.oneTimePriceCents !== "number" || inst.oneTimePriceCents <= 0) {
      return fail(file, `installers[${i}].oneTimePriceCents must be a positive number`);
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
