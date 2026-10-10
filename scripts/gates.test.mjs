// The gates, run over a scratch repo whose working tree has deleted tracked
// files: one the prose gate hands to vale, and one of each kind it reads
// itself. Both debt files list one of them. Run with
// `node scripts/gates.test.mjs`.
//
// The prose gate runs against a stand-in for vale (CATENA_VALE_BIN) that
// reports the pinned version and, as vale does, stops on a batch naming a
// file that does not exist:
//
//   E100 [doLint] Runtime error
//   argument '.../gone.py' does not exist
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const PINNED = readFileSync(join(SCRIPTS, "..", ".vale-version"), "utf-8").trim();

const work = mkdtempSync(join(tmpdir(), "catena-gates-test-"));
const repo = join(work, "repo");
const vale = join(work, "vale");

writeFileSync(
  vale,
  `#!/usr/bin/env node
const { existsSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("vale version ${PINNED}");
  process.exit(0);
}
const missing = args.find((a) => !a.startsWith("--") && !existsSync(a));
if (missing) {
  console.error("E100 [doLint] Runtime error\\n\\nargument '" + missing + "' does not exist");
  process.exit(2);
}
console.log("{}");
`,
);
chmodSync(vale, 0o755);

const files = {
  ".gitignore": "*.env\n.env.*\n!*.env.example\n",
  ".github/prose-debt.txt": "gone.py -- fixture\n",
  ".github/banned-words-debt.txt": "gone.py -- fixture\n",
  "kept.py": "# a comment\n",
  "gone.py": "# a comment\n",
  "gone.mjs": "// a comment\n",
  "gone.sh": "# a comment\n",
};
mkdirSync(join(repo, ".github"), { recursive: true });
for (const [path, body] of Object.entries(files)) writeFileSync(join(repo, path), body);

const git = (...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: repo,
    stdio: "pipe",
  });
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "fixture");
for (const path of ["gone.py", "gone.mjs", "gone.sh"]) unlinkSync(join(repo, path));

function check(script, expected) {
  const run = spawnSync(process.execPath, [join(SCRIPTS, script)], {
    cwd: repo,
    env: { ...process.env, CATENA_VALE_BIN: vale },
    encoding: "utf-8",
  });
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 0, `${script} exited ${run.status}:\n${output}`);
  assert.ok(output.includes(expected), `${script} printed:\n${output}\nexpected: ${expected}`);
}

try {
  // A deleted path is out of scope, and so is its debt entry: the verdict
  // the tree gets once the deletion is committed.
  check("check-prose.mjs", "Prose: clean (1 file(s) scanned, 1 in debt");
  check("check-unicode.mjs", "Unicode hygiene: clean (4 file(s) in scope)");
  check("check-repo-rules.mjs", "Repo rules: clean");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("gates: ok");
