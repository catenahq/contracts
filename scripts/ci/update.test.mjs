// update.mjs with a gh stub on PATH: gh answers `gh api <path>` and `gh pr
// list` from a JSON state file built from the payloads under fixtures/update/,
// and logs each POST and PUT to a file. Run with
// `node scripts/ci/update.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "update.mjs");
const load = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", "update", `${name}.json`), "utf-8"));
const [ROW] = load("pr-list");
const [RUN] = load("check-runs").check_runs;
const PULL = load("pull");

const work = mkdtempSync(join(tmpdir(), "catena-update-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

// gh api <path>: state.get[path]; gh api -X POST|PUT <path> -f k=v...: the
// fields, appended as a JSON line to STUB_WRITES. gh pr list: state.pulls of
// the --repo, filtered by --base, projected to --json. state.fail lists
// fragments of a path, or of "pr list <repo>", that answer an error. A read
// under a prefix of state.tokens answers only that token, anything else only
// "tok".
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const fail = (key) => { if ((state.fail || []).some((f) => key.includes(f))) { console.error("gh: HTTP 500"); process.exit(1); } };
const pick = (rows) => { const keys = flag("--json").split(","); return rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]]))); };
const token = process.env.GH_TOKEN;
if (token !== "tok" && !Object.values(state.tokens || {}).includes(token)) { console.error("gh: no token"); process.exit(4); }
if (args[0] === "pr" && args[1] === "list") {
  if (token !== "tok") process.exit(4);
  if (flag("--state") !== "open") process.exit(2);
  const repo = flag("--repo");
  const base = flag("--base");
  fail("pr list " + repo);
  console.log(JSON.stringify(pick((state.pulls[repo] || []).filter((p) => !base || p.baseRefName === base))));
  process.exit(0);
}
if (args[0] !== "api") process.exit(2);
const method = args[1] === "-X" ? args[2] : "GET";
const path = method === "GET" ? args[1] : args[3];
fail(path);
const owner = Object.entries(state.tokens || {}).find(([prefix]) => path.startsWith(prefix));
if (token !== (owner && method === "GET" ? owner[1] : "tok")) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
if (method !== "GET") {
  const fields = { method, path };
  for (let i = 4; i < args.length; i += 2) {
    if (args[i] !== "-f") process.exit(2);
    const [k, ...v] = args[i + 1].split("=");
    fields[k] = v.join("=");
  }
  fs.appendFileSync(process.env.STUB_WRITES, JSON.stringify(fields) + "\\n");
  process.exit(0);
}
if (!(path in state.get)) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
console.log(JSON.stringify(state.get[path]));
`,
);
chmodSync(join(bin, "gh"), 0o755);

const REPO = "catenahq/demo";
const head = (n) => n.toString(16).padStart(40, "0");

// An open pull request of REPO as gh pr list prints it: the recorded row,
// behind main with auto-merge on, created on day <number>.
const pr = (number, { base = "main", state = "BEHIND", draft = false, auto = true, body = "" } = {}) => ({
  ...ROW,
  number,
  baseRefName: base,
  createdAt: `2026-11-${String(number).padStart(2, "0")}T00:00:00Z`,
  mergeStateStatus: state,
  isDraft: draft,
  autoMergeRequest: auto ? ROW.autoMergeRequest : null,
  headRefOid: head(number),
  body,
});
const checkRuns = (n) => `repos/${REPO}/commits/${head(n)}/check-runs?check_name=ci%20%2F%20gate&per_page=100`;
const gateRuns = (n, ...runs) => ({ [checkRuns(n)]: { total_count: runs.length, check_runs: runs.map((r) => ({ ...RUN, head_sha: head(n), ...r })) } });
// The ci / gate check run of a head: completed with the conclusion, or still going.
const gate = (n, conclusion = "success") =>
  gateRuns(n, ["queued", "in_progress"].includes(conclusion) ? { status: conclusion, conclusion: null, completed_at: null } : { conclusion });
const appTests = (n, state) => ({ [`repos/${REPO}/commits/${head(n)}/status?per_page=100`]: { statuses: state ? [{ context: "app-tests", state }] : [] } });
const pull = (repo, number, extra = {}) => ({ [`repos/${repo}/pulls/${number}`]: { ...PULL, number, ...extra } });
const MERGED = { state: "closed", merged_at: "2026-11-20T00:00:00Z" };

let n = 0;
function exec({ pulls = [], get = {}, fail = [], tokens = {} } = {}, { event = "workflow_run", args = [], env = {} } = {}) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const writes = join(dir, "writes");
  const summary = join(dir, "summary");
  writeFileSync(writes, "");
  writeFileSync(summary, "");
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ pulls: { [REPO]: pulls }, get, fail, tokens }));
  // A workflow run's head that no pull request has, unless args name one.
  const runHead = event === "workflow_run" && !args.includes("--sha") ? ["--sha", "9".repeat(40)] : [];
  const r = spawnSync(process.execPath, [SCRIPT, "--repo", REPO, "--event", event, ...runHead, ...args], {
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, GH_TOKEN: "tok", STUB_STATE: state, STUB_WRITES: writes,
      GITHUB_STEP_SUMMARY: summary, ...env,
    },
  });
  const lines = readFileSync(writes, "utf-8").trim().split("\n").filter(Boolean);
  return { status: r.status, out: r.stdout, err: r.stderr, writes: lines.map((l) => JSON.parse(l)), summary: readFileSync(summary, "utf-8") };
}

// The pull requests updated with their base, in order, each with expected_head_sha its listed head.
function expectUpdated(label, got, numbers, said = [], status = 0) {
  assert.equal(got.status, status, `${label}: exit ${got.status}\n${got.err}`);
  const puts = got.writes.filter((w) => w.method === "PUT").map((w) => [w.path, w.expected_head_sha]);
  assert.deepEqual(puts, numbers.map((x) => [`repos/${REPO}/pulls/${x}/update-branch`, head(x)]), `${label}\n${got.out}`);
  for (const s of said) assert.ok(got.out.includes(s), `${label}: '${s}' not in\n${got.out}`);
}

try {
  // The oldest candidate that is behind and green; one without auto-merge is no candidate.
  expectUpdated("oldest green behind", exec({ pulls: [pr(3), pr(2), pr(1, { auto: false })], get: { ...gate(1), ...gate(2), ...gate(3) } }), [2], [
    "main: updated #2 with its base",
  ]);

  // An up-to-date candidate whose gate check run is still going: nothing is updated.
  for (const going of ["in_progress", "queued"]) {
    expectUpdated(`re-validation ${going}`, exec({ pulls: [pr(1, { state: "BLOCKED" }), pr(2)], get: { ...gate(1, going), ...gate(2) } }), [], [
      `main: #1 is up to date and its ci / gate check run is ${going}: nothing updated`,
    ]);
  }
  // One that is up to date and done (waiting for review or its merge) does not hold the others.
  expectUpdated("up to date and done", exec({ pulls: [pr(1, { state: "BLOCKED" }), pr(2)], get: { ...gate(1), ...gate(2) } }), [2], [
    "main: skip #1: not behind its base (BLOCKED)",
  ]);

  // Each skipped, and the next candidate updated.
  const skipped = (label, first, get, said) => expectUpdated(label, exec({ pulls: [first, pr(2)], get: { ...gate(2), ...get } }), [2], [`main: skip #1: ${said}`]);
  skipped("draft", pr(1, { draft: true }), gate(1), "draft");
  skipped("failed", pr(1), gate(1, "failure"), "ci / gate failure");
  skipped("first run going", pr(1), gate(1, "in_progress"), "ci / gate in_progress");
  skipped("DIRTY", pr(1, { state: "DIRTY" }), gate(1), "conflicts with its base (DIRTY)");
  skipped("UNKNOWN", pr(1, { state: "UNKNOWN" }), gate(1), "not behind its base (UNKNOWN)");
  skipped("no gate run", pr(1), gateRuns(1), "no ci / gate check run");
  skipped("another App's check run", pr(1), gateRuns(1, { app: { slug: "other-app" } }), "no ci / gate check run");
  skipped(
    "newest gate run",
    pr(1),
    gateRuns(1, { started_at: "2026-11-21T10:00:00Z" }, { started_at: "2026-11-21T11:00:00Z", conclusion: "failure" }),
    "ci / gate failure",
  );
  const dep = { body: "text\nDepends-on: catenahq/ops#12" };
  skipped("open Depends-on", pr(1, dep), { ...gate(1), ...pull("catenahq/ops", 12) }, "waiting for catenahq/ops#12");
  expectUpdated("merged Depends-on", exec({ pulls: [pr(1, dep), pr(2)], get: { ...gate(1), ...gate(2), ...pull("catenahq/ops", 12, MERGED) } }), [1]);
  // Another repository's pull request is read with GH_READ_TOKEN, the
  // read-only token; the update is written with GH_TOKEN.
  const privateDep = { pulls: [pr(1, dep)], get: { ...gate(1), ...pull("catenahq/ops", 12, MERGED) }, tokens: { "repos/catenahq/ops/": "read" } };
  expectUpdated("read token", exec(privateDep, { env: { GH_READ_TOKEN: "read" } }), [1]);
  assert.equal(exec(privateDep).status, 1, "a dependency GH_TOKEN cannot read is an error");

  // Each base on its own: one update on main and one on release.
  expectUpdated("release base", exec({ pulls: [pr(1), pr(2, { base: "release" }), pr(3, { base: "release" })], get: { ...gate(1), ...gate(2), ...gate(3) } }), [1, 2], [
    "main: updated #1",
    "release: updated #2",
  ]);
  expectUpdated("no candidate", exec({ pulls: [] }), [], ["main: no pull request to update", "release: no pull request to update"]);

  // --apps: app-tests must be success on the head; without the flag it is not read.
  const apps = { pulls: [pr(1), pr(2), pr(3)], get: { ...gate(1), ...gate(2), ...gate(3), ...appTests(1, "pending"), ...appTests(2, null), ...appTests(3, "success") } };
  expectUpdated("app-tests", exec(apps, { args: ["--apps"] }), [3], ["main: skip #1: app-tests pending", "main: skip #2: app-tests not reported"]);
  expectUpdated("app-tests not asked", exec(apps), [1]);

  // A failed update is reported and the next candidate, and the next base,
  // still updated; the run then exits 1.
  const refused = exec({ pulls: [pr(1), pr(2), pr(3, { base: "release" })], get: { ...gate(1), ...gate(2), ...gate(3) }, fail: ["pulls/1/update-branch"] });
  expectUpdated("failed update", refused, [2, 3], ["main: updated #2", "release: updated #3"], 1);
  assert.ok(refused.err.includes("::error::update: main: #1 not updated: gh api -X failed"), refused.err);
  assert.ok(refused.summary.startsWith("- update failed: main: #1 not updated: "), refused.summary);

  // On schedule: every open pull request of the repository.
  const open = {
    pulls: [pr(1, { state: "BLOCKED", ...dep }), pr(2, { state: "BLOCKED", auto: false })],
    get: { ...gate(1), ...gate(2, "in_progress"), ...pull(REPO, 1, dep), ...pull(REPO, 2), ...pull("catenahq/ops", 12, MERGED) },
  };
  const scheduled = exec(open, { event: "schedule" });
  assert.equal(scheduled.status, 0, scheduled.err);
  assert.deepEqual(
    scheduled.writes.map((w) => [w.path, w.state, w.description]),
    [
      [`repos/${REPO}/statuses/${head(1)}`, "success", "no open dependency"],
      [`repos/${REPO}/statuses/${head(2)}`, "pending", "waiting for checks"],
    ],
  );
  // On workflow_run: the open pull requests whose head the run judged, once
  // its checks ended; with --apps dispatch posts it.
  const ran = exec(open, { args: ["--sha", head(1)] });
  assert.equal(ran.status, 0, ran.err);
  assert.deepEqual(ran.writes.map((w) => [w.path, w.state]), [[`repos/${REPO}/statuses/${head(1)}`, "success"]]);
  assert.equal(exec(open, { args: ["--sha", head(1), "--apps"] }).writes.length, 0);
  // A push updates the bases and recomputes no status: each repository's own
  // runs recompute its pull requests.
  const pushed = exec(open, { event: "push" });
  assert.equal(pushed.status, 0, pushed.err);
  assert.equal(pushed.writes.length, 0);

  // A GitHub API error exits 1 and updates nothing: a failed query is never "no candidate".
  const ready = { pulls: [pr(1)], get: gate(1) };
  for (const [label, state, opts] of [
    ["check runs", { ...ready, fail: ["check-runs"] }],
    ["pr list", { ...ready, fail: [`pr list ${REPO}`] }],
    ["app-tests status", ready, { args: ["--apps"] }],
    ["Depends-on pull request", { pulls: [pr(1, dep)], get: gate(1) }],
    ["status recompute", { ...open, fail: [`pulls/1`] }, { event: "schedule" }],
  ]) {
    const got = exec(state, opts);
    assert.equal(got.status, 1, `${label}: exit ${got.status}\n${got.err}`);
    assert.ok(got.err.includes("::error::update: gh "), `${label}\n${got.err}`);
    assert.equal(got.writes.filter((w) => w.method === "PUT").length, 0, label);
  }

  // Bad arguments exit 2 and call nothing.
  for (const args of [
    ["--repo", "x"], ["--event", "pull_request"], ["--event", "workflow_run"], ["--event", "workflow_run", "--sha", "abc"], ["--bogus"],
  ]) {
    const r = spawnSync(process.execPath, [SCRIPT, "--repo", REPO, "--event", "schedule", ...args], {
      encoding: "utf-8",
      env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "tok" },
    });
    assert.equal(r.status, 2, `${args}\n${r.stderr}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("update: ok");
