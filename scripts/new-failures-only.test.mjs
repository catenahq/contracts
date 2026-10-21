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

function run({ repo, base }, event, failureLines = LINES) {
  const result = spawnSync("bash", [SCRIPT], {
    cwd: repo,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: work,
      GITHUB_EVENT_NAME: event,
      NFO_RUN: GATE,
      NFO_WORKDIR: ".",
      NFO_REPO_PATH: ".",
      NFO_FAILURE_LINES: failureLines,
      NFO_BASE_SHA: base,
      NFO_REMOTE: `file://${repo}`,
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
  let got = run(fx, "pull_request");
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
  expect("same", run(fx, "pull_request"), 0, [
    "::warning::carried from the base: FAIL one",
    "0 new, 1 carried from the base",
  ]);

  // Base passes, head fails: fail.
  fx = fixture("clean-base", "", "FAIL one\n");
  expect("clean-base", run(fx, "pull_request"), 1, ["::error::new failure: FAIL one", "1 new, 0 carried"]);

  // Head passes: no base run.
  fx = fixture("passes", "FAIL one\n", "");
  got = run(fx, "pull_request");
  expect("passes", got, 0, []);
  assert.ok(!got.out.includes("base commit"), got.out);

  // Empty failure-lines: the base failing too passes, a clean base fails.
  fx = fixture("status-same", "FAIL one\n", "FAIL two\n");
  expect("status-same", run(fx, "pull_request", ""), 0, ["::warning::new-failures-only: the base commit fails too"]);
  fx = fixture("status-new", "", "FAIL two\n");
  expect("status-new", run(fx, "pull_request", ""), 1, ["::error::new-failures-only: the base commit passes"]);

  // A failure the pattern does not identify is judged by the exit status.
  fx = fixture("unmatched", "", "boom\n");
  expect("unmatched", run(fx, "pull_request"), 1, ["the base commit passes and the head fails"]);

  // Anything but a pull request keeps the absolute gate, with no base run.
  fx = fixture("push", "FAIL one\n", "FAIL one\n");
  got = run(fx, "push");
  expect("push", got, 1, ["FAIL one"]);
  assert.ok(!got.out.includes("::warning::") && !got.out.includes("base commit"), got.out);
  fx = fixture("push-clean", "FAIL one\n", "");
  expect("push-clean", run(fx, "push"), 0, []);

  // An unreachable base fails the job.
  fx = fixture("no-base", "FAIL one\n", "FAIL one\n");
  expect("no-base", run({ ...fx, base: "0".repeat(40) }, "pull_request"), 1, ["cannot fetch the base commit"]);

  // The gate runs the pull request's own code, so it never sees the token.
  fx = fixture("token", "", "");
  const seen = spawnSync("bash", [SCRIPT], {
    cwd: fx.repo,
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: work,
      GITHUB_EVENT_NAME: "pull_request",
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
