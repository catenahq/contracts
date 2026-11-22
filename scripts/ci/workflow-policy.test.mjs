// workflow-policy.mjs with a gh stub on PATH: gh answers `gh api <path>` from a
// JSON state file (state.raw for a path asked with the raw media type) and
// logs each POST to a file; a read under a prefix of state.tokens answers
// only that token, anything else only "tok". The tree under fixtures/workflow-policy/ passes
// every rule; each case edits a copy of it so that one rule fails, or so that
// an edit the rule allows still passes. Run with
// `node scripts/ci/workflow-policy.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_FILE, REPOS, localWorkflows, policyOf } from "./workflow-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "workflow-policy.mjs");
const FIXTURE = join(HERE, "fixtures", "workflow-policy");
const CALLER = readFileSync(join(FIXTURE, ".github", "workflows", "ci-control.yml"), "utf-8");
const REPO = "catenahq/contracts";
const HEAD = "c".repeat(40);
const BASE = "e".repeat(40);
// The fixture pins pr.yml and control.yml at ON_MAIN, and locks scanctl at LOCKED.
const ON_MAIN = "a".repeat(40);
const LOCKED = "b".repeat(40);
const OFF_MAIN = "d".repeat(40);
// Merged commits of contracts before and after ON_MAIN.
const OLDER = "1".repeat(40);
const NEWER = "2".repeat(40);
const CHECKOUT = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7";
const compare = (repo, sha, to = "main") => `repos/${repo}/compare/${sha}...${to}`;
const COMPARE = {
  [compare(REPO, ON_MAIN)]: { status: "ahead" },
  [compare(REPO, OLDER)]: { status: "ahead" },
  [compare(REPO, NEWER)]: { status: "identical" },
  [compare("catenahq/scanctl", LOCKED)]: { status: "identical" },
  [compare(REPO, OFF_MAIN)]: { status: "diverged" },
  [compare("catenahq/scanctl", OFF_MAIN)]: { status: "behind" },
  [compare(REPO, ON_MAIN, OLDER)]: { status: "behind" },
  [compare(REPO, ON_MAIN, NEWER)]: { status: "ahead" },
};
const CHANGED = [
  { path: "scripts/ci/x.mjs", status: "modified" },
  { path: "README.md", status: "modified" },
  { path: "uv.lock", status: "added" },
  { path: ".github/workflows/ci.yml", status: "modified" },
  { path: ".github/checks.yml", status: "modified" },
  { path: "scanctl.yml", status: "modified" },
  { path: ".scanctl/baseline.sarif", status: "added" },
  { path: "docs/scanctl.yml", status: "added" },
];

const work = mkdtempSync(join(tmpdir(), "catena-workflow-policy-test-"));
const bin = join(work, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(2);
const owner = Object.entries(state.tokens || {}).find(([prefix]) => args[1].startsWith(prefix));
if (process.env.GH_TOKEN !== (owner ? owner[1] : "tok")) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
if (args[1] === "-X") {
  const fields = { method: args[2], path: args[3] };
  for (let i = 4; i < args.length; i += 2) {
    const [k, ...v] = args[i + 1].split("=");
    fields[k] = v.join("=");
  }
  fs.appendFileSync(process.env.STUB_WRITES, JSON.stringify(fields) + "\\n");
  process.exit(0);
}
const path = args[1];
if ((state.fail || []).some((f) => path.includes(f))) { console.error("gh: HTTP 500"); process.exit(1); }
const raw = args[2] === "-H" && args[3] === "Accept: application/vnd.github.raw+json";
const answer = raw ? (state.raw || {})[path] : (state.get || {})[path];
if (answer === undefined) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
process.stdout.write(raw ? answer : JSON.stringify(answer));
`,
);
chmodSync(join(bin, "gh"), 0o755);

let n = 0;
function run(args, state = {}, env = {}) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const at = (name) => join(dir, name);
  for (const name of ["writes", "output", "summary"]) writeFileSync(at(name), "");
  writeFileSync(at("state.json"), JSON.stringify(state));
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      GH_TOKEN: "tok",
      STUB_STATE: at("state.json"),
      STUB_WRITES: at("writes"),
      GITHUB_OUTPUT: at("output"),
      GITHUB_STEP_SUMMARY: at("summary"),
      ...env,
    },
  });
  const writes = readFileSync(at("writes"), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, out: r.stdout, err: r.stderr, writes, output: readFileSync(at("output"), "utf-8"), summary: readFileSync(at("summary"), "utf-8") };
}

// A copy of the fixture as fetch writes it: the head under pr/, its workflows
// as the base, and CHANGED. edits maps a head path to a function of its text.
let t = 0;
function tree(edits = {}) {
  const dir = join(work, `tree${t++}`);
  mkdirSync(join(dir, "base", ".github"), { recursive: true });
  cpSync(FIXTURE, join(dir, "pr"), { recursive: true });
  cpSync(join(FIXTURE, ".github", "workflows"), join(dir, "base", ".github", "workflows"), { recursive: true });
  for (const [path, edit] of Object.entries(edits)) {
    const file = join(dir, "pr", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, edit(existsSync(file) ? readFileSync(file, "utf-8") : ""));
  }
  writeFileSync(join(dir, "changed.json"), JSON.stringify(CHANGED));
  return dir;
}
const sub = (from, to) => (text) => {
  assert.ok(text.includes(from), `'${from}' not in\n${text}`);
  return text.replace(from, to);
};
const add = (text) => (before) => before + text;
const check = (dir, { zizmor = "0", fail = [], tokens = {}, env = {} } = {}) =>
  run(["check", "--repo", REPO, "--sha", HEAD, "--dir", dir, "--zizmor", zizmor], { get: COMPARE, fail, tokens }, env);

function expectStatus(label, got, state, description) {
  assert.deepEqual(
    got.writes.map((w) => [w.method, w.path, w.context, w.state, w.description]),
    [["POST", `repos/${REPO}/statuses/${HEAD}`, "workflow policy", state, description]],
    `${label}\n${got.out}\n${got.err}`,
  );
  assert.equal(got.output, "posted=true\n", label);
}
const passes = (label, edits) => {
  const got = check(tree(edits));
  assert.equal(got.status, 0, `${label}: exit ${got.status}\n${got.out}\n${got.err}`);
  expectStatus(label, got, "success", "every rule passed");
};
// Exactly the rule fails, with a finding that says the text.
const fails = (label, rule, said, edits, opts) => {
  const got = check(tree(edits), opts);
  assert.equal(got.status, 1, `${label}: exit ${got.status}\n${got.out}\n${got.err}`);
  expectStatus(label, got, "failure", `failed: ${rule}`);
  assert.ok(got.out.includes(said), `${label}: '${said}' not in\n${got.out}`);
};

const W = ".github/workflows/";
const JOB = (name, body) => `  ${name}:\n    runs-on: catena-ci\n${body}`;
const WORKFLOW = (on) => (jobs) => () => `name: ${on}\non:\n  ${on}:\npermissions: {}\njobs:\n${jobs}`;
const PUBLISH = WORKFLOW("push");
const REVIEW = WORKFLOW("pull_request_target");

try {
  // The fixture passes every rule, and the summary lists the executed paths it changes.
  const clean = check(tree());
  assert.equal(clean.status, 0, `${clean.out}\n${clean.err}`);
  expectStatus("fixture", clean, "success", "every rule passed");
  for (const line of [
    "| zizmor | passed |", "- `scripts/ci/x.mjs` (modified)", "- `uv.lock` (added)", "- `.github/checks.yml` (modified)",
    "- `scanctl.yml` (modified)", "- `.scanctl/baseline.sarif` (added)",
  ]) {
    assert.ok(clean.summary.includes(line), `'${line}' not in\n${clean.summary}`);
  }
  for (const path of ["README.md", "`.github/workflows/ci.yml`", "docs/scanctl.yml"]) assert.ok(!clean.summary.includes(path), `${path}\n${clean.summary}`);

  fails("unparsable action", "yaml", ".github/actions/demo/action.yml", { ".github/actions/demo/action.yml": add("bad: [\n") });

  fails("tag pin", "pinned", "uses: actions/checkout@v7 is not pinned by a 40-hex commit", {
    [`${W}pr.yml`]: sub(CHECKOUT, "actions/checkout@v7"),
  });
  fails("no version comment", "pinned", "has no version comment", {
    ".github/actions/demo/action.yml": sub("47a31fe5020 # v7", "47a31fe5020"),
  });

  fails("first-party commit off main", "merged", `${REPO}@${OFF_MAIN} is not on main (diverged)`, {
    [`${W}ci.yml`]: sub(`pr.yml@${ON_MAIN}`, `pr.yml@${OFF_MAIN}`),
  });
  fails("lock line off main", "merged", `catenahq/scanctl@${OFF_MAIN} is not on main (behind)`, {
    ".github/catenahq.lock": sub(LOCKED, OFF_MAIN),
  });
  fails("malformed lock line", "merged", "is not '<owner>/<repo> <40-hex sha> # <branch>'", {
    ".github/catenahq.lock": add("catenahq/ops 1234\n"),
  });
  // A failed comparison is unknown, never on main.
  fails("comparison failed", "merged", "could not be compared with main", {}, { fail: [`compare/${ON_MAIN}`] });
  // The comparisons, which can reach other repositories, use GH_READ_TOKEN.
  const privateLock = { tokens: { "repos/catenahq/scanctl/": "read", "repos/catenahq/contracts/compare/": "read" } };
  const readClean = check(tree(), { ...privateLock, env: { GH_READ_TOKEN: "read" } });
  assert.equal(readClean.status, 0, `${readClean.out}\n${readClean.err}`);
  expectStatus("read token", readClean, "success", "every rule passed");
  fails("no read token", "merged", `catenahq/scanctl@${LOCKED} could not be compared with main`, {}, privateLock);
  // GitHub resolves the owner without regard to case: the pin is still first-party.
  fails("owner in another case", "merged", `catenahq/contracts@${OFF_MAIN} is not on main (diverged)`, {
    [`${W}ci.yml`]: sub(`catenahq/contracts/.github/workflows/pr.yml@${ON_MAIN}`, `CatenaHQ/Contracts/.github/workflows/pr.yml@${OFF_MAIN}`),
  });
  // A pin of the same workflow file and path moves forward only: an older
  // merged commit than the base's fails, a newer one passes, and a failed
  // comparison is unknown.
  fails("pin moved back", "merged", `catenahq/contracts/.github/workflows/pr.yml@${OLDER} is not at or after the base's pin ${ON_MAIN} (behind)`, {
    [`${W}ci.yml`]: sub(`pr.yml@${ON_MAIN}`, `pr.yml@${OLDER}`),
  });
  fails("pin moved back, owner in another case", "merged", "is not at or after the base's pin", {
    [`${W}ci.yml`]: sub(`catenahq/contracts/.github/workflows/pr.yml@${ON_MAIN}`, `CatenaHQ/contracts/.github/workflows/pr.yml@${OLDER}`),
  });
  passes("pin moved forward", { [`${W}ci.yml`]: sub(`pr.yml@${ON_MAIN}`, `pr.yml@${NEWER}`) });
  fails("pin comparison failed", "merged", `could not be compared with the base's pin ${ON_MAIN}`, {
    [`${W}ci.yml`]: sub(`pr.yml@${ON_MAIN}`, `pr.yml@${NEWER}`),
  }, { fail: [`compare/${ON_MAIN}...${NEWER}`] });
  // A pin the base file does not have is new: only its ancestry of main counts.
  passes("new pin", {
    [`${W}publish.yml`]: PUBLISH(`  call:\n    uses: catenahq/contracts/.github/workflows/pr.yml@${OLDER} # main\n    permissions: {}\n`),
  });

  fails("secrets: inherit", "secrets-inherit", "job ci passes secrets: inherit", {
    [`${W}ci.yml`]: sub("    secrets:\n      CATENA_EE_READ_TOKEN: ${{ secrets.CATENA_EE_READ_TOKEN }}\n", "    secrets: inherit\n"),
  });

  fails("wider than the ceiling", "permissions", "job ci asks for packages: write, wider than none (contracts:ci.yml:ci)", {
    [`${W}ci.yml`]: sub("      statuses: write\n", "      statuses: write\n      packages: write\n"),
  });
  // A job with no permissions block gets the workflow's, judged against its ceiling.
  fails("no permissions block anywhere", "permissions", "job check has no permissions block and the workflow has none", {
    [`${W}pr.yml`]: (text) => sub("permissions: {}\njobs:", "jobs:")(sub("    permissions:\n      contents: read\n    strategy:", "    strategy:")(text)),
  });
  passes("the workflow's empty permissions", { [`${W}pr.yml`]: sub("    permissions:\n      contents: read\n    strategy:", "    strategy:") });
  passes("the workflow's permissions within the ceiling", {
    [`${W}pr.yml`]: (text) => sub("permissions: {}\njobs:", "permissions:\n  contents: read\njobs:")(sub("    permissions:\n      contents: read\n    strategy:", "    strategy:")(text)),
  });
  fails("the workflow's permissions wider than the ceiling", "permissions", "job check gets from the workflow contents: write, wider than read (contracts:pr.yml:check)", {
    [`${W}pr.yml`]: (text) => sub("permissions: {}\njobs:", "permissions:\n  contents: write\njobs:")(sub("    permissions:\n      contents: read\n    strategy:", "    strategy:")(text)),
  });
  fails("no ceiling", "permissions", 'add "contracts:publish.yml:publish" to scripts/ci/workflow-policy.json', {
    [`${W}publish.yml`]: PUBLISH(JOB("publish", "    permissions:\n      contents: read\n    steps:\n      - run: echo publish\n")),
  });
  fails("write-all", "permissions", "job control has permissions: write-all; name each scope", {
    [`${W}ci-control.yml`]: sub("    permissions:\n      contents: read\n      statuses: write\n", "    permissions: write-all\n"),
  });
  // A job that asks for nothing needs no ceiling.
  passes("empty permissions", { [`${W}publish.yml`]: PUBLISH(JOB("publish", "    permissions: {}\n    steps:\n      - run: echo publish\n")) });

  const headCheckout = JOB("head", `    permissions: {}\n    steps:\n      - uses: ${CHECKOUT}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`);
  fails("pull_request_target checkout", "pull-request-target", "job head checks out the pull request's code on pull_request_target", {
    [`${W}review.yml`]: REVIEW(headCheckout),
  });
  fails("pull_request_target fetch", "pull-request-target", "job head fetches the pull request's code on pull_request_target", {
    [`${W}review.yml`]: REVIEW(JOB("head", '    permissions: {}\n    steps:\n      - env:\n          REF: ${{ github.head_ref }}\n        run: git fetch origin "$REF"\n')),
  });
  // The same checkout on pull_request runs in the pull request's own context.
  passes("pull_request checkout", { [`${W}ci.yml`]: add(headCheckout) });

  fails("secret not in the allowlist", "secrets", "secret NOT_LISTED is not in the secrets", {
    [`${W}pr.yml`]: sub("        run: test", "          OTHER: ${{ secrets.NOT_LISTED }}\n        run: test"),
  });
  fails("secret by index", "secrets", "a secret is named by an index expression", {
    [`${W}pr.yml`]: sub("        run: test", "          OTHER: ${{ secrets[format('{0}', 'X')] }}\n        run: test"),
  });

  fails("left the needs of gate", "gate-needs", "job check left the needs of gate", { [`${W}pr.yml`]: sub("needs: [plan, check]", "needs: [plan]") });
  fails("continue-on-error", "gate-needs", "the required job check gets continue-on-error", {
    [`${W}pr.yml`]: sub("    if: needs.plan", "    continue-on-error: true\n    if: needs.plan"),
  });
  fails("skipped by if", "gate-needs", "the required job check has a changed if: false", {
    [`${W}pr.yml`]: sub("if: needs.plan.outputs.run == 'true'", "if: false"),
  });
  fails("gate gone", "gate-needs", "the required job gate is gone", { [`${W}pr.yml`]: (text) => text.slice(0, text.indexOf("  gate:\n")) });
  // A job gate needs in addition is allowed.
  passes("one more need", {
    [`${W}pr.yml`]: (text) => sub("needs: [plan, check]", "needs: [plan, check, extra]")(text) + JOB("extra", "    permissions: {}\n    steps:\n      - run: echo extra\n"),
  });

  fails("ci / gate outside ci.yml", "ci-gate", "job fake (name 'ci / gate') can yield the check name ci / gate", {
    [`${W}publish.yml`]: PUBLISH(JOB("fake", "    name: ci / gate\n    permissions: {}\n    steps:\n      - run: exit 0\n")),
  });
  fails("ci call outside ci.yml", "ci-gate", "job ci (name 'ci') can yield the check name ci / gate", {
    [`${W}publish.yml`]: PUBLISH("  ci:\n    uses: ./.github/workflows/pr.yml\n    permissions: {}\n"),
  });
  fails("name from an expression", "ci-gate", "job any (name '${{ inputs.name }}')", {
    [`${W}publish.yml`]: PUBLISH(JOB("any", "    name: ${{ inputs.name }}\n    permissions: {}\n    steps:\n      - run: exit 0\n")),
  });

  // The fixture's ci-control.yml has the caller shape (the clean run above).
  assert.ok(clean.summary.includes("| ci-control | passed |"), clean.summary);
  fails("ci-control with another job", "ci-control", "has 2 jobs; the caller has one", {
    [`${W}ci-control.yml`]: add(JOB("extra", "    permissions: {}\n    steps:\n      - run: echo extra\n")),
  });
  fails("ci-control calling another workflow", "ci-control", "job control does not call catenahq/contracts/.github/workflows/control.yml", {
    [`${W}ci-control.yml`]: sub("workflows/control.yml@", "workflows/pr.yml@"),
  });
  fails("ci-control job with more keys", "ci-control", "job control has runs-on, steps; the caller job has only uses, permissions, with", {
    [`${W}ci-control.yml`]: add("    runs-on: catena-ci\n    steps:\n      - run: echo control\n"),
  });

  fails("zizmor findings", "zizmor", "scanctl exited 1", {}, { zizmor: "1" });

  // fetch: every file under .github/ and every changed file that is not
  // removed at the head, the base's workflows, and the changed list; the
  // changed files are read page by page, and a symbolic link is left out.
  const R = `repos/${REPO}`;
  const raw = (sha, path) => `${R}/contents/${path}?ref=${sha}`;
  const removed = Array.from({ length: 100 }, (_, i) => ({ filename: `old/${i}.txt`, status: "removed" }));
  const trees = (sha, id, entries) => ({
    [`${R}/git/trees/${sha}`]: { truncated: false, tree: [{ path: ".github", type: "tree", sha: id }, { path: "README.md", type: "blob", mode: "100644" }] },
    [`${R}/git/trees/${id}?recursive=1`]: { truncated: false, tree: entries },
  });
  const fetchState = {
    get: {
      [`${R}/pulls/7/files?per_page=100&page=1`]: removed,
      [`${R}/pulls/7/files?per_page=100&page=2`]: [
        { filename: ".github/workflows/ci.yml", status: "modified" },
        { filename: "docs/a b.md", status: "added" },
      ],
      ...trees(HEAD, "t1", [
        { path: "workflows", type: "tree" },
        { path: "workflows/ci.yml", type: "blob", mode: "100644" },
        { path: "workflows/ci-control.yml", type: "blob", mode: "100644" },
        { path: "catenahq.lock", type: "blob", mode: "100644" },
        { path: "link", type: "blob", mode: "120000" },
      ]),
      ...trees(BASE, "t2", [
        { path: "workflows/ci.yml", type: "blob", mode: "100644" },
        { path: "actions/x/action.yml", type: "blob", mode: "100644" },
      ]),
    },
    raw: {
      [raw(HEAD, ".github/workflows/ci.yml")]: "head: ci # zizmor: ignore[unpinned-uses]\n",
      [raw(HEAD, ".github/workflows/ci-control.yml")]: CALLER,
      [raw(HEAD, ".github/catenahq.lock")]: "head lock\n",
      [raw(HEAD, "docs/a%20b.md")]: "doc\n",
      [raw(BASE, ".github/workflows/ci.yml")]: "base ci\n",
    },
  };
  const out = join(work, "fetched");
  const fetchArgs = ["fetch", "--repo", REPO, "--pr", "7", "--head", HEAD, "--base", BASE, "--dir", out];
  const fetched = run(fetchArgs, fetchState);
  assert.equal(fetched.status, 0, fetched.err);
  const read = (path) => readFileSync(join(out, path), "utf-8");
  // The pull request's own zizmor directive is dropped, and nothing is added:
  // scanctl's zizmor configuration ignores dangerous-triggers for ci-control.yml.
  assert.deepEqual(
    [
      read("pr/.github/workflows/ci.yml"), read("pr/.github/workflows/ci-control.yml"), read("pr/.github/catenahq.lock"), read("pr/docs/a b.md"),
      read("base/.github/workflows/ci.yml"),
    ],
    ["head: ci # dropped-zizmor-directive: ignore[unpinned-uses]\n", CALLER, "head lock\n", "doc\n", "base ci\n"],
  );
  for (const gone of ["pr/.github/link", "pr/old", "base/.github/actions"]) assert.ok(!existsSync(join(out, gone)), gone);
  assert.equal(JSON.parse(read("changed.json")).length, 102);

  // A failed read, a truncated tree or a path out of the tree fails fetch.
  const tampered = (entries) => ({ ...fetchState, get: { ...fetchState.get, ...trees(HEAD, "t1", entries) } });
  for (const [label, state] of [
    ["files", { ...fetchState, fail: ["pulls/7/files"] }],
    ["contents", { ...fetchState, fail: ["contents/docs"] }],
    ["truncated", { ...fetchState, get: { ...fetchState.get, [`${R}/git/trees/t1?recursive=1`]: { truncated: true, tree: [] } } }],
    ["path", tampered([{ path: "../escape", type: "blob", mode: "100644" }])],
  ]) {
    const got = run(fetchArgs, state);
    assert.equal(got.status, 1, `${label}: exit ${got.status}\n${got.err}`);
    assert.ok(got.err.includes("::error::workflow-policy: "), `${label}\n${got.err}`);
  }
  assert.ok(!existsSync(join(work, "escape")));

  // error posts the status as error.
  const errored = run(["error", "--repo", REPO, "--sha", HEAD]);
  assert.equal(errored.status, 0, errored.err);
  assert.deepEqual(errored.writes.map((w) => [w.context, w.state]), [["workflow policy", "error"]]);

  // The committed policy covers every ceiling and secret of this tree's
  // workflows and of the caller templates, each ceiling a known level.
  const policy = JSON.parse(readFileSync(POLICY_FILE, "utf-8"));
  const LEVEL = { none: 0, read: 1, write: 2 };
  const covers = (ceiling, asked) => Object.entries(asked).every(([scope, level]) => LEVEL[ceiling?.[scope] ?? "none"] >= LEVEL[level]);
  const own = policyOf([{ repo: "contracts", files: localWorkflows(join(HERE, "..", "..")) }]);
  for (const [key, asked] of Object.entries(own.permissions)) assert.ok(covers(policy.permissions[key], asked), key);
  for (const name of own.secrets) assert.ok(policy.secrets.includes(name), name);
  for (const [key, ceiling] of Object.entries(policy.permissions)) {
    assert.match(key, /^[\w.-]+:[\w.-]+\.ya?ml:[\w-]+$/);
    for (const level of Object.values(ceiling)) assert.ok(["read", "write"].includes(level), `${key}: ${level}`);
  }

  // --seed: every workflow of every repository of REPOS, contracts from this
  // tree, a --local checkout from its working tree, the others from their
  // default branch through the API; a job with no permissions block takes the
  // workflow's as its ceiling.
  const PUBLISH_IMAGE = [
    "name: publish", "on: {push: {tags: ['v*']}}", "permissions:", "  contents: read", "  packages: write", "jobs:",
    "  guard:", "    runs-on: ubuntu-26.04", "    steps: [{run: echo}]",
    "  publish:", "    needs: guard", "    runs-on: ubuntu-26.04", "    permissions: {contents: read, packages: write, id-token: write}",
    "    steps: [{env: {T: '${{ secrets.RENOVATE_APP_PRIVATE_KEY }}'}, run: echo}]",
    "  call:", "    uses: ./.github/workflows/x.yml", "    permissions: {}", "    secrets: {PASSED_ON: '${{ secrets.GITHUB_TOKEN }}'}", "",
  ].join("\n");
  const seedState = { get: {}, raw: {} };
  for (const name of REPOS.filter((r) => !["contracts", "ops"].includes(r))) {
    const dir = `repos/catenahq/${name}/contents/.github/workflows`;
    const files = name === "catena-admin" ? { "publish-image.yml": PUBLISH_IMAGE, "README.md": "not a workflow" } : { "ci.yml": "jobs:\n  x:\n    permissions: {}\n" };
    seedState.get[dir] = [...Object.keys(files).map((f) => ({ name: f, type: "file" })), { name: "sub", type: "dir" }];
    for (const [f, text] of Object.entries(files)) seedState.raw[`${dir}/${f}`] = text;
  }
  const opsTree = join(work, "ops");
  mkdirSync(join(opsTree, ".github", "workflows"), { recursive: true });
  writeFileSync(join(opsTree, ".github", "workflows", "app-tests.yml"), "permissions: {contents: read}\njobs:\n  lifecycle:\n    env: {K: '${{ secrets.APPCI_INCUS_KEY }}'}\n");
  const seedOut = join(work, "seeded.json");
  const seeded = run(["--seed", "--local", `ops=${opsTree}`, "--out", seedOut], seedState);
  assert.equal(seeded.status, 0, seeded.err);
  // One workflow of each API repository, ops' one and this tree's.
  const files = REPOS.length - 2 + 1 + Object.keys(localWorkflows(join(HERE, "..", ".."))).length;
  assert.ok(seeded.out.startsWith(`read ${REPOS.length} repositories and ${files} workflow files; wrote ${seedOut}`), seeded.out);
  const written = JSON.parse(readFileSync(seedOut, "utf-8"));
  assert.deepEqual(written.permissions["catena-admin:publish-image.yml:guard"], { contents: "read", packages: "write" });
  assert.deepEqual(written.permissions["catena-admin:publish-image.yml:publish"], { contents: "read", "id-token": "write", packages: "write" });
  assert.equal(written.permissions["catena-admin:publish-image.yml:call"], undefined, "a job that asks for nothing");
  assert.deepEqual(written.permissions["ops:app-tests.yml:lifecycle"], { contents: "read" });
  assert.deepEqual(written.permissions["website:ci-control.yml:control"], policy.permissions["website:ci-control.yml:control"], "the templates");
  for (const [key, asked] of Object.entries(own.permissions)) assert.deepEqual(written.permissions[key], asked, key);
  for (const name of ["APPCI_INCUS_KEY", "PASSED_ON", "POLICY_APP_CLIENT_ID", "RENOVATE_APP_PRIVATE_KEY"]) assert.ok(written.secrets.includes(name), name);
  assert.ok(!written.secrets.includes("GITHUB_TOKEN"));
  // A failed read writes nothing.
  const failedOut = join(work, "failed.json");
  const failedSeed = run(["--seed", "--local", `ops=${opsTree}`, "--out", failedOut], { ...seedState, fail: ["website/contents"] });
  assert.equal(failedSeed.status, 1, failedSeed.err);
  assert.ok(failedSeed.err.includes("::error::workflow-policy: --seed: gh api"), failedSeed.err);
  assert.ok(!existsSync(failedOut) && !existsSync(`${failedOut}.tmp`));

  // Bad arguments exit 2 and call nothing.
  for (const args of [
    [],
    ["--seed", "x"],
    ["--seed", "--local", "other=/tmp"],
    ["--seed", "--local", `ops=${join(work, "nowhere")}`],
    ["--seed", "--out"],
    ["check", "--repo", REPO, "--sha", HEAD, "--dir", work],
    ["check", "--repo", REPO, "--sha", HEAD, "--dir", work, "--zizmor", "x"],
    ["fetch", "--repo", REPO, "--pr", "0", "--head", HEAD, "--base", BASE, "--dir", work],
    ["error", "--repo", REPO, "--sha", "abc"],
    ["error", "--repo", REPO, "--sha", HEAD, "--bogus", "1"],
  ]) {
    const got = run(args);
    assert.equal(got.status, 2, `${args}\n${got.err}`);
    assert.equal(got.writes.length, 0, `${args}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("workflow-policy: ok");
