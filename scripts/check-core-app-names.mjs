#!/usr/bin/env node
// Core code names structural services only. This gate counts the app names
// listed in core-app-names.json (whole words, case-insensitive) in the files
// under the roots given on the command line, and compares each file's count
// with the repo's debt file and its exceptions file. A consumer runs it out of
// the sibling contracts checkout, from its own root:
//
//   node ../contracts/scripts/check-core-app-names.mjs .
//   node ../contracts/scripts/check-core-app-names.mjs --exclude central/ .
//   node ../contracts/scripts/check-core-app-names.mjs --update .
//
// DEBT. core-app-names-debt.json (in .ci/ or .github/, else beside the cwd)
// maps path -> count. A path whose count rises, or that is not listed, fails.
// A path whose count falls below its entry fails too, until the debt file is
// lowered, so the debt only shrinks. --update rewrites the file to the current
// counts, and refuses when any count rose. A repo with no debt file is seeded
// by --update.
//
// ACCEPTED USES. core-app-names-exceptions.json (found the same way) holds
// {"reasons": {key: sentence}, "files": {path: {"names": [...], "reason": key
// or a sentence of 20+ characters}}}. A listed name may appear any number of
// times in its file; ["*"] accepts any name. The gate fails on a counted name
// the entry lacks, a listed name or path the file does not hold,
// a path also in the debt file, an unknown name and a bad reason. --update
// drops stale names and paths and never adds or widens an entry.
//
// MATCH. A name matches when no letter or digit touches it, so "nextcloud_dir"
// and "nextcloud-s3" match and "mynextcloud" does not. Every tracked file under
// the roots is read, except binary files, images, lock files, scanner output
// (.sarif) and the two files above (a copy elsewhere is counted). A root of
// "." is the whole repository; --exclude <path> (repeatable) drops a path
// prefix from the scan and from both files. A `bench:<scenario>` gate pointer
// is removed before counting.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP =
  /(^|\/)(package-lock\.json|[^/]*\.lock)$|\.(png|jpe?g|gif|svg|ico|woff2?|otf|ttf|pdf|zip|gz|sarif)$/i;
const GATE_POINTER = /`(bench|audit|workflow|scanctl|semgrep|threat):[A-Za-z0-9_./#-]+`/g;

const args = process.argv.slice(2);
let update = false;
const roots = [];
const excludes = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--update") update = true;
  else if (args[i] === "--exclude") excludes.push(args[++i] ?? "");
  else if (!args[i].startsWith("--")) roots.push(args[i]);
}
if (roots.length === 0 || excludes.includes("")) {
  console.error("usage: check-core-app-names.mjs [--update] [--exclude <path>]... <root>...");
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

const prefixOf = (r) => r.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
const under = (p, r) => {
  const x = prefixOf(r);
  return x === "" || x === "." || p === x || p.startsWith(x + "/");
};
// Paths under the roots and outside the excludes: anything else belongs to another run.
const inScope = (p) => roots.some((r) => under(p, r)) && !excludes.some((e) => under(p, e));

const locate = (name) =>
  [`.ci/${name}`, `.github/${name}`].find(existsSync) || (existsSync(".github") ? `.github/${name}` : name);
const DEBT_FILE = locate("core-app-names-debt.json");
const EXC_FILE = locate("core-app-names-exceptions.json");

const files = execFileSync("git", ["ls-files", "-z", "--", ...roots], { encoding: "utf-8" })
  .split("\0")
  .filter((f) => f && existsSync(f) && !SKIP.test(f) && f !== DEBT_FILE && f !== EXC_FILE && inScope(f));

// counts: path -> {name -> n}
const counts = Object.create(null);
for (const file of files) {
  const data = readFileSync(file);
  if (data.includes(0)) continue;
  const text = data.toString("utf-8").replace(GATE_POINTER, (m, kind) => (kind === "bench" ? " " : m));
  const found = Object.create(null);
  for (const m of text.match(NAMES) || []) found[m.toLowerCase()] = (found[m.toLowerCase()] || 0) + 1;
  if (Object.keys(found).length > 0) counts[file] = found;
}
const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);

const debt = existsSync(DEBT_FILE) ? JSON.parse(readFileSync(DEBT_FILE, "utf-8")) : {};
const exc = existsSync(EXC_FILE) ? JSON.parse(readFileSync(EXC_FILE, "utf-8")) : {};
const reasons = exc.reasons || {};
const accepted = Object.fromEntries(Object.entries(exc.files || {}).filter(([p]) => inScope(p)));

// Accepted uses: errors are hand edits; stale names and paths are what --update drops.
const errors = [];
const forgiven = [];
const stalePaths = [];
const staleNames = Object.create(null);
const reasonCount = Object.create(null);
let acceptedNames = 0;
for (const [p, e] of Object.entries(accepted).sort(([a], [b]) => (a < b ? -1 : 1))) {
  const key = Object.hasOwn(reasons, e.reason) ? e.reason : null;
  const tag = `${p} (accepted: ${key || e.reason})`;
  if (!key && !(typeof e.reason === "string" && e.reason.length >= 20)) {
    errors.push(`${p}: reason is neither a key of "reasons" nor a sentence of 20 characters at least`);
  }
  const names = (e.names || []).map((n) => n.toLowerCase());
  const unknown = names.filter((n) => n !== "*" && !config.apps.includes(n));
  for (const n of unknown) errors.push(`${tag}: "${n}" is not in core-app-names.json apps`);
  const held = counts[p];
  if (!held) {
    stalePaths.push(p);
    forgiven.push(`${tag}: holds no counted name or is not tracked`);
    continue;
  }
  if (Object.hasOwn(debt, p)) forgiven.push(`${tag}: also in the debt file`);
  if (!names.includes("*")) {
    for (const n of Object.keys(held)) if (!names.includes(n)) errors.push(`${tag}: holds "${n}", not listed`);
    const stale = names.filter((n) => !unknown.includes(n) && !Object.hasOwn(held, n));
    if (stale.length > 0) staleNames[p] = stale;
    for (const n of stale) forgiven.push(`${tag}: lists "${n}", which the file no longer holds`);
  }
  const k = key || "other";
  const n = total(held);
  reasonCount[k] = (reasonCount[k] || 0) + n;
  acceptedNames += n;
}

// Debt: accepted paths owe nothing.
const owed = Object.create(null);
for (const [p, c] of Object.entries(counts)) if (!Object.hasOwn(accepted, p)) owed[p] = total(c);
const paths = [...new Set([...Object.keys(owed), ...Object.keys(debt).filter(inScope)])].sort();

const rose = [];
const fell = [];
for (const p of paths) {
  const now = owed[p] || 0;
  const was = Object.hasOwn(debt, p) ? debt[p] : 0;
  if (now > was) rose.push(`${p}: ${now} (debt ${was})`);
  else if (now < was && !Object.hasOwn(accepted, p)) fell.push(`${p}: ${now} (debt ${was})`);
}

if (update) {
  if (errors.length > 0) {
    console.error("Accepted uses need a hand edit; --update never adds or widens one:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  if (rose.length > 0 && existsSync(DEBT_FILE)) {
    console.error("App names rose; fix the code, --update only lowers the debt:");
    for (const r of rose) console.error(`  ${r}`);
    process.exit(1);
  }
  const next = Object.fromEntries(
    Object.entries(debt).filter(([p]) => !inScope(p)).concat(Object.entries(owed)).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  mkdirSync(dirname(DEBT_FILE), { recursive: true });
  writeFileSync(DEBT_FILE, JSON.stringify(next, null, 2) + "\n");
  if (stalePaths.length > 0 || Object.keys(staleNames).length > 0) {
    const files = Object.fromEntries(
      Object.entries(exc.files).filter(([p]) => !stalePaths.includes(p)).map(([p, e]) => [
        p,
        Object.hasOwn(staleNames, p) ? { ...e, names: e.names.filter((n) => !staleNames[p].includes(n.toLowerCase())) } : e,
      ]),
    );
    writeFileSync(EXC_FILE, JSON.stringify({ ...exc, files }, null, 2) + "\n");
  }
  console.log(`Core app names: ${DEBT_FILE} written (${Object.keys(next).length} path(s)).`);
  process.exit(0);
}

if (rose.length > 0 || fell.length > 0 || errors.length > 0 || forgiven.length > 0) {
  if (rose.length > 0) {
    console.error("App names in core rose or appeared in a new path (core names structural services only):");
    for (const r of rose) console.error(`  ${r}`);
  }
  if (fell.length > 0) {
    const ex = excludes.map((e) => `--exclude ${e} `).join("");
    console.error(`App names fell; lower ${DEBT_FILE} with: node ../contracts/scripts/check-core-app-names.mjs --update ${ex}${roots.join(" ")}`);
    for (const f of fell) console.error(`  ${f}`);
  }
  if (errors.length + forgiven.length > 0) {
    console.error(`Accepted uses in ${EXC_FILE} do not match the files:`);
    for (const e of [...errors, ...forgiven]) console.error(`  ${e}`);
  }
  process.exit(1);
}
const byReason = Object.entries(reasonCount).map(([k, n]) => `${k}: ${n}`).join(", ");
console.log(
  `Core app names: clean (${files.length} file(s) scanned; ${total(owed)} in debt over ${Object.keys(owed).length} file(s); ` +
    `${acceptedNames} accepted over ${Object.keys(accepted).length} file(s)${byReason ? ` (${byReason})` : ""}).`,
);
