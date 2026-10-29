// The new-failures-only action's script, run over a scratch repo whose base
// commit and head commit hold different gate output. The gate prints
// failures.txt and fails while it is not empty; it also recreates stray.txt,
// which the head commit deletes and the base commit tracks. Run with
// `node scripts/new-failures-only.test.mjs`.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "actions",
  "new-failures-only",
  "new-failures-only.sh",
);

const GATE = "cat failures.txt; echo again > stray.txt; test ! -s failures.txt";
const LINES = "^FAIL [a-z]+";

const work = mkdtempSync(join(tmpdir(), "catena-nfo-test-"));

// A repo with a base commit holding `baseFailures` and a head commit holding
// `headFailures`, left checked out at the head.
function fixture(name, baseFailures, headFailures) {
  const repo = join(work, name);
  execFileSync("git", ["init", "-q", repo]);
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
  writeFileSync(join(repo, "failures.txt"), baseFailures);
  writeFileSync(join(repo, "stray.txt"), "tracked\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "failures.txt"), headFailures);
  git("rm", "-q", "--cached", "stray.txt");
  git("commit", "-q", "-am", "head");
  const head = git("rev-parse", "HEAD");
  return { repo, base, head, git };
}

// `withBase` passes the fixture's base commit as NFO_BASE_SHA; without it the
// gate is absolute.
function run({ repo, base }, withBase, failureLines = LINES) {
  const result = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: work,
      NFO_RUN: GATE,
      NFO_WORKDIR: ".",
      NFO_REPO_PATH: ".",
      NFO_FAILURE_LINES: failureLines,
      NFO_BASE_SHA: withBase ? base : "",
      NFO_REMOTE: `file://${repo}`,
    },
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

// A pull request as GitHub checks it out: `stale` is the base branch when the
// pull request was opened, `main` the base branch since, `pr` the pull
// request's own commit, and the merge commit has main then pr as parents.
// Returns the repo, a 1-deep clone left at the merge commit, and the shas.
function mergeFixture(name, stale, main, pr) {
  const repo = join(work, name);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const git = (cwd, ...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd,
      encoding: "utf-8",
    }).trim();
  const put = (failures) => writeFileSync(join(repo, "failures.txt"), failures);
  put(stale);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "stale base");
  const staleSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "pr");
  put(pr);
  git(repo, "commit", "-q", "-am", "pr");
  const prSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  put(main);
  git(repo, "commit", "-q", "-am", "main moved");
  const mainSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "pr");
  const merge = git(repo, "commit-tree", "HEAD^{tree}", "-p", mainSha, "-p", prSha, "-m", "merge");
  git(repo, "branch", "merge", merge);
  const clone = join(work, `${name}-clone`);
  execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", "merge", `file://${repo}`, clone]);
  return { repo, clone, staleSha, mainSha, prSha, merge };
}

// Runs the script in `cwd` with exactly the given NFO_* and GITHUB_SHA values.
function runIn(cwd, remote, extra, failureLines = LINES) {
  const result = spawnSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: work,
      NFO_RUN: GATE,
      NFO_WORKDIR: ".",
      NFO_REPO_PATH: ".",
      NFO_FAILURE_LINES: failureLines,
      NFO_REMOTE: `file://${remote}`,
      ...extra,
    },
  });
  return { status: result.status, out: result.stdout + result.stderr };
}

function expect(label, got, status, fragments) {
  assert.equal(got.status, status, `${label}: exit ${got.status}\n${got.out}`);
  for (const f of fragments) assert.ok(got.out.includes(f), `${label}: missing "${f}" in\n${got.out}`);
}

try {
  // Base fails, head adds one failure: fail on the new line only.
  let fx = fixture("adds", "FAIL one\n", "FAIL one\nFAIL two\n");
  let got = run(fx, true);
  expect("adds", got, 1, [
    "::error::new failure: FAIL two",
    "::warning::carried from the base: FAIL one",
    "1 new, 1 carried from the base",
  ]);
  assert.ok(!got.out.includes("::error::new failure: FAIL one"));
  assert.equal(fx.git("rev-parse", "HEAD"), fx.head, "head checked back out");
  assert.equal(readFileSync(join(fx.repo, "failures.txt"), "utf-8"), "FAIL one\nFAIL two\n");
  assert.ok(!existsSync(join(fx.repo, "stray.txt")), "untracked gate output cleaned");

  // Base fails identically: pass with warnings.
  fx = fixture("same", "FAIL one\n", "FAIL one\n");
  expect("same", run(fx, true), 0, [
    "::warning::carried from the base: FAIL one",
    "0 new, 1 carried from the base",
  ]);

  // Base passes, head fails: fail.
  fx = fixture("clean-base", "", "FAIL one\n");
  expect("clean-base", run(fx, true), 1, ["::error::new failure: FAIL one", "1 new, 0 carried"]);

  // Head passes: no base run.
  fx = fixture("passes", "FAIL one\n", "");
  got = run(fx, true);
  expect("passes", got, 0, []);
  assert.ok(!got.out.includes("base commit"), got.out);

  // Empty failure-lines: the base failing too passes, a clean base fails.
  fx = fixture("status-same", "FAIL one\n", "FAIL two\n");
  expect("status-same", run(fx, true, ""), 0, ["::warning::new-failures-only: the base commit fails too"]);
  fx = fixture("status-new", "", "FAIL two\n");
  expect("status-new", run(fx, true, ""), 1, ["::error::new-failures-only: the base commit passes"]);

  // A failure the pattern does not identify is judged by the exit status.
  fx = fixture("unmatched", "", "boom\n");
  expect("unmatched", run(fx, true), 1, ["the base commit passes and the head fails"]);

  // No base keeps the absolute gate, with no base run.
  fx = fixture("push", "FAIL one\n", "FAIL one\n");
  got = run(fx, false);
  expect("push", got, 1, ["FAIL one"]);
  assert.ok(!got.out.includes("::warning::") && !got.out.includes("base commit"), got.out);
  fx = fixture("push-clean", "FAIL one\n", "");
  expect("push-clean", run(fx, false), 0, []);

  // A push with a base is judged from it: only the new line fails.
  fx = fixture("push-base", "FAIL one\n", "FAIL one\nFAIL two\n");
  expect("push-base", run(fx, true), 1, [
    "::error::new failure: FAIL two",
    "::warning::carried from the base: FAIL one",
  ]);
  fx = fixture("push-base-same", "FAIL one\n", "FAIL one\n");
  expect("push-base-same", run(fx, true), 0, ["0 new, 1 carried from the base"]);

  // On a pull request the merge commit's first parent is the base, in a full
  // repo and in a 1-deep clone; the event's stale base.sha is ignored. Judged
  // from the stale commit (no failures) FAIL one would be new.
  const mx = mergeFixture("merge", "", "FAIL one\n", "FAIL one\n");
  for (const [label, cwd] of [["merge-full", mx.repo], ["merge-shallow", mx.clone]]) {
    if (cwd === mx.repo) execFileSync("git", ["checkout", "-q", "--detach", mx.merge], { cwd });
    got = runIn(cwd, mx.repo, { GITHUB_SHA: mx.merge, NFO_EVENT_BASE_SHA: mx.staleSha });
    expect(label, got, 0, [`running it at the base commit ${mx.mainSha}`, "0 new, 1 carried from the base"]);
    assert.ok(!got.out.includes(mx.staleSha), `${label}: used the stale event base\n${got.out}`);
  }
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: mx.clone, encoding: "utf-8" }).trim(), mx.merge);

  // A checkout of the pull request's head commit judges from the event's base.
  got = runIn(mx.repo, mx.repo, { GITHUB_SHA: mx.prSha, NFO_EVENT_BASE_SHA: mx.staleSha });
  expect("not-merge", got, 1, [`running it at the base commit ${mx.staleSha}`, "::error::new failure: FAIL one"]);

  // An explicit base wins over the merge commit's parent and the event's base.
  got = runIn(mx.clone, mx.repo, { GITHUB_SHA: mx.merge, NFO_BASE_SHA: mx.staleSha, NFO_EVENT_BASE_SHA: mx.mainSha });
  expect("explicit", got, 1, [`running it at the base commit ${mx.staleSha}`, "::error::new failure: FAIL one"]);

  // Another event with no base keeps the absolute gate, even on a merge commit.
  got = runIn(mx.clone, mx.repo, { GITHUB_SHA: mx.merge });
  expect("absolute", got, 1, ["FAIL one"]);
  assert.ok(!got.out.includes("base commit"), got.out);

  // An unreachable base fails the job.
  fx = fixture("no-base", "FAIL one\n", "FAIL one\n");
  expect("no-base", run({ ...fx, base: "0".repeat(40) }, true), 1, ["cannot fetch the base commit"]);

  // The gate runs the pull request's own code, so it never sees the token.
  fx = fixture("token", "", "");
  const seen = spawnSync("bash", [SCRIPT], {
    cwd: fx.repo,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: work,
      NFO_RUN: 'echo "token=${NFO_TOKEN:-unset}"',
      NFO_REPO_PATH: ".",
      NFO_TOKEN: "s3cr3t-token",
      NFO_BASE_SHA: fx.base,
    },
  });
  assert.equal(seen.status, 0, seen.stdout + seen.stderr);
  assert.ok(seen.stdout.includes("token=unset"), seen.stdout);
  assert.ok(!(seen.stdout + seen.stderr).includes("s3cr3t-token"), "token leaked to the gate");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("new-failures-only: ok");
