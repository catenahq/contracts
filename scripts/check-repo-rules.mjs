#!/usr/bin/env node
// Rules every catena repo keeps, checked over the repo in the cwd. A consumer
// repo runs it out of the sibling contracts checkout:
//
//   node ../contracts/scripts/check-repo-rules.mjs
//
// Env files. A real env file holds credentials, so no repo tracks one: the
// root .gitignore carries ENV_RULE, in that order, and no tracked file matches
// it. An example (*.env.example) is the only exception. The tracked-file check
// catches what a .gitignore cannot: a file added with git add -f, or one
// tracked before the rule.
//
// Branch names. Everything builds and checks out the branch it runs on, so a
// branch name belongs only where a run is decided (on: triggers, if:
// conditions, a release guard) and in a first-party uses: line, which GitHub
// reads before expressions. BRANCH_RULES flag a branch named where something
// is checked out, installed, compared with or linked to; BRANCH_ALLOW lists
// the release channels that name theirs on purpose.
//
// Wired as a CI step in each repo, next to check-unicode.mjs.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const ENV_RULE = ["*.env", ".env.*", "!*.env.example"];

// The basename test ENV_RULE expresses: ends in .env (a bare .env included)
// or starts with .env., unless it ends in .env.example.
function isEnvFile(path) {
  const base = path.split("/").pop();
  if (base.endsWith(".env.example")) return false;
  return base.endsWith(".env") || base.startsWith(".env.");
}

const problems = [];

const ignoreLines = existsSync(".gitignore")
  ? readFileSync(".gitignore", "utf-8").split("\n").map((l) => l.trim())
  : [];
const at = ENV_RULE.map((line) => ignoreLines.indexOf(line));
ENV_RULE.forEach((line, i) => {
  if (at[i] === -1) problems.push(`.gitignore lacks the line ${line}`);
});
if (at.every((i) => i !== -1) && !(at[0] < at[2] && at[1] < at[2])) {
  problems.push(`.gitignore must list ${ENV_RULE[2]} after ${ENV_RULE[0]} and ${ENV_RULE[1]}, or it re-includes nothing`);
}

const files = execSync("git ls-files", { encoding: "utf-8" }).split("\n").filter(Boolean);
for (const file of files.filter(isEnvFile)) {
  problems.push(`${file} is a tracked env file; untrack it (git rm --cached) and keep its values out of git`);
}

const BRANCH = "(?:main|master|dev|develop)";
// What runs: workflows, actions and scripts. Docs that show a command are
// examples; tests exercise refs on purpose.
const RUNS = /^\.github\/.*\.ya?ml$|(^|\/)action\.ya?ml$|\.(sh|bash|py|mjs|cjs|js|ts)$|(^|\/)Makefile$/;
const TESTS = /(^|\/)(tests?|testdata)\/|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const BRANCH_RULES = [
  { re: new RegExp(`^\\s*ref:\\s*['"]?${BRANCH}['"]?\\s*$`), only: RUNS, what: "a checkout ref" },
  { re: new RegExp(`CATENA_CE_REF[=:]\\s*['"]?${BRANCH}\\b`), only: RUNS, what: "a vendored ref" },
  { re: new RegExp(`go install \\S+@${BRANCH}\\b`), only: RUNS, what: "an install ref" },
  { re: new RegExp(`\\borigin/${BRANCH}\\b`), only: RUNS, what: "a compared ref" },
  { re: new RegExp(`github\\.com/catenahq/[^/\\s]+/(?:edit|blob|tree)/${BRANCH}/`), what: "a link (use HEAD)" },
];

// Release channels: <repo> -> [path pattern, why].
const BRANCH_ALLOW = {
  "catena-ce": [
    [/^\.github\/workflows\/publish-installer\.yml$/,
      "the installer publishes only release tags on main"],
  ],
  "catena-templates": [
    [/^(sources\/[^/]+\.json|catalog\.json|templates\.json)$/,
      "catalog descriptions link the blueprint READMEs on main, the channel hosts read"],
  ],
  ops: [
    [/^automation\/helpers\/digest_sources\.py$/,
      "the monthly digest reports what shipped, which is main"],
    [/^create-catena-release\.sh$/,
      "the release merges dev into main, tags main and fast-forwards dev onto it"],
  ],
  website: [
    [/^\.github\/workflows\/deploy-pages\.yml$/,
      "the daily price refresh starts on the default branch and rebuilds the released site, which is main"],
  ],
};

const SKIP = /(^|\/)(package-lock\.json|[^/]*\.lock|LICEN[CS]E[^/]*)$|\.(png|jpe?g|gif|svg|ico|woff2?|otf|ttf|pdf|zip|gz)$/i;
const origin = (() => {
  try {
    return execSync("git config --get remote.origin.url", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
})();
const repo = (origin || execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim())
  .replace(/\.git$/, "").split("/").pop();
const allowed = BRANCH_ALLOW[repo] || [];

for (const file of files) {
  if (SKIP.test(file) || TESTS.test(file) || allowed.some(([re]) => re.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => {
    for (const rule of BRANCH_RULES) {
      if (rule.only && !rule.only.test(file)) continue;
      if (rule.re.test(line)) {
        problems.push(`${file}:${i + 1}: branch name in ${rule.what}: ${line.trim().slice(0, 100)}`);
      }
    }
  });
}

if (problems.length > 0) {
  console.error("Repo rules broken:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Repo rules: clean (${files.length} tracked file(s)).`);
