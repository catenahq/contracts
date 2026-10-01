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

if (problems.length > 0) {
  console.error("Repo rules broken:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`Repo rules: clean (${files.length} tracked file(s)).`);
