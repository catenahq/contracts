// workflow-policy.mjs with a gh stub on PATH: gh answers `gh api <path>` from a
// JSON state file (state.raw for a path asked with the raw media type) and
// logs each POST to a file. The tree under fixtures/workflow-policy/ passes
// every rule; each case edits a copy of it so that one rule fails, or so that
// an edit the rule allows still passes. Run with
// `node scripts/ci/workflow-policy.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_FILE, seed } from "./workflow-policy.mjs";

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
const CHECKOUT = "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7";
const compare = (repo, sha) => `repos/${repo}/compare/${sha}...main`;
const COMPARE = {
  [compare(REPO, ON_MAIN)]: { status: "ahead" },
  [compare("catenahq/scanctl", LOCKED)]: { status: "identical" },
  [compare(REPO, OFF_MAIN)]: { status: "diverged" },
  [compare("catenahq/scanctl", OFF_MAIN)]: { status: "behind" },
};
const CHANGED = [
  { path: "scripts/ci/x.mjs", status: "modified" },
  { path: "README.md", status: "modified" },
  { path: "uv.lock", status: "added" },
  { path: ".github/workflows/ci.yml", status: "modified" },
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
if (process.env.GH_TOKEN !== "tok" || args[0] !== "api") process.exit(2);
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
function run(args, state = {}) {
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
const check = (dir, { zizmor = "0", fail = [] } = {}) =>
  run(["check", "--repo", REPO, "--sha", HEAD, "--dir", dir, "--zizmor", zizmor], { get: COMPARE, fail });

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
  for (const line of ["| zizmor | passed |", "- `scripts/ci/x.mjs` (modified)", "- `uv.lock` (added)"]) {
    assert.ok(clean.summary.includes(line), `'${line}' not in\n${clean.summary}`);
  }
  assert.ok(!clean.summary.includes("README.md") && !clean.summary.includes("`.github/workflows/ci.yml`"), clean.summary);

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

  fails("secrets: inherit", "secrets-inherit", "job ci passes secrets: inherit", {
    [`${W}ci.yml`]: sub("    secrets:\n      CATENA_EE_READ_TOKEN: ${{ secrets.CATENA_EE_READ_TOKEN }}\n", "    secrets: inherit\n"),
  });

  fails("wider than the ceiling", "permissions", "job ci asks for packages: write, wider than none (contracts:ci.yml:ci)", {
    [`${W}ci.yml`]: sub("      statuses: write\n", "      statuses: write\n      packages: write\n"),
  });
  fails("no permissions block", "permissions", "job check has no permissions block", {
    [`${W}pr.yml`]: sub("    permissions:\n      contents: read\n    strategy:", "    strategy:"),
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
  // The pull request's own zizmor directive is dropped; the caller's
  // ci-control.yml ignores dangerous-triggers on its trigger line.
  assert.deepEqual(
    [read("pr/.github/workflows/ci.yml"), read("pr/.github/catenahq.lock"), read("pr/docs/a b.md"), read("base/.github/workflows/ci.yml")],
    ["head: ci # dropped-zizmor-directive: ignore[unpinned-uses]\n", "head lock\n", "doc\n", "base ci\n"],
  );
  assert.equal(read("pr/.github/workflows/ci-control.yml"), CALLER.replace("  pull_request_target:\n", "  pull_request_target: # zizmor: ignore[dangerous-triggers]\n"));
  // Another shape ignores nothing.
  const otherShape = CALLER + JOB("extra", "    permissions: {}\n    steps:\n      - run: echo extra\n");
  const reshaped = run(fetchArgs, { ...fetchState, raw: { ...fetchState.raw, [raw(HEAD, ".github/workflows/ci-control.yml")]: otherShape } });
  assert.equal(reshaped.status, 0, reshaped.err);
  assert.equal(read("pr/.github/workflows/ci-control.yml"), otherShape);
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

  // The committed policy holds every ceiling and secret the seed reads, each
  // ceiling a known level.
  const policy = JSON.parse(readFileSync(POLICY_FILE, "utf-8"));
  const seeded = seed();
  for (const [key, ceiling] of Object.entries(seeded.permissions)) assert.deepEqual(policy.permissions[key], ceiling, key);
  for (const name of seeded.secrets) assert.ok(policy.secrets.includes(name), name);
  for (const [key, ceiling] of Object.entries(policy.permissions)) {
    assert.match(key, /^[\w.-]+:[\w.-]+\.ya?ml:[\w-]+$/);
    for (const level of Object.values(ceiling)) assert.ok(["read", "write"].includes(level), `${key}: ${level}`);
  }

  // Bad arguments exit 2 and call nothing.
  for (const args of [
    [],
    ["--seed", "x"],
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
