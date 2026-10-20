#!/usr/bin/env node
// Core code names structural services only. This gate counts the app names
// listed in core-app-names.json (whole words, case-insensitive) in the files
// under the roots given on the command line, and compares each file's count
// with the repo's debt file. A consumer runs it out of the sibling contracts
// checkout, from its own root:
//
//   node ../contracts/scripts/check-core-app-names.mjs ansible/
//   node ../contracts/scripts/check-core-app-names.mjs payload/ shell/
//   node ../contracts/scripts/check-core-app-names.mjs --update ansible/
//
// DEBT. core-app-names-debt.json (in .ci/ or .github/, else beside the cwd)
// maps path -> count. A path whose count rises, or that is not listed, fails.
// A path whose count falls below its entry fails too, until the debt file is
// lowered, so the debt only shrinks. --update rewrites the file to the current
// counts, and refuses when any count rose. A repo with no debt file is seeded
// by --update.
//
// MATCH. A name matches when no letter or digit touches it, so "nextcloud_dir"
// and "nextcloud-s3" match and "mynextcloud" does not. Every tracked file under
// the roots is read, except binary files, images and lock files.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = /(^|\/)(package-lock\.json|[^/]*\.lock)$|\.(png|jpe?g|gif|svg|ico|woff2?|otf|ttf|pdf|zip|gz)$/i;

const args = process.argv.slice(2);
const update = args.includes("--update");
const roots = args.filter((a) => !a.startsWith("--"));
if (roots.length === 0) {
  console.error("usage: check-core-app-names.mjs [--update] <root>...");
  process.exit(2);
}

const config = JSON.parse(readFileSync(join(CONTRACTS, "core-app-names.json"), "utf-8"));
const clash = config.apps.filter((n) => config.structural.includes(n));
if (clash.length > 0) {
  console.error(`core-app-names.json lists ${clash.join(", ")} as both app and structural`);
  process.exit(2);
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAMES = new RegExp(`(?<![A-Za-z0-9])(?:${config.apps.map(escape).join("|")})(?![A-Za-z0-9])`, "gi");

const files = execFileSync("git", ["ls-files", "-z", "--", ...roots], { encoding: "utf-8" })
  .split("\0")
  .filter((f) => f && existsSync(f) && !SKIP.test(f));

const counts = {};
for (const file of files) {
  const data = readFileSync(file);
  if (data.includes(0)) continue;
  const n = (data.toString("utf-8").match(NAMES) || []).length;
  if (n > 0) counts[file] = n;
}

const DEBT_FILE =
  [".ci/core-app-names-debt.json", ".github/core-app-names-debt.json"].find(existsSync) ||
  (existsSync(".github") ? ".github/core-app-names-debt.json" : "core-app-names-debt.json");
const debt = existsSync(DEBT_FILE) ? JSON.parse(readFileSync(DEBT_FILE, "utf-8")) : {};

// Paths under the roots only: a debt entry outside them belongs to another run.
const inRoots = (p) => roots.some((r) => p === r || p.startsWith(r.endsWith("/") ? r : r + "/"));
const paths = [...new Set([...Object.keys(counts), ...Object.keys(debt).filter(inRoots)])].sort();

const rose = [];
const fell = [];
for (const p of paths) {
  const now = counts[p] || 0;
  const was = debt[p] || 0;
  if (now > was) rose.push(`${p}: ${now} (debt ${was})`);
  else if (now < was) fell.push(`${p}: ${now} (debt ${was})`);
}

if (update) {
  if (rose.length > 0 && existsSync(DEBT_FILE)) {
    console.error("App names rose; fix the code, --update only lowers the debt:");
    for (const r of rose) console.error(`  ${r}`);
    process.exit(1);
  }
  const next = Object.fromEntries(
    Object.entries(debt).filter(([p]) => !inRoots(p)).concat(Object.entries(counts)).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  mkdirSync(dirname(DEBT_FILE), { recursive: true });
  writeFileSync(DEBT_FILE, JSON.stringify(next, null, 2) + "\n");
  console.log(`Core app names: ${DEBT_FILE} written (${Object.keys(next).length} path(s)).`);
  process.exit(0);
}

if (rose.length > 0 || fell.length > 0) {
  if (rose.length > 0) {
    console.error("App names in core rose or appeared in a new path (core names structural services only):");
    for (const r of rose) console.error(`  ${r}`);
  }
  if (fell.length > 0) {
    console.error(`App names fell; lower ${DEBT_FILE} with: node ../contracts/scripts/check-core-app-names.mjs --update ${roots.join(" ")}`);
    for (const f of fell) console.error(`  ${f}`);
  }
  process.exit(1);
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`Core app names: clean (${files.length} file(s) scanned, ${total} name(s) in debt).`);
