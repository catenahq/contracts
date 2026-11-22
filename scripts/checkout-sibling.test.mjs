// checkout-sibling's resolve.sh, run with a git stub on PATH that answers
// ls-remote from a JSON state file and logs each call with the token it
// carried. Run with `node scripts/checkout-sibling.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RESOLVE = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "actions", "checkout-sibling", "resolve.sh");

const work = mkdtempSync(join(tmpdir(), "catena-checkout-sibling-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

// git ls-remote --heads <url> refs/heads/<b>: a line when state.branches[<repo>] holds b.
writeFileSync(
  join(bin, "git"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const args = process.argv.slice(2);
const header = process.env.GIT_CONFIG_VALUE_0 || "";
const auth = header ? Buffer.from(header.replace(/^AUTHORIZATION: basic /, ""), "base64").toString().replace(/^x-access-token:/, "") : "none";
fs.appendFileSync(process.env.STUB_LOG, "git " + args.join(" ") + " [auth " + auth + "]\\n");
if (args[0] !== "ls-remote" || args[1] !== "--heads" || state.gitFail) process.exit(128);
const repo = args[2].replace(/^https:\\/\\/github.com\\//, "").replace(/\\.git$/, "");
const b = args[3].replace(/^refs\\/heads\\//, "");
if (((state.branches || {})[repo] || []).includes(b)) console.log("c".repeat(40) + "\\t" + args[3]);
`,
);
chmodSync(join(bin, "git"), 0o755);

let n = 0;
function resolve(env, state = { branches: { "catenahq/sib": ["main", "dev", "feature", "renovate/x", "merge-back/x"] } }) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const files = { STUB_STATE: join(dir, "state.json"), STUB_LOG: join(dir, "calls.log") };
  writeFileSync(files.STUB_STATE, JSON.stringify(state));
  writeFileSync(files.STUB_LOG, "");
  const r = spawnSync("bash", [RESOLVE], {
    encoding: "utf-8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, GITHUB_WORKSPACE: dir, REPOSITORY: "catenahq/sib", ...files, ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr, ref: r.stdout.trim(), calls: readFileSync(files.STUB_LOG, "utf-8") };
}

const lockFile = (text) => {
  const file = join(work, `lock${n++}`);
  writeFileSync(file, text);
  return file;
};

try {
  const LOCKED = "5".repeat(40);
  const lock = lockFile(`# pins\n\ncatenahq/other ${"6".repeat(40)} # main\ncatenahq/sib ${LOCKED} # main\n`);
  const ref = (env) => {
    const r = resolve({ LOCK: lock, ...env });
    assert.equal(r.status, 0, r.out);
    return r.ref;
  };

  // The same-named branch of the run wins when the sibling has it, else the
  // lock's commit; the base branch never applies.
  const pr = { EVENT: "pull_request", BASE_REF: "dev" };
  assert.equal(ref({ ...pr, HEAD_REF: "nope" }), LOCKED, "lock hit");
  assert.ok(resolve({ LOCK: lock, ...pr, HEAD_REF: "nope" }).out.includes(`catenahq/sib: ${LOCKED} (lock)`));
  assert.equal(ref({ ...pr, HEAD_REF: "feature" }), "feature", "same-named branch wins over the lock");
  assert.equal(ref({ EVENT: "pull_request_target", HEAD_REF: "feature" }), "feature", "pull_request_target");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "dev" }), "dev", "push branch");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "nope" }), LOCKED, "push branch the sibling lacks");

  // Bot branches are never paired: Renovate, engine-bump, scanctl and
  // merge-back name branches per repository.
  assert.equal(ref({ ...pr, HEAD_REF: "renovate/x" }), LOCKED, "bot branch skipped");
  assert.equal(ref({ ...pr, HEAD_REF: "merge-back/x" }), LOCKED, "merge-back branch skipped");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "renovate/x" }), LOCKED, "bot push skipped");
  assert.equal(resolve({ LOCK: lock, ...pr, HEAD_REF: "renovate/x" }).calls, "", "a bot branch is not looked up");

  // A run on its own default branch takes the lock's commit; the BRANCH input
  // is taken as given, even when it is the default branch.
  const onDefault = { DEFAULT_BRANCH: "main" };
  assert.equal(ref({ ...onDefault, EVENT: "push", REF_TYPE: "branch", REF_NAME: "main" }), LOCKED, "run on its default branch");
  assert.equal(ref({ ...onDefault, ...pr, HEAD_REF: "nope" }), LOCKED, "no default branch fallback");
  assert.equal(ref({ ...onDefault, EVENT: "push", REF_TYPE: "branch", REF_NAME: "feature" }), "feature");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "main" }), "main", "main is a branch like another off the default");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "tag", REF_NAME: "v1.0.0" }), LOCKED, "tag push");
  assert.equal(ref({ ...onDefault, EVENT: "push", REF_TYPE: "tag", REF_NAME: "v1.0.0", BRANCH: "main" }), "main", "branch input");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "dev", BRANCH: "feature" }), "feature", "branch input over the run's");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "tag", REF_NAME: "v1.0.0", BRANCH: "nope" }), LOCKED, "branch input the sibling lacks");

  // The lock file defaults to .github/catenahq.lock under the workspace.
  const ws = join(work, "ws");
  mkdirSync(join(ws, ".github"), { recursive: true });
  writeFileSync(join(ws, ".github", "catenahq.lock"), `catenahq/sib ${LOCKED} # main\n`);
  let got = resolve({ GITHUB_WORKSPACE: ws, ...pr, HEAD_REF: "nope" });
  assert.equal(got.status, 0, got.out);
  assert.equal(got.ref, LOCKED, got.out);

  // tip ignores the lock, even a missing one, and looks nothing up.
  got = resolve({ LOCK: join(work, "absent.lock"), ...pr, HEAD_REF: "feature", TIP: "true" });
  assert.equal(got.status, 0, got.out);
  assert.equal(got.ref, "", "tip is the default branch");
  assert.equal(got.calls, "");

  // The token reaches git in the environment.
  got = resolve({ LOCK: lock, EVENT: "push", REF_TYPE: "branch", REF_NAME: "dev", TOKEN: "s3cr3t-token" });
  assert.ok(got.calls.includes("refs/heads/dev [auth s3cr3t-token]"), got.calls);
  assert.ok(!got.out.includes("s3cr3t-token"), got.out);

  // An unreadable sibling fails: a failed lookup is not "no branch".
  got = resolve({ LOCK: lock, EVENT: "push", REF_TYPE: "branch", REF_NAME: "dev" }, { gitFail: true });
  assert.notEqual(got.status, 0, got.out);

  // A missing lock file, a lock without a line for the sibling and a
  // malformed line fail, whichever sibling the line names.
  const absent = join(work, "absent.lock");
  got = resolve({ LOCK: absent, ...pr, HEAD_REF: "feature" });
  assert.equal(got.status, 1, got.out);
  assert.ok(got.out.includes(`${absent} is missing`), got.out);
  got = resolve({ GITHUB_WORKSPACE: join(work, "empty"), ...pr, HEAD_REF: "feature" });
  assert.equal(got.status, 1, got.out);
  assert.ok(got.out.includes("/.github/catenahq.lock is missing"), got.out);
  got = resolve({ LOCK: lock, ...pr, HEAD_REF: "nope", REPOSITORY: "catenahq/absent" });
  assert.equal(got.status, 1, got.out);
  assert.ok(got.out.includes(`${lock} has no line for catenahq/absent`), got.out);
  for (const bad of [`catenahq/sib ${"5".repeat(39)}`, `catenahq/sib ${"5".repeat(41)} # main`, "catenahq/sib", `catenahq/sib ${"G".repeat(40)}`]) {
    got = resolve({ LOCK: lockFile(`${bad}\n`), ...pr, HEAD_REF: "nope" });
    assert.equal(got.status, 1, `${bad}\n${got.out}`);
    assert.ok(got.out.includes(`malformed line '${bad}'`), got.out);
  }
  got = resolve({ LOCK: lockFile(`catenahq/sib ${LOCKED}\ncatenahq/bad\n`), ...pr, HEAD_REF: "nope" });
  assert.equal(got.status, 1, "a malformed line for another sibling fails");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("checkout-sibling: ok");
