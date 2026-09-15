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
//   --changed-since <ref>
//            gate only on files this change touches, measured against the
//            merge-base with <ref>. Everything else is still scanned and still
//            printed, as advisory.
//
// WHY --changed-since EXISTS. Without it the gate asks "does this repository
// have any finding", and a finding landing on the base branch fails every open
// pull request until someone drains it. That is collateral: a dependency bump
// touching one pinned version has no relationship to a comment somebody wrote
// elsewhere, and the bump is what gets blamed. Six of the fifteen open
// dependency PRs across this org were red that way at once.
//
// The absolute question still gets asked, on the push and cron runs of the
// default branch, which is where accumulated prose debt belongs and where it
// cannot be attributed to an unrelated contributor. Same split the image-CVE
// gate already uses: delta on a pull request, absolute on a sweep.
//
// Reporting is deliberately NOT narrowed. A finding outside the diff still
// prints, so nothing goes dark -- it simply does not decide the exit code.
//
// CATENA_VALE_BIN   vale binary (default: vale)
// CATENA_VALE_BATCH files per invocation (default: 100)

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { commentSkeleton } from "./lib/yaml-comments.mjs";
import { shellCommentSkeleton } from "./lib/shell-comments.mjs";

const VALE = process.env.CATENA_VALE_BIN || "vale";
const BATCH = Number(process.env.CATENA_VALE_BATCH || 100);
// The debt file sits in .ci/ or .github/ where the scope has one, so gate
// bookkeeping stays off a repo's landing page. A scope with neither, such
// as ops/internal_docs/sales, keeps it at the top of that scope.
const DEBT_FILE =
  [".ci/prose-debt.txt", ".github/prose-debt.txt"].find(existsSync) || "prose-debt.txt";
const reportAll = process.argv.includes("--all");

// --changed-since <ref>: the set of files allowed to FAIL this run. null means
// every scanned file can (push, cron, and any local run without the flag).
const changedSince = (() => {
  const i = process.argv.indexOf("--changed-since");
  if (i === -1) return null;
  const ref = process.argv[i + 1];
  if (!ref) {
    console.error("--changed-since needs a git ref");
    process.exit(2);
  }
  let base;
  try {
    base = execSync(`git merge-base HEAD ${ref}`, { encoding: "utf-8" }).trim();
  } catch {
    // No merge base reachable (a shallow clone, an unfetched ref). Gate on
    // everything rather than on nothing: a scope that cannot be computed must
    // not silently become empty.
    console.error(`prose: no merge-base with ${ref}; gating on the whole tree`);
    return null;
  }
  // Against the working tree, not HEAD, so an uncommitted fix counts as
  // touched -- the same reason the image-pin scope compares that way.
  const out = execSync(`git diff --name-only ${base}`, { encoding: "utf-8" });
  return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
})();

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
const EXTENSIONS = new Set([".py", ".go", ".js", ".jsx", ".ts", ".tsx"]);

// Vale ships no grammar keyed to .mjs and a `[formats]` entry cannot fix
// it, because formats maps an extension to a MARKUP parser. But the
// content IS JavaScript: only the extension is in the way, so the file
// is copied verbatim to a scratch .js and read by the JavaScript
// grammar. Nothing is rewritten, so positions are exact.
const JS_EXTENSIONS = new Set([".mjs", ".cjs"]);

// YAML and shell have no grammar either, and their content is not some
// other language in disguise, so they take the longer route: each file
// is reduced to a comment skeleton and handed over as .py, which maps
// line and column exactly. One scanner each, because what has to be
// suppressed differs: block scalars in YAML, heredocs in shell.
const SKELETON = new Map([
  [".yml", commentSkeleton],
  [".yaml", commentSkeleton],
  [".sh", shellCommentSkeleton],
  [".bash", shellCommentSkeleton],
]);

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

const tracked = execSync("git ls-files", { encoding: "utf-8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const extOf = (f) => {
  const dot = f.lastIndexOf(".");
  return dot === -1 ? "" : f.slice(dot).toLowerCase();
};

// The rule files quote the tokens they ban, in the comment explaining
// why each one is banned, so they match themselves. Only contracts has
// them in its own tree; elsewhere this filter costs nothing.
const STYLES = join(CONTRACTS, "vale") + "/";
const isStyle = (f) => resolve(f).startsWith(STYLES);

const native = tracked.filter((f) => EXTENSIONS.has(extOf(f)) && !isStyle(f));
const js = tracked.filter((f) => JS_EXTENSIONS.has(extOf(f)) && !isStyle(f));
const skeletal = tracked.filter((f) => SKELETON.has(extOf(f)) && !isStyle(f));

// Both detours write into one scratch directory, named by index so no
// real path has to survive the round trip through Vale. A file whose
// skeleton is blank has no comments and is not written at all, which
// keeps the directory to the files that can produce an alert.
const scratch = js.length + skeletal.length > 0 ? mkdtempSync(join(tmpdir(), "catena-prose-")) : null;
const standInFor = new Map();

function standIn(file, content, ext) {
  const path = join(scratch, `${standInFor.size}${ext}`);
  writeFileSync(path, content);
  standInFor.set(path, file);
}

for (const file of js) {
  standIn(file, readFileSync(file, "utf-8"), ".js");
}

for (const file of skeletal) {
  const skeleton = SKELETON.get(extOf(file))(readFileSync(file, "utf-8"));
  if (skeleton.trim() === "") continue;
  standIn(file, skeleton, ".py");
}

const files = native.concat(js, skeletal);
const toScan = native.concat([...standInFor.keys()]);

if (toScan.length === 0) {
  console.log("Prose: no files in scope.");
  process.exit(0);
}

const alerts = new Map();

for (let i = 0; i < toScan.length; i += BATCH) {
  const batch = toScan.slice(i, i + BATCH);
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
  for (const [reported, found] of Object.entries(JSON.parse(raw || "{}"))) {
    if (!found.length) continue;
    // A stand-in reports under its scratch path; line and column already
    // match the file it came from, so only the name needs swapping back.
    const file = standInFor.get(resolve(reported)) || standInFor.get(reported) || reported;
    alerts.set(file, (alerts.get(file) || []).concat(found));
  }
}

if (scratch) rmSync(scratch, { recursive: true, force: true });

const debt = readDebt();
const findings = [];
const carried = [];
const errorFiles = new Set();

for (const [file, found] of alerts) {
  for (const a of found) {
    if (a.Severity !== "error") continue;
    errorFiles.add(file);
    if (debt.has(file) && !reportAll) continue;
    const line = `${file}:${a.Line}:${a.Span[0]}: ${a.Check}: ${a.Message}`;
    // Outside the change's own files: printed, never gating. Splitting here
    // rather than skipping the scan is what keeps a pre-existing finding
    // visible instead of trading one blind spot for another.
    if (changedSince && !changedSince.has(file)) carried.push(line);
    else findings.push(line);
  }
}

// An exemption for a file that is already clean gates nothing, and hides
// the next regression on that file. Computed from everything SCANNED, not
// from the change's files: the whole tree is still scanned under
// --changed-since, so a debt entry that has gone clean is still detected --
// but only gate on it when the change touched that entry's file, or a
// dependency bump inherits somebody else's bookkeeping.
const inScope = new Set(files);
const staleAll = [...debt.keys()].filter((f) => inScope.has(f) && !errorFiles.has(f));
const stale = changedSince ? staleAll.filter((f) => changedSince.has(f)) : staleAll;
const staleCarried = staleAll.filter((f) => !stale.includes(f));

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
  reportCarried();
  process.exit(1);
}

reportCarried();
console.log(
  `Prose: clean (${files.length} file(s) scanned, ${debt.size} in debt, ${warnings} advisory warning(s)).`,
);

// What this change did not introduce and is not answerable for. Printed on
// every outcome, pass or fail, so the debt stays in view of whoever is reading
// the run instead of only surfacing once it blocks something.
function reportCarried() {
  if (!changedSince || (carried.length === 0 && staleCarried.length === 0)) return;
  console.log("");
  console.log(
    `Carried prose debt, NOT this change's doing (${carried.length} finding(s), ` +
      `${staleCarried.length} stale exemption(s)). The default branch's own ` +
      "push and cron runs gate on these:",
  );
  for (const f of carried) console.log("  " + f);
  for (const f of staleCarried) console.log(`  ${f}: stale exemption in ${DEBT_FILE}`);
}
