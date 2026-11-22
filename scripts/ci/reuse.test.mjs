// reuse.mjs over scratch repositories with stubs on PATH: gh answers `gh api
// <path>` from a JSON state file of API payloads; git answers ls-remote from
// the same file and runs the real git for everything else, so trees, merge
// commits and fetches by sha are git's own. Run with
// `node scripts/ci/reuse.test.mjs` after `npm ci --prefix scripts/ci`.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMatrix } from "./checks-matrix.mjs";
import { keyText, recordName, sortKeys, specOf } from "./reuse.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "reuse.mjs");
const REAL_GIT = process.env.PATH.split(":").map((d) => join(d, "git")).find(existsSync);
assert.ok(REAL_GIT, "git on PATH");

const work = mkdtempSync(join(tmpdir(), "catena-reuse-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

// gh api <path>: state.get[path]; an artifact list the state lacks is empty.
// state.fail lists path fragments that answer an error. Each call is logged.
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const [cmd, path] = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, "gh " + path + " [token " + (process.env.GH_TOKEN || "none") + "]\\n");
if (cmd !== "api") process.exit(2);
if ((state.fail || []).some((f) => path.includes(f))) { console.error("gh: HTTP 500"); process.exit(1); }
if (path in state.get) { console.log(JSON.stringify(state.get[path])); process.exit(0); }
if (/\\/actions\\/artifacts\\?/.test(path)) { console.log(JSON.stringify({ total_count: 0, artifacts: [] })); process.exit(0); }
console.error("gh: Not Found (HTTP 404)");
process.exit(1);
`,
);
// git ls-remote --heads <url> refs/heads/<b>: state.branches["<repo>/<b>"],
// logged with the token of its authorization header; any other git command
// runs the real git.
writeFileSync(
  join(bin, "git"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] !== "ls-remote") process.exit(spawnSync(process.env.REAL_GIT, args, { stdio: "inherit" }).status ?? 1);
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const header = process.env.GIT_CONFIG_VALUE_0 || "";
const auth = header ? Buffer.from(header.replace(/^AUTHORIZATION: basic /, ""), "base64").toString().replace(/^x-access-token:/, "") : "none";
fs.appendFileSync(process.env.STUB_LOG, "git " + args.join(" ") + " [auth " + auth + "]\\n");
const repo = args[2].replace(/^https:\\/\\/github.com\\//, "").replace(/\\.git$/, "");
const sha = (state.branches || {})[repo + "/" + args[3].replace(/^refs\\/heads\\//, "")];
if (sha) console.log(sha + "\\t" + args[3]);
`,
);
for (const f of ["gh", "git"]) chmodSync(join(bin, f), 0o755);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};
const git = (dir, ...args) => execFileSync(REAL_GIT, ["-C", dir, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
const write = (dir, files) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
};
const commit = (dir, files, message) => {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
};
const repo = (dir, files) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  return commit(dir, files, "init");
};

// Siblings, checked out beside the caller as check does.
const ws = join(work, "ws");
const CONTRACTS = repo(join(ws, "contracts"), { "a.txt": "contracts\n" });
const ADMIN = repo(join(ws, "catena-admin"), { "a.txt": "admin\n" });
const LOCK = `catenahq/contracts ${CONTRACTS} # main\ncatenahq/catena-admin ${ADMIN} # main\n`;
const CHECKS = `checks:
  python:
    siblings: {contracts: {}}
    inputs: [src/]
  docs:
    inputs: [docs/]
  ee:
    siblings: {catena-admin: {token: CATENA_EE_READ_TOKEN}}
    inputs: ['*.py', 'src/']
scan: {}
`;
const PLAN = buildMatrix({ checks: CHECKS, lock: LOCK, secrets: ["CATENA_EE_READ_TOKEN"], runner: "catena-ci", repo: "demo" });
const [PYTHON, DOCS, EE] = PLAN.include;

// The caller's origin: main A; the pull request head H changes src/ on A; B
// moves main on docs/ only; ALT is another commit with H's src/ and docs/.
const origin = join(work, "origin");
const A = repo(origin, {
  "src/app.py": "v1\n", "docs/guide.md": "g1\n", "ci/run": "echo run\n",
  ".github/catenahq.lock": LOCK, ".github/checks.yml": CHECKS, "README.md": "r1\n",
});
git(origin, "checkout", "-q", "-b", "feature");
const H = commit(origin, { "src/app.py": "v2\n" }, "head");
git(origin, "checkout", "-q", "-b", "alt", A);
const ALT = commit(origin, { "src/app.py": "v2\n", "README.md": "r2\n" }, "alt");
git(origin, "checkout", "-q", "main");
const B = commit(origin, { "docs/guide.md": "g3\n" }, "base moves");
// The merge commits a pull_request run checks out: M1 with the head up to date
// with main at A, M2 after main moved to B.
const merge = (base, ref) => {
  git(origin, "checkout", "-q", "--detach", base);
  git(origin, "merge", "-q", "--no-ff", "-m", "merge", H);
  const sha = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", ref, sha);
  return sha;
};
const M1 = merge(A, "refs/pull/1/merge-a");
const M2 = merge(B, "refs/pull/1/merge-b");
git(origin, "checkout", "-q", "main");

// ws/demo at a merge commit, two deep, as pr.yml's checkouts.
const caller = join(ws, "demo");
function checkout(sha) {
  rmSync(caller, { recursive: true, force: true });
  mkdirSync(caller);
  git(caller, "init", "-q");
  git(caller, "remote", "add", "origin", `file://${origin}`);
  git(caller, "fetch", "-q", "--depth=2", "origin", sha);
  git(caller, "checkout", "-q", "--detach", sha);
}

const W = "c".repeat(40);
const RUN_URL = "https://github.com/catenahq/demo/actions/runs/";

let n = 0;
function exec(args, { get = {}, fail = [], branches = {}, env = {} } = {}) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const files = {
    STUB_STATE: join(dir, "state.json"), STUB_LOG: join(dir, "calls.log"),
    GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary"),
  };
  writeFileSync(files.STUB_STATE, JSON.stringify({ get, fail, branches }));
  for (const f of ["STUB_LOG", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]) writeFileSync(files[f], "");
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: caller,
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, REAL_GIT, ...files,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      RUNNER_TEMP: dir, GITHUB_REPOSITORY_ID: "100", GITHUB_RUN_ID: "200", GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "feature", GITHUB_BASE_REF: "main", GITHUB_REF_NAME: "1/merge", GITHUB_REF_TYPE: "branch",
      DEFAULT_BRANCH: "main", WORKFLOW_REPOSITORY: "catenahq/contracts", WORKFLOW_SHA: W,
      GH_TOKEN: "tok", SIBLING_TOKEN: "sib",
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(files.GITHUB_OUTPUT, "utf-8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return {
    status: r.status, out: r.stdout, err: r.stderr, outputs,
    summary: readFileSync(files.GITHUB_STEP_SUMMARY, "utf-8"), log: readFileSync(files.STUB_LOG, "utf-8"),
  };
}
const ok = (r, label) => {
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.out}\n${r.err}`);
  return r;
};
const recordOf = (entry, env) => ok(exec(["record", "--entry", JSON.stringify(entry)], { env }), "record").outputs;
const planOf = (state = {}) => exec(["plan", "--matrix", JSON.stringify(PLAN), "--repo", "catenahq/demo"], state);
const left = (r) => JSON.parse(r.outputs.matrix).include.map((e) => e.name);

// The API payloads of a source run: its artifact of the record name, the run,
// and its jobs, trimmed to the fields the script reads.
function source(name, { id = 100, repoId = 100, headRepo = repoId, expired = false, path = ".github/workflows/ci.yml", event = "pull_request",
  head = H, prYml = `catenahq/contracts/.github/workflows/pr.yml@${W}`, prSha = W, jobs = [["ci / check (python)", "success"]] } = {}) {
  return {
    [`repos/catenahq/demo/actions/artifacts?name=${name}&per_page=100`]: {
      total_count: 1,
      artifacts: [{ id: 9000 + id, name, expired, created_at: "2026-11-20T00:00:00Z", workflow_run: { id, repository_id: repoId, head_repository_id: headRepo, head_sha: head } }],
    },
    [`repos/catenahq/demo/actions/runs/${id}`]: {
      id, path, event, status: "completed", conclusion: "success", head_sha: head, html_url: `${RUN_URL}${id}`,
      referenced_workflows: [{ path: prYml, sha: prSha, ref: "refs/heads/main" }],
    },
    [`repos/catenahq/demo/actions/runs/${id}/jobs?per_page=100`]: {
      total_count: jobs.length,
      jobs: jobs.map(([jobName, conclusion]) => ({ name: jobName, status: "completed", conclusion })),
    },
  };
}

try {
  // record: the key of an entry at the merge commit, its siblings at their
  // checkouts, and pr.yml's commit; an up-to-date pull request records.
  checkout(M1);
  const py1 = recordOf(PYTHON);
  assert.match(py1.name, /^ci-check\.python\.[0-9a-f]{40}$/);
  assert.equal(py1.record, "true");
  const key = readFileSync(py1.path, "utf-8");
  assert.equal(recordName("python", key), py1.name, "the name is the key's sha256");
  const entryLine = key.split("\n")[0];
  assert.equal(entryLine, `entry=${JSON.stringify(sortKeys(PYTHON))}`);
  assert.ok(entryLine.startsWith('entry={"gates":') && entryLine.includes('"inputs":["src/"]'), entryLine);
  assert.ok(key.includes("\tsrc/app.py\n") && key.includes("\tci/run\n") && key.includes("\t.github/catenahq.lock\n"), key);
  assert.ok(!key.includes("docs/guide.md") && !key.includes("README.md"), "only the entry's inputs and the files every check reads");
  assert.ok(key.includes(`sib:contracts=${CONTRACTS}\n`) && key.includes(`workflow=${W}\n`) && !key.includes("date="), key);

  // Key stability: the entry's key order, and files outside the inputs, change nothing.
  const shuffled = Object.fromEntries(Object.entries(PYTHON).reverse());
  assert.equal(recordOf(shuffled).name, py1.name, "an entry's key order");
  const ee1 = recordOf(EE);
  assert.ok(readFileSync(ee1.path, "utf-8").includes(`sib:catena-admin=${ADMIN}\n`), "a bundle sibling at its clone");
  assert.ok(readFileSync(ee1.path, "utf-8").includes("\tsrc/app.py\n"), "a glob input");
  const docs1 = recordOf(DOCS);
  const scan1 = ok(exec(["record", "--scan", JSON.stringify(PLAN.scan)]), "scan").outputs;
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(readFileSync(scan1.path, "utf-8").endsWith(`date=${today}\n`), "the scan's key holds the UTC date");
  assert.ok(readFileSync(scan1.path, "utf-8").includes("\tREADME.md\n"), "the scan reads the whole tree");

  // scan's date: another day is another key; a check's key has no date.
  const scanSpec = specOf({ scan: PLAN.scan });
  const at = (spec, date) => recordName(spec.name, keyText({ spec, tree: "t", sibs: [], workflowSha: W, date }));
  assert.notEqual(at(scanSpec, "2026-11-21"), at(scanSpec, "2026-11-22"));
  assert.equal(at(specOf({ entry: PYTHON }), "2026-11-21"), at(specOf({ entry: PYTHON }), "2026-11-22"));

  // The base moved on docs/ only: python keeps its key and records; docs
  // differs from the pull request head and records nothing, except on a
  // scheduled run, which has no pull request head.
  checkout(M2);
  const py2 = recordOf(PYTHON);
  assert.deepEqual([py2.name, py2.record], [py1.name, "true"]);
  const docs2 = recordOf(DOCS);
  assert.notEqual(docs2.name, docs1.name);
  assert.equal(docs2.record, "false");
  assert.equal(recordOf(DOCS, { GITHUB_EVENT_NAME: "schedule" }).record, "true");

  // plan with no record: every entry runs, and plan names the record it
  // looked for, the one record computes.
  let r = ok(planOf(), "no record");
  assert.deepEqual(left(r), ["python", "docs", "ee"]);
  assert.deepEqual([r.outputs.run, r.outputs.bundles, r.outputs["scan-reused"]], ["true", '["catena-admin"]', "false"]);
  assert.ok(r.out.includes(`python: no record (${py1.name})`), r.out);
  assert.ok(r.log.includes("[auth sib]"), "siblings are read with SIBLING_TOKEN");

  // The known positive case: a pull request run whose head is H passed python.
  r = ok(planOf({ get: source(py1.name) }), "positive");
  assert.deepEqual(left(r), ["docs", "ee"], r.out);
  assert.equal(r.outputs.run, "true");
  assert.equal(r.summary, `reused python from ${RUN_URL}100\n`);
  assert.ok(r.out.includes(`::notice::reused python from ${RUN_URL}100`), r.out);
  assert.ok(r.log.includes(`gh repos/catenahq/demo/actions/artifacts?name=${py1.name}&per_page=100 [token tok]`), r.log);

  // A source head the checkout lacks is fetched by sha; a schedule run is a source.
  assert.notEqual(spawnSync(REAL_GIT, ["-C", caller, "cat-file", "-e", `${ALT}^{commit}`]).status, 0, "ALT is not in the checkout");
  r = ok(planOf({ get: source(py1.name, { head: ALT, event: "schedule" }) }), "fetched head");
  assert.deepEqual(left(r), ["docs", "ee"], r.out);

  // A push to the default branch keys its siblings at the lock, as the pull
  // request did: it reuses the pull request's record of the same inputs, and
  // its own record, of the same name, counts for a later pull request.
  const PUSH = { GITHUB_EVENT_NAME: "push", GITHUB_HEAD_REF: "", GITHUB_BASE_REF: "", GITHUB_REF_NAME: "main" };
  r = ok(planOf({ get: source(py1.name), env: PUSH }), "push reuses");
  assert.deepEqual(left(r), ["docs", "ee"], r.out);
  const pushed = recordOf(PYTHON, PUSH);
  assert.deepEqual([pushed.name, pushed.record], [py1.name, "true"]);
  r = ok(planOf({ get: source(py1.name, { event: "push", head: M1 }) }), "a push record");
  assert.deepEqual(left(r), ["docs", "ee"], r.out);

  // Each refusal leaves python to run.
  const refusals = {
    expired: { expired: true },
    "a fork's run": { headRepo: 999 },
    "another repository's run": { repoId: 999 },
    "this run": { id: 200 },
    "another workflow file": { path: ".github/workflows/other.yml" },
    "a workflow_dispatch run": { event: "workflow_dispatch" },
    "pr.yml at another commit": { prSha: "d".repeat(40) },
    "another reusable workflow": { prYml: `catenahq/contracts/.github/workflows/other.yml@${W}` },
    "a failed job": { jobs: [["ci / check (python)", "failure"]] },
    "a job still going": { jobs: [["ci / check (python)", null]] },
    "another job's success": { jobs: [["ci / check (docs)", "success"]] },
    "a head with other inputs": { head: A },
  };
  for (const [label, opts] of Object.entries(refusals)) {
    r = ok(planOf({ get: source(py1.name, opts) }), label);
    assert.deepEqual(left(r), ["python", "docs", "ee"], label);
    assert.equal(r.summary, "", label);
  }

  // A sibling on the pull request's branch name keys on that branch's tip:
  // the record of the locked commit does not count.
  r = ok(planOf({ get: source(py1.name), branches: { "catenahq/contracts/feature": "e".repeat(40) } }), "sibling branch");
  assert.deepEqual(left(r), ["python", "docs", "ee"]);

  // An API or git error fails the step: it is never "no record".
  for (const [label, state] of [
    ["artifact list", { get: source(py1.name), fail: ["actions/artifacts"] }],
    ["run", { get: source(py1.name), fail: ["actions/runs/100"] }],
    ["jobs", { get: source(py1.name), fail: ["/jobs"] }],
    ["fetch of a missing head", { get: source(py1.name, { head: "f".repeat(40) }) }],
  ]) {
    r = planOf(state);
    assert.equal(r.status, 1, `${label}: ${r.out}\n${r.err}`);
    assert.ok(r.err.includes("::error::reuse: "), r.err);
    assert.deepEqual(r.outputs, {}, label);
  }

  // A scheduled run looks nothing up and runs every entry.
  r = ok(planOf({ get: source(py1.name), env: { GITHUB_EVENT_NAME: "schedule" } }), "schedule");
  assert.deepEqual(left(r), ["python", "docs", "ee"]);
  assert.equal(r.log, "", "no API call on a schedule");

  // Every entry and the scan reused: nothing runs and nothing is bundled.
  checkout(M1);
  const all = {
    ...source(py1.name, { id: 101 }),
    ...source(docs1.name, { id: 102, jobs: [["ci / check (docs)", "success"]] }),
    ...source(ee1.name, { id: 103, jobs: [["ci / check (ee)", "success"]] }),
    ...source(scan1.name, { id: 104, jobs: [["ci / scan", "success"]] }),
  };
  r = ok(planOf({ get: all }), "all reused");
  assert.deepEqual(JSON.parse(r.outputs.matrix), { include: [] });
  assert.deepEqual([r.outputs.run, r.outputs.bundles, r.outputs["scan-reused"]], ["false", "[]", "true"]);
  assert.equal(r.summary.trim().split("\n").length, 4, r.summary);

  // Bad arguments exit 2.
  for (const args of [[], ["plan", "--matrix", "{}", "--repo", "catenahq/demo"], ["plan", "--matrix", "x", "--repo", "catenahq/demo"],
    ["plan", "--matrix", JSON.stringify(PLAN), "--repo", "demo"], ["record"], ["record", "--entry", "{}", "--scan", "{}"],
    ["record", "--entry", "x"], ["record", "--entry", JSON.stringify(PYTHON), "--bogus", "1"]]) {
    r = exec(args);
    assert.equal(r.status, 2, `${args}\n${r.err}`);
  }
  assert.equal(exec(["record", "--entry", JSON.stringify(PYTHON)], { env: { WORKFLOW_SHA: "" } }).status, 2, "no WORKFLOW_SHA");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("reuse: ok");
