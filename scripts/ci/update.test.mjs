// update.mjs with a gh stub on PATH: gh answers `gh api <path>`, `gh pr list`
// and `gh search prs` from a JSON state file built from the payloads under
// fixtures/update/, and logs each POST and PUT to a file. Run with
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
const [MERGED_PULL] = load("commit-pulls");
const [HIT] = load("search-prs");
const PULL = load("pull");
const CONTENTS = load("contents");

const work = mkdtempSync(join(tmpdir(), "catena-update-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

// gh api <path>: state.get[path]; gh api -X POST|PUT <path> -f k=v...: the
// fields, appended as a JSON line to STUB_WRITES. gh pr list: state.pulls of
// the --repo, filtered by --base, projected to --json. gh search prs:
// state.search[<query>], projected to --json. state.fail lists fragments of a
// path, or of "pr list <repo>" and "search <query>", that answer an error.
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const fail = (key) => { if ((state.fail || []).some((f) => key.includes(f))) { console.error("gh: HTTP 500"); process.exit(1); } };
const pick = (rows) => { const keys = flag("--json").split(","); return rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]]))); };
if (process.env.GH_TOKEN !== "tok") { console.error("gh: no token"); process.exit(4); }
if (args[0] === "pr" && args[1] === "list") {
  if (flag("--state") !== "open") process.exit(2);
  const repo = flag("--repo");
  const base = flag("--base");
  fail("pr list " + repo);
  console.log(JSON.stringify(pick((state.pulls[repo] || []).filter((p) => !base || p.baseRefName === base))));
  process.exit(0);
}
if (args[0] === "search" && args[1] === "prs") {
  if (flag("--state") !== "open" || flag("--match") !== "body" || !flag("--owner")) process.exit(2);
  const query = args[args.length - 1];
  fail("search " + query);
  console.log(JSON.stringify(pick((state.search || {})[query] || [])));
  process.exit(0);
}
if (args[0] !== "api") process.exit(2);
const method = args[1] === "-X" ? args[2] : "GET";
const path = method === "GET" ? args[1] : args[3];
fail(path);
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
function exec({ pulls = [], get = {}, search = {}, fail = [] } = {}, { event = "workflow_run", args = [] } = {}) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const writes = join(dir, "writes");
  writeFileSync(writes, "");
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ pulls: { [REPO]: pulls }, get, search, fail }));
  const r = spawnSync(process.execPath, [SCRIPT, "--repo", REPO, "--event", event, ...args], {
    encoding: "utf-8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, GH_TOKEN: "tok", STUB_STATE: state, STUB_WRITES: writes },
  });
  const lines = readFileSync(writes, "utf-8").trim().split("\n").filter(Boolean);
  return { status: r.status, out: r.stdout, err: r.stderr, writes: lines.map((l) => JSON.parse(l)) };
}

// The pull requests updated with their base, in order, each with expected_head_sha its listed head.
function expectUpdated(label, got, numbers, said = []) {
  assert.equal(got.status, 0, `${label}: exit ${got.status}\n${got.err}`);
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

  // On push: the open pull requests of the owner that name the pull request
  // merged as the pushed commit get their status; search hits that do not
  // name it are dropped. A pull request whose merge commit is another one is
  // not looked up. Another repository waits for app-tests when its
  // checks.yml at the head declares apps; one without checks.yml (404) does
  // not; this repository follows --apps.
  const MERGE = "c".repeat(40);
  const OPS_HEAD = "d".repeat(40);
  const DEMO_HEAD = "e".repeat(40);
  const TPL_HEAD = "f".repeat(40);
  const WEB_HEAD = "b".repeat(40);
  const line = `Depends-on: ${REPO}#5`;
  const checksYml = (repo, sha, text) => ({
    [`repos/${repo}/contents/.github/checks.yml?ref=${sha}`]: { ...CONTENTS, content: Buffer.from(text).toString("base64") },
  });
  const fanOut = {
    get: {
      [`repos/${REPO}/commits/${MERGE}/pulls`]: [
        { ...MERGED_PULL, number: 5, merge_commit_sha: MERGE },
        { ...MERGED_PULL, number: 6 },
      ],
      ...pull(REPO, 5, MERGED),
      ...pull("catenahq/ops", 7, { body: line, head: { sha: OPS_HEAD } }),
      ...pull("catenahq/docs", 3, { body: `${line}0` }),
      ...pull(REPO, 9, { body: `${line}\nDepends-on: catenahq/ops#12`, head: { sha: DEMO_HEAD } }),
      ...pull("catenahq/ops", 12),
      [`repos/${REPO}/commits/${DEMO_HEAD}/status?per_page=100`]: { statuses: [] },
      [`repos/catenahq/ops/contents/.github/checks.yml?ref=${OPS_HEAD}`]: CONTENTS,
      ...pull("catenahq/catena-templates", 4, { body: line, head: { sha: TPL_HEAD } }),
      ...checksYml("catenahq/catena-templates", TPL_HEAD, ["apps:", "  inputs: [blueprints]", "gates: {}", ""].join("\n")),
      [`repos/catenahq/catena-templates/commits/${TPL_HEAD}/status?per_page=100`]: { statuses: [] },
      ...pull("catenahq/website", 2, { body: line, head: { sha: WEB_HEAD } }),
    },
    search: {
      [line]: [
        { ...HIT, number: 7, repository: { name: "ops", nameWithOwner: "catenahq/ops" } },
        { ...HIT, number: 3, repository: { name: "docs", nameWithOwner: "catenahq/docs" } },
        { ...HIT, number: 9, repository: { name: "demo", nameWithOwner: REPO } },
        { ...HIT, number: 4, repository: { name: "catena-templates", nameWithOwner: "catenahq/catena-templates" } },
        { ...HIT, number: 2, repository: { name: "website", nameWithOwner: "catenahq/website" } },
      ],
    },
  };
  const pushed = exec(fanOut, { event: "push", args: ["--sha", MERGE, "--apps"] });
  assert.equal(pushed.status, 0, pushed.err);
  assert.deepEqual(
    pushed.writes.map((w) => [w.method, w.path, w.context, w.state, w.description]),
    [
      ["POST", `repos/catenahq/ops/statuses/${OPS_HEAD}`, "ci / gate", "success", "no open dependency"],
      ["POST", `repos/${REPO}/statuses/${DEMO_HEAD}`, "ci / gate", "pending", "waiting for catenahq/ops#12"],
      ["POST", `repos/catenahq/catena-templates/statuses/${TPL_HEAD}`, "ci / gate", "pending", "waiting for app-tests"],
      ["POST", `repos/catenahq/website/statuses/${WEB_HEAD}`, "ci / gate", "success", "no open dependency"],
    ],
    pushed.out,
  );
  // Without --apps, only another repository's checks.yml asks for app-tests.
  const noApps = exec(fanOut, { event: "push", args: ["--sha", MERGE] });
  assert.equal(noApps.status, 0, noApps.err);
  assert.deepEqual(
    noApps.writes.map((w) => [w.path, w.state, w.description]),
    [
      [`repos/catenahq/ops/statuses/${OPS_HEAD}`, "success", "no open dependency"],
      [`repos/${REPO}/statuses/${DEMO_HEAD}`, "pending", "waiting for catenahq/ops#12"],
      [`repos/catenahq/catena-templates/statuses/${TPL_HEAD}`, "pending", "waiting for app-tests"],
      [`repos/catenahq/website/statuses/${WEB_HEAD}`, "success", "no open dependency"],
    ],
  );
  assert.ok(pushed.out.includes("catenahq/ops#7: ci / gate success"), pushed.out);
  // Another event does not look the merged pull request up.
  assert.equal(exec(fanOut).writes.length, 0);

  // On schedule: every open pull request of the repository with a Depends-on line.
  const scheduled = exec(
    {
      pulls: [pr(1, { state: "BLOCKED", ...dep }), pr(2, { state: "BLOCKED", auto: false })],
      get: { ...gate(1), ...pull(REPO, 1, dep), ...pull("catenahq/ops", 12, MERGED) },
    },
    { event: "schedule" },
  );
  assert.equal(scheduled.status, 0, scheduled.err);
  assert.deepEqual(
    scheduled.writes.map((w) => [w.path, w.state]),
    [[`repos/${REPO}/statuses/${head(1)}`, "success"]],
  );

  // A GitHub API error exits 1 and updates nothing: a failed query is never "no candidate".
  const ready = { pulls: [pr(1)], get: gate(1) };
  const push = { event: "push", args: ["--sha", MERGE] };
  for (const [label, state, opts] of [
    ["check runs", { ...ready, fail: ["check-runs"] }],
    ["pr list", { ...ready, fail: [`pr list ${REPO}`] }],
    ["update-branch", { ...ready, fail: ["update-branch"] }],
    ["app-tests status", ready, { args: ["--apps"] }],
    ["Depends-on pull request", { pulls: [pr(1, dep)], get: gate(1) }],
    ["commit pulls", { ...fanOut, fail: [`commits/${MERGE}/pulls`] }, push],
    ["search", { ...fanOut, fail: [`search ${line}`] }, push],
    ["checks.yml", { ...fanOut, fail: ["catena-templates/contents/"] }, push],
  ]) {
    const got = exec(state, opts);
    assert.equal(got.status, 1, `${label}: exit ${got.status}\n${got.err}`);
    assert.ok(got.err.includes("::error::update: gh "), `${label}\n${got.err}`);
    assert.equal(got.writes.filter((w) => w.method === "PUT").length, 0, label);
  }

  // Bad arguments exit 2 and call nothing.
  for (const args of [["--repo", "x"], ["--event", "pull_request"], ["--event", "push"], ["--event", "push", "--sha", "abc"], ["--bogus"]]) {
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
