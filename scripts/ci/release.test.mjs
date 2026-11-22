// release.sh with stubs on PATH: gh serves the GitHub API from a JSON state
// file and records every call; sleep records its wait. jq is the real one.
// Run with `node scripts/ci/release.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fails, ok } from "./run-result.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "release.sh");
const work = mkdtempSync(join(tmpdir(), "catena-release-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

// Each call is a JSON line of STUB_CALLS: {api: [method, path, fields]},
// {pr: [args]} or {sleep: [args]}. A GET answers state.get[path], or the n-th
// answer of state.series[path] (the last one past its end); a path of
// state.broken answers an error, any other a 404. A write answers
// state.answer[path], else {}. gh refuses a token other than "app".
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const argv = process.argv.slice(2);
const seen = fs.readFileSync(process.env.STUB_CALLS, "utf-8").split("\\n").filter(Boolean).map((l) => JSON.parse(l));
const record = (call) => fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(call) + "\\n");
if (path.basename(process.argv[1]) === "sleep") { record({ sleep: argv }); process.exit(0); }
if (process.env.GH_TOKEN !== "app") { console.error("gh: no token"); process.exit(4); }
if (argv[0] === "pr") { record({ pr: argv.slice(1) }); process.exit(0); }
let method = "GET";
let rest = argv.slice(1);
if (rest[0] === "-X") { method = rest[1]; rest = rest.slice(2); }
const [target, ...options] = rest;
const fields = {};
for (let i = 0; i < options.length; i++) {
  if (options[i] === "--paginate") continue;
  if (!["-f", "-F"].includes(options[i])) { console.error("stub: " + options[i]); process.exit(2); }
  const eq = options[++i].indexOf("=");
  fields[options[i].slice(0, eq)] = options[i].slice(eq + 1);
}
const before = seen.filter((c) => c.api && c.api[0] === method && c.api[1] === target).length;
record({ api: [method, target, fields] });
if ((state.broken || []).includes(target)) { console.error("gh: HTTP 502"); process.exit(1); }
if (method !== "GET") { console.log(JSON.stringify((state.answer || {})[target] || {})); process.exit(0); }
const series = (state.series || {})[target];
const answer = series ? series[Math.min(before, series.length - 1)] : (state.get || {})[target];
if (answer === undefined) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
console.log(JSON.stringify(answer));
`;
for (const name of ["gh", "sleep"]) {
  writeFileSync(join(bin, name), STUB);
  chmodSync(join(bin, name), 0o755);
}

const REPO = "catenahq/demo";
const R = `repos/${REPO}`;
const MAIN = "a".repeat(40);
const RELEASE = "b".repeat(40);
const TAG_OBJECT = "c".repeat(40);
const OTHER = "d".repeat(40);
const RESOLVED = "e".repeat(40);

let n = 0;
function run(step, version, state) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const files = { STUB_STATE: join(dir, "state.json"), STUB_CALLS: join(dir, "calls") };
  writeFileSync(files.STUB_STATE, JSON.stringify(state));
  writeFileSync(files.STUB_CALLS, "");
  const r = spawnSync("bash", [SCRIPT], {
    cwd: dir,
    encoding: "utf-8",
    env: { PATH: `${bin}:${process.env.PATH}`, ...files, REPO, STEP: step, VERSION: version, GH_TOKEN: "app" },
  });
  const calls = readFileSync(files.STUB_CALLS, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // The writes: every API call but a GET, and gh pr.
  const writes = calls.filter((c) => c.pr || (c.api && c.api[0] !== "GET"));
  return { status: r.status, out: r.stdout, err: r.stderr, calls, writes };
}

// Payloads in the shape GitHub answers, cut to the fields the script reads
// and a few beside them.
const ref = (name, sha, type = "commit") =>
  ({ ref: name, node_id: "REF_x", url: `https://api.github.com/${R}/git/${name}`, object: { sha, type, url: "" } });
const compared = (status, ahead_by = 0, behind_by = 0) =>
  ({ status, ahead_by, behind_by, total_commits: ahead_by, commits: [], files: [] });
const pull = (number, headRef, extra = {}) =>
  ({ number, state: "open", head: { ref: headRef, sha: RELEASE }, base: { ref: "main" }, mergeable: null, ...extra });

try {
  // cut: release moves to the head of main by fast-forward, without a version.
  const cutState = (over = {}) => ({
    get: {
      [`${R}/git/ref/heads/main`]: ref("refs/heads/main", MAIN),
      [`${R}/pulls?state=open&per_page=100`]: [pull(3, "fix-docs")],
      [`${R}/compare/release...${MAIN}`]: compared("ahead", 4),
      ...over,
    },
  });
  {
    const r = ok(run("cut", "", cutState()), "cut");
    assert.deepEqual(r.writes, [{ api: ["PATCH", `${R}/git/refs/heads/release`, { sha: MAIN, force: "false" }] }]);
    assert.ok(r.out.includes(`release: cut at main ${MAIN}`), r.out);
    ok(run("cut", "v9.9.9", cutState()), "cut ignores a version");
  }
  {
    const r = ok(run("cut", "", cutState({ [`${R}/compare/release...${MAIN}`]: compared("identical") })), "cut identical");
    assert.deepEqual(r.writes, []);
    assert.ok(r.out.includes("nothing to cut"), r.out);
  }

  // cut refuses, with nothing written: release holds commits main lacks, a
  // merge-back pull request is open, and any failed read.
  for (const [label, state, message] of [
    ["behind", cutState({ [`${R}/compare/release...${MAIN}`]: compared("behind", 0, 2) }), "release holds commits main lacks (behind)"],
    ["diverged", cutState({ [`${R}/compare/release...${MAIN}`]: compared("diverged", 1, 2) }), "(diverged)"],
    ["merge-back open", cutState({ [`${R}/pulls?state=open&per_page=100`]: [pull(3, "fix-docs"), pull(5, "merge-back/v1.2.3")] }),
      "a merge-back pull request is open, merge it first: #5 merge-back/v1.2.3"],
    ["failed pull list", { ...cutState(), broken: [`${R}/pulls?state=open&per_page=100`] }, ""],
    ["failed compare", { ...cutState(), broken: [`${R}/compare/release...${MAIN}`] }, ""],
    ["no main", { get: {} }, ""],
  ]) {
    const r = fails(run("cut", "", state), label, message);
    assert.deepEqual(r.writes, [], label);
  }

  // tag: an annotated tag on the release head, through git/tags and git/refs.
  // matching-refs lists v1.2.30 for the prefix v1.2.3, which is not the tag.
  const tagState = (tags = [ref("refs/tags/v1.2.30", OTHER)]) => ({
    get: { [`${R}/git/ref/heads/release`]: ref("refs/heads/release", RELEASE), [`${R}/git/matching-refs/tags/v1.2.3`]: tags },
    answer: { [`${R}/git/tags`]: { sha: TAG_OBJECT, tag: "v1.2.3" } },
  });
  {
    const r = ok(run("tag", "v1.2.3", tagState()), "tag");
    assert.deepEqual(r.writes, [
      { api: ["POST", `${R}/git/tags`, { tag: "v1.2.3", message: "v1.2.3", object: RELEASE, type: "commit" }] },
      { api: ["POST", `${R}/git/refs`, { ref: "refs/tags/v1.2.3", sha: TAG_OBJECT }] },
    ]);
  }

  // A tag a run made before on the release head is kept; one elsewhere refuses.
  {
    const annotated = (commit) => ({
      ...tagState([ref("refs/tags/v1.2.3", TAG_OBJECT, "tag")]),
      series: { [`${R}/git/tags/${TAG_OBJECT}`]: [{ sha: TAG_OBJECT, object: { type: "commit", sha: commit } }] },
    });
    let r = ok(run("tag", "v1.2.3", annotated(RELEASE)), "tag again");
    assert.deepEqual(r.writes, []);
    assert.ok(r.out.includes(`v1.2.3: already tags release at ${RELEASE}`), r.out);
    r = fails(run("tag", "v1.2.3", annotated(OTHER)), "tag elsewhere", `the tag v1.2.3 exists on ${OTHER}`);
    assert.deepEqual(r.writes, []);
    r = fails(run("tag", "v1.2.3", tagState([ref("refs/tags/v1.2.3", OTHER)])), "lightweight tag elsewhere", "exists on");
    assert.deepEqual(r.writes, []);
  }

  // A version outside vX.Y.Z reads and writes nothing; a failed tag read writes nothing.
  for (const version of ["1.2.3", "v1.2", "v1.2.3-rc1", "v1.2.3\nv1", "v01.2.x"]) {
    const r = fails(run("tag", version, tagState()), `tag ${JSON.stringify(version)}`, "is not vX.Y.Z");
    assert.deepEqual(r.calls, []);
  }
  {
    const r = fails(run("tag", "v1.2.3", { ...tagState(), broken: [`${R}/git/matching-refs/tags/v1.2.3`] }), "failed tag read");
    assert.deepEqual(r.writes, []);
  }

  // merge-back: the tag's commit holds commits main lacks, so the branch
  // merge-back/v1.2.3 is made at it, the pull request opened, and once GitHub
  // finds it mergeable its auto-merge is turned on with a merge commit.
  const BRANCH_REFS = `${R}/git/matching-refs/heads/merge-back/v1.2.3`;
  const BRANCH_PULLS = `${R}/pulls?state=open&head=catenahq:merge-back/v1.2.3&per_page=100`;
  const backState = (get = {}, series = {}) => ({
    get: {
      [`${R}/git/matching-refs/tags/v1.2.3`]: [ref("refs/tags/v1.2.3", TAG_OBJECT, "tag")],
      [`${R}/git/tags/${TAG_OBJECT}`]: { sha: TAG_OBJECT, object: { type: "commit", sha: RELEASE } },
      [`${R}/compare/main...${RELEASE}`]: compared("diverged", 2, 5),
      [BRANCH_REFS]: [],
      [BRANCH_PULLS]: [],
      ...get,
    },
    series: { [`${R}/pulls/12`]: [pull(12, "merge-back/v1.2.3"), pull(12, "merge-back/v1.2.3", { mergeable: true })], ...series },
    answer: { [`${R}/pulls`]: { number: 12 } },
  });
  const merge = { pr: ["merge", "12", "--repo", REPO, "--auto", "--merge"] };
  {
    const r = ok(run("merge-back", "v1.2.3", backState()), "merge-back");
    assert.deepEqual(r.writes, [
      { api: ["POST", `${R}/git/refs`, { ref: "refs/heads/merge-back/v1.2.3", sha: RELEASE }] },
      { api: ["POST", `${R}/pulls`, {
        title: "Merge back v1.2.3", head: "merge-back/v1.2.3", base: "main", body: "Merges the release v1.2.3 back into main.",
      }] },
      merge,
    ]);
    assert.deepEqual(r.calls.filter((c) => c.sleep), [{ sleep: ["5"] }]);
  }

  // Run again: the branch, or the conflict resolution a person pushed on it,
  // holds the tag's commit, and the open pull request is the one merged.
  for (const [label, at, status] of [["same branch", RELEASE, "identical"], ["resolved", RESOLVED, "ahead"]]) {
    const state = backState({
      [BRANCH_REFS]: [ref("refs/heads/merge-back/v1.2.3", at)],
      [BRANCH_PULLS]: [pull(12, "merge-back/v1.2.3")],
      [`${R}/compare/${RELEASE}...${at}`]: compared(status, status === "ahead" ? 1 : 0),
    });
    const r = ok(run("merge-back", "v1.2.3", state), label);
    assert.deepEqual(r.writes, [merge], label);
  }

  // Nothing to merge back once main holds the tag's commit.
  {
    const r = ok(run("merge-back", "v1.2.3", backState({ [`${R}/compare/main...${RELEASE}`]: compared("behind", 0, 3) })), "merged");
    assert.deepEqual(r.writes, []);
    assert.ok(r.out.includes("nothing to merge back"), r.out);
  }

  // A conflict with main fails, with the branch and pull request left for a
  // person to resolve and auto-merge off; so does a mergeable GitHub never
  // computes. Nothing is force-pushed.
  {
    let r = fails(run("merge-back", "v1.2.3", backState({}, { [`${R}/pulls/12`]: [pull(12, "merge-back/v1.2.3", { mergeable: false })] })),
      "conflict", "#12: merge-back/v1.2.3 conflicts with main");
    assert.deepEqual(r.writes.map((w) => w.api.slice(0, 2)), [["POST", `${R}/git/refs`], ["POST", `${R}/pulls`]]);
    r = fails(run("merge-back", "v1.2.3", backState({}, { [`${R}/pulls/12`]: [pull(12, "merge-back/v1.2.3")] })),
      "never computed", "GitHub has not computed whether");
    assert.equal(r.calls.filter((c) => c.sleep).length, 11);
    assert.ok(!r.writes.some((w) => w.pr), "auto-merge stays off");
  }

  // merge-back refuses, with nothing written: no tag, a branch that lacks the
  // tag's commit, a bad version, and any failed read.
  for (const [label, version, state, message] of [
    ["no tag", "v1.2.3", backState({ [`${R}/git/matching-refs/tags/v1.2.3`]: [] }), "the tag v1.2.3 does not exist"],
    ["foreign branch", "v1.2.3", backState({
      [BRANCH_REFS]: [ref("refs/heads/merge-back/v1.2.3", OTHER)],
      [`${R}/compare/${RELEASE}...${OTHER}`]: compared("diverged", 1, 1),
    }), `merge-back/v1.2.3 exists at ${OTHER}, which does not hold v1.2.3`],
    ["bad version", "main", backState(), "the version 'main' is not vX.Y.Z"],
    ["failed tag read", "v1.2.3", { ...backState(), broken: [`${R}/git/tags/${TAG_OBJECT}`] }, ""],
    ["failed compare", "v1.2.3", { ...backState(), broken: [`${R}/compare/main...${RELEASE}`] }, ""],
    ["failed branch read", "v1.2.3", { ...backState(), broken: [BRANCH_REFS] }, ""],
    ["failed pull read", "v1.2.3", { ...backState(), broken: [BRANCH_PULLS] }, ""],
  ]) {
    const r = fails(run("merge-back", version, state), label, message);
    assert.deepEqual(r.writes, [], label);
  }

  // tag and merge-back without a version call nothing and ask for one.
  for (const [step, state] of [["tag", tagState()], ["merge-back", backState()]]) {
    const r = fails(run(step, "", state), `${step} without a version`,
      `the step ${step} needs a version: run it again with the input version set to vX.Y.Z`);
    assert.deepEqual(r.calls, [], step);
  }

  // An unknown step calls nothing.
  {
    const r = fails(run("publish", "v1.2.3", { get: {} }), "unknown step", "the step 'publish' is not cut, tag or merge-back");
    assert.deepEqual(r.calls, []);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("release: ok");
