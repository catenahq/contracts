#!/usr/bin/env node
// Prose gate for code comments. Wraps `vale` and adds the two things it
// does not do on its own.
//
// BATCHING. Vale's tree-sitter binding allocates a query per file and
// does not release it, so memory grows with the number of files in one
// invocation: 659 Python files reached 3 GB and was still climbing, and
// under a 2 GiB cap it aborts with "tree-sitter failed to allocate".
// Files therefore go in batches, and each batch is its own process.
//
// DEBT. Vale has no way to fail on an exemption that has stopped being
// needed. prose-debt.txt lists files that are allowed to have findings,
// one `path -- reason` per line; a listed file with no finding is an
// error, the same contract as banned-words-debt.txt in the unicode gate.
//
// ONE COPY. The rules live in catenahq/contracts and nowhere else. This
// script resolves the config from its own location, so a consumer repo
// runs it out of the sibling checkout and holds no copy of anything:
//
//   node ../contracts/scripts/check-prose.mjs
//
// Scope is the cwd, because `git ls-files` runs there. So the command
// above gates the consumer's tree using the contracts rules, and the
// consumer's own prose-debt.txt is the only prose file it owns.
//
//   --all    report everything including debt, exit 0
//
// CATENA_VALE_BIN   vale binary (default: vale)
// CATENA_VALE_BATCH files per invocation (default: 100)

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALE = process.env.CATENA_VALE_BIN || "vale";
const BATCH = Number(process.env.CATENA_VALE_BATCH || 100);
const DEBT_FILE = "prose-debt.txt";
const reportAll = process.argv.includes("--all");

// Vale resolves StylesPath relative to the config file, so pointing at
// the contracts checkout is enough to find vale/Catena/ inside it.
const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(CONTRACTS, ".vale.ini");

// The rules are written against one Vale version, and its tree-sitter
// grammars decide which comments are visible at all. A runner carrying a
// different version silently changes what the gate sees, so the pin is
// checked rather than trusted. .vale-version is also what the CI install
// step reads, so there is one number.
const PINNED = readFileSync(join(CONTRACTS, ".vale-version"), "utf-8").trim();
const installed = execFileSync(VALE, ["--version"], { encoding: "utf-8" }).trim();
if (!installed.includes(PINNED)) {
  console.error(`vale ${PINNED} is pinned in contracts/.vale-version, found: ${installed}`);
  console.error("Install the pinned version, or change the pin deliberately and re-seed the debt files.");
  process.exit(2);
}

// Extensions Vale has a tree-sitter grammar for AND this workspace uses.
// Absent on purpose: .mjs (Vale ships no grammar for it, and a [formats]
// entry maps to a markup parser, so it would silently scan nothing) and
// .yml (read as plain text, so rules match task names and data values).
const EXTENSIONS = new Set([".py", ".go", ".js", ".jsx", ".ts", ".tsx"]);

function readDebt() {
  const entries = new Map();
  if (!existsSync(DEBT_FILE)) return entries;
  for (const raw of readFileSync(DEBT_FILE, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [path, ...reason] = line.split(/\s+--\s+/);
    entries.set(path.trim(), (reason.join(" -- ") || "").trim());
  }
  return entries;
}

const files = execSync("git ls-files", { encoding: "utf-8" })
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((f) => {
    const dot = f.lastIndexOf(".");
    return dot !== -1 && EXTENSIONS.has(f.slice(dot).toLowerCase());
  });

if (files.length === 0) {
  console.log("Prose: no files in scope.");
  process.exit(0);
}

const alerts = new Map();

for (let i = 0; i < files.length; i += BATCH) {
  const batch = files.slice(i, i + BATCH);
  let raw;
  try {
    raw = execFileSync(VALE, ["--no-exit", `--config=${CONFIG}`, "--output=JSON", ...batch], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    console.error(`vale failed on a batch of ${batch.length} file(s) starting at ${batch[0]}:`);
    console.error(err.stderr || err.message);
    process.exit(2);
  }
  for (const [file, found] of Object.entries(JSON.parse(raw || "{}"))) {
    if (!found.length) continue;
    alerts.set(file, (alerts.get(file) || []).concat(found));
  }
}

const debt = readDebt();
const findings = [];
const errorFiles = new Set();

for (const [file, found] of alerts) {
  for (const a of found) {
    if (a.Severity !== "error") continue;
    errorFiles.add(file);
    if (debt.has(file) && !reportAll) continue;
    findings.push(`${file}:${a.Line}:${a.Span[0]}: ${a.Check}: ${a.Message}`);
  }
}

// An exemption for a file that is already clean gates nothing, and hides
// the next regression on that file.
const tracked = new Set(files);
const stale = [...debt.keys()].filter((f) => tracked.has(f) && !errorFiles.has(f));

const warnings = [...alerts.values()]
  .flat()
  .filter((a) => a.Severity === "warning").length;

if (reportAll) {
  for (const f of findings) console.log(f);
  console.log("");
  console.log(`${findings.length} error(s), ${warnings} warning(s) across ${files.length} file(s).`);
  process.exit(0);
}

if (findings.length > 0 || stale.length > 0) {
  if (findings.length > 0) {
    console.error("Comments carry history, a plan reference, or a negative definition:");
    console.error("");
    for (const f of findings) console.error("  " + f);
    console.error("");
    console.error(`Total: ${findings.length} error(s).`);
    console.error(
      `Describe what the code does now. A file that cannot be fixed yet goes in ${DEBT_FILE} with the reason.`,
    );
  }
  if (stale.length > 0) {
    console.error("");
    console.error(`Stale entries in ${DEBT_FILE} (these files are clean now):`);
    for (const f of stale) console.error("  " + f);
    console.error("Delete them, or the gate stops gating those files.");
  }
  process.exit(1);
}

console.log(
  `Prose: clean (${files.length} file(s) scanned, ${debt.size} in debt, ${warnings} advisory warning(s)).`,
);
