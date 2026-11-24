#!/usr/bin/env node
// validate-json.mjs
//
// Walks every .json under the contract directories (brand/, pricing/,
// legal/, default-apps/, host-layout/) and confirms each one parses. Also does the minimum
// shape check per file documented in the per-directory READMEs.
//
// It catches malformed JSON and a missing or ill-typed required key,
// with zero deps.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const CONTRACT_DIRS = ["brand", "pricing", "legal", "default-apps", "host-layout"];

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
  for (const [source, id] of Object.entries(data.alert_intake_sources ?? {})) {
    if (!(id in apps)) fail(file, `alert_intake_sources.${source}: ${id} is not an app of the file`);
    else if (!(apps[id].secrets ?? []).includes(`alert_intake_token_${source}`)) {
      fail(file, `alert_intake_sources.${source}: ${id} does not list alert_intake_token_${source} in secrets`);
    }
  }
  if (failures === before) ok(file);
}

const isUnder = (p, root) => p.startsWith(`${root}/`);

function validateHostLayoutJson(file, data) {
  const groups = ["roots", "data_folders", "files"];
  const lists = ["machine_trees", "data_trees", "backup_set"];
  const exactKeys = (where, obj, keys) => {
    const got = Object.keys(obj).sort().join(", ");
    const want = [...keys].sort().join(", ");
    return got === want || fail(file, `${where} keys must be exactly ${want}, got: ${got}`);
  };
  if (!exactKeys("top-level", data, [...groups, ...lists])) return;
  for (const key of groups) {
    if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) return fail(file, `${key} must be an object`);
  }
  for (const key of lists) {
    if (!Array.isArray(data[key])) return fail(file, `${key} must be an array`);
  }
  if (!exactKeys("roots", data.roots, ["data", "config", "state"])) return;
  if (!exactKeys("data_folders", data.data_folders, ["apps", "compose", "backup_staging", "docker", "volumes"])) return;
  const before = failures;
  const named = [];
  for (const key of groups) for (const [name, p] of Object.entries(data[key])) named.push([`${key}.${name}`, p]);
  for (const key of lists) data[key].forEach((p, i) => named.push([`${key}[${i}]`, p]));
  for (const [where, p] of named) {
    if (typeof p !== "string" || !p.startsWith("/") || p === "/" || p.endsWith("/") || posix.normalize(p) !== p) {
      fail(file, `${where}: must be an absolute, clean path below /, got: ${JSON.stringify(p)}`);
    }
  }
  if (failures > before) return;

  const seen = new Map();
  for (const [where, p] of named.filter(([w]) => groups.some((g) => w.startsWith(`${g}.`)))) {
    if (seen.has(p)) fail(file, `${where}: ${p} is also ${seen.get(p)}`);
    else seen.set(p, where);
  }
  for (const key of lists) {
    const dup = data[key].find((p, i) => data[key].indexOf(p) !== i);
    if (dup !== undefined) fail(file, `${key}: ${dup} appears twice`);
  }

  const { data: dataRoot, config, state } = data.roots;
  for (const [name, p] of Object.entries(data.data_folders)) {
    if (!isUnder(p, dataRoot)) fail(file, `data_folders.${name}: ${p} is not under roots.data ${dataRoot}`);
  }
  for (const [name, p] of Object.entries(data.files)) {
    if (!isUnder(p, config) && !isUnder(p, state)) fail(file, `files.${name}: ${p} is not under roots.config ${config} or roots.state ${state}`);
  }
  if (!data.machine_trees.includes(dataRoot)) fail(file, `machine_trees must hold roots.data ${dataRoot}`);
  for (const p of data.data_trees) {
    if (!data.machine_trees.some((t) => isUnder(p, t))) fail(file, `data_trees: ${p} is not strictly under a machine_trees entry`);
  }
  const folders = Object.values(data.data_folders);
  for (const p of data.backup_set) {
    if ((p === dataRoot || isUnder(p, dataRoot)) && !folders.includes(p)) {
      fail(file, `backup_set: ${p} is under roots.data and is not one of data_folders`);
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
    else if (rel === "host-layout/layout.json") validateHostLayoutJson(rel, parsed);
    else ok(rel);
  }
}

if (failures > 0) {
  console.error(`\n${failures} validation failure(s).`);
  process.exit(1);
}
console.log("\nall json artifacts valid.");
