#!/usr/bin/env node
// validate-json.mjs
//
// Walks every .json under the contract directories (brand/, pricing/,
// legal/, default-apps/) and confirms each one parses. Also does the minimum
// shape check per file documented in the per-directory READMEs.
//
// It catches malformed JSON and a missing or ill-typed required key,
// with zero deps.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const CONTRACT_DIRS = ["brand", "pricing", "legal", "default-apps"];

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

function validateTiersJson(file, data) {
  const topLevelKeys = ["currency", "supportIncrementMinutes", "alacarteHourlyCents"];
  if (!requireKeys(file, data, topLevelKeys, "top-level")) return;
  if (data.currency !== "CAD") return fail(file, `currency must be "CAD", got: ${data.currency}`);

  // alacarteHourlyCents: the one business-hours rate
  if (typeof data.alacarteHourlyCents !== "number" || data.alacarteHourlyCents <= 0) {
    return fail(file, "alacarteHourlyCents must be a positive number");
  }

  ok(file);
}

function validateCheckoutJson(file, data) {
  const editions = ["business", "pro"];
  const keys = Object.keys(data).sort();
  if (keys.join(",") !== editions.join(",")) {
    return fail(file, `keys must be exactly ${editions.join(", ")}, got: ${keys.join(", ")}`);
  }
  for (const edition of editions) {
    const url = data[edition];
    if (typeof url !== "string" || !url.startsWith("https://buy.polar.sh/")) {
      return fail(file, `${edition} must be a https://buy.polar.sh/ checkout link, got: ${url}`);
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

function validateWiringJson(file, data) {
  const apps = data.apps;
  const caps = data.reserved_capabilities;
  if (!apps || typeof apps !== "object") return fail(file, "apps must be an object");
  if (!caps || typeof caps !== "object") return fail(file, "reserved_capabilities must be an object");
  const before = failures;
  for (const [id, app] of Object.entries(apps)) {
    if (app.stack !== `catena-${id}`) fail(file, `${id}: stack must be catena-${id}, got: ${app.stack}`);
    for (const [key, name] of Object.entries(app.volumes ?? {})) {
      if (name !== `${app.stack}_${key}`) fail(file, `${id}: volume ${key} must be named ${app.stack}_${key}, got: ${name}`);
    }
    for (const s of app.sqlite ?? []) {
      if (!(s.volume in (app.volumes ?? {}))) fail(file, `${id}: sqlite volume ${s.volume} is not a volume key`);
    }
    if (app.config_volume !== undefined && !(app.config_volume in (app.volumes ?? {}))) {
      fail(file, `${id}: config_volume ${app.config_volume} is not a volume key`);
    }
    for (const [svc, def] of Object.entries(app.services ?? {})) {
      for (const p of def.ports ?? []) {
        if (!Number.isInteger(p.published) || !Number.isInteger(p.target)) {
          fail(file, `${id}.${svc}: a port pair must be two integers`);
        }
      }
    }
    for (const cap of app.reads ?? []) {
      if (!(cap in caps)) fail(file, `${id}: reads ${cap}, which is not a reserved capability`);
      else if (!caps[cap].readers.includes(id)) fail(file, `${id}: reads ${cap} but is not among its readers`);
    }
    for (const cap of Object.keys(app.provides ?? {})) {
      if (!(cap in caps)) fail(file, `${id}: provides ${cap}, which is not a reserved capability`);
      else if (caps[cap].provider !== id) fail(file, `${id}: provides ${cap} but the provider is ${caps[cap].provider}`);
    }
    for (const key of app.env_core_writes ?? []) {
      if ((app.env_declared ?? []).includes(key)) fail(file, `${id}: ${key} is both written by core and declared`);
    }
  }
  for (const [cap, { provider, readers }] of Object.entries(caps)) {
    if (!(provider in apps)) fail(file, `${cap}: provider ${provider} is not an app of the file`);
    else if (!(cap in (apps[provider].provides ?? {}))) fail(file, `${cap}: ${provider} does not provide it`);
    for (const r of readers) {
      if (!(r in apps)) fail(file, `${cap}: reader ${r} is not an app of the file`);
      else if (!(apps[r].reads ?? []).includes(cap)) fail(file, `${cap}: ${r} does not read it`);
    }
  }
  if (failures === before) ok(file);
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
    else if (rel === "pricing/checkout.json") validateCheckoutJson(rel, parsed);
    else if (rel === "legal/msa.json") validateMsaJson(rel, parsed);
    else if (rel === "default-apps/wiring.json") validateWiringJson(rel, parsed);
    else ok(rel);
  }
}

if (failures > 0) {
  console.error(`\n${failures} validation failure(s).`);
  process.exit(1);
}
console.log("\nall json artifacts valid.");
