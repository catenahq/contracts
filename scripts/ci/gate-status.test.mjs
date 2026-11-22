// gate-status.mjs with a gh stub on PATH: gh answers `gh api <path>` from a
// JSON state file of API payloads and logs a status post to a file. Run with
// `node scripts/ci/gate-status.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "gate-status.mjs");

const work = mkdtempSync(join(tmpdir(), "catena-gate-status-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

// gh api <path>: the payload state.get[path]; gh api -X POST <path> -f k=v...:
// the fields, appended as a JSON line to STUB_POSTS. state.fail lists path
// fragments that answer an error.
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(2);
const post = args[1] === "-X" && args[2] === "POST";
const path = post ? args[3] : args[1];
if (process.env.GH_TOKEN !== "tok") { console.error("gh: no token"); process.exit(4); }
if ((state.fail || []).some((f) => path.includes(f))) { console.error("gh: HTTP 500"); process.exit(1); }
if (post) {
  const fields = { path };
  for (let i = 4; i < args.length; i += 2) {
    if (args[i] !== "-f") process.exit(2);
    const [k, ...v] = args[i + 1].split("=");
    fields[k] = v.join("=");
  }
  fs.appendFileSync(process.env.STUB_POSTS, JSON.stringify(fields) + "\\n");
  process.exit(0);
}
if (!(path in state.get)) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
console.log(JSON.stringify(state.get[path]));
`,
);
chmodSync(join(bin, "gh"), 0o755);

const SHA = "a".repeat(40);
const pull = (body, extra = {}) => ({ body, state: "open", merged_at: null, ...extra });
const MERGED = { state: "closed", merged_at: "2026-11-20T00:00:00Z" };
const status = (context, state) => ({ context, state });

let n = 0;
function exec(get, { args = [], env = {}, fail = [] } = {}) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const posts = join(dir, "posts");
  writeFileSync(posts, "");
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ get, fail }));
  const r = spawnSync(process.execPath, [SCRIPT, "--repo", "catenahq/demo", "--pr", "7", "--sha", SHA, ...args], {
    encoding: "utf-8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, GH_TOKEN: "tok", STUB_STATE: state, STUB_POSTS: posts, ...env },
  });
  const lines = readFileSync(posts, "utf-8").trim().split("\n").filter(Boolean);
  return { status: r.status, err: r.stderr, posts: lines.map((l) => JSON.parse(l)) };
}

const PR7 = "repos/catenahq/demo/pulls/7";
const body = (...lines) => ({ [PR7]: pull(lines.join("\n")) });

// One post, of the context on the sha, with the state and description.
function expectPost(label, got, state, description) {
  assert.equal(got.status, 0, `${label}: exit ${got.status}\n${got.err}`);
  assert.equal(got.posts.length, 1, `${label}: posts`);
  const [p] = got.posts;
  assert.equal(p.path, `repos/catenahq/demo/statuses/${SHA}`, label);
  assert.equal(p.context, "ci / gate", label);
  assert.equal(p.state, state, `${label}: state ${p.state} (${p.description})`);
  assert.equal(p.description, description, label);
  return p;
}

try {
  // No Depends-on line, and a body that is empty or null.
  expectPost("no line", exec(body("text")), "success", "no open dependency");
  expectPost("empty body", exec({ [PR7]: pull("") }), "success", "no open dependency");
  expectPost("null body", exec({ [PR7]: pull(null) }), "success", "no open dependency");

  // A merged dependency, an open one, one closed without merging.
  const dep = (n, p) => ({ [`repos/catenahq/ops/pulls/${n}`]: p });
  expectPost("merged", exec({ ...body("Depends-on: catenahq/ops#12"), ...dep(12, pull("", MERGED)) }), "success", "no open dependency");
  expectPost("open", exec({ ...body("Depends-on: catenahq/ops#12"), ...dep(12, pull("")) }), "pending", "waiting for catenahq/ops#12");
  expectPost(
    "closed unmerged",
    exec({ ...body("Depends-on: catenahq/ops#12"), ...dep(12, pull("", { state: "closed" })) }),
    "pending",
    "catenahq/ops#12 closed without merging",
  );

  // The first unmet dependency is named; CRLF line ends and surrounding text are read.
  const two = { ...body("intro", "Depends-on: catenahq/ops#12\r", "Depends-on: catenahq/docs#3\r", "end"), ...dep(12, pull("", MERGED)), "repos/catenahq/docs/pulls/3": pull("") };
  expectPost("first unmet", exec(two), "pending", "waiting for catenahq/docs#3");

  // A Depends-on line that fails the pattern is ignored with a warning.
  for (const bad of ["Depends-on: ops#12", "Depends-on: catenahq/ops#12 later", "Depends-on:catenahq/ops#12", "Depends-on: other/ops#12", "Depends-on: catenahq/ops#0"]) {
    const got = exec(body(bad));
    expectPost(bad, got, "success", "no open dependency");
    assert.ok(got.err.includes(`::warning::gate-status: ignoring malformed line '${bad}'`), `${bad}\n${got.err}`);
  }
  assert.ok(!exec(body("see Depends-on: catenahq/ops#12 in the text")).err.includes("warning"), "a line that does not start with the key is prose");

  // The dependency repository is the named one, whichever repository the pull request is in.
  const got = exec({ ...body("Depends-on: catenahq/website#9"), "repos/catenahq/website/pulls/9": pull("") });
  expectPost("cross-repository", got, "pending", "waiting for catenahq/website#9");

  // app-tests: the newest status of the sha, and only with the flag.
  const STATUS = `repos/catenahq/demo/commits/${SHA}/status?per_page=100`;
  const withTests = (statuses, extra = {}) => exec({ ...body("text"), ...extra, [STATUS]: { statuses } }, { args: ["--app-tests"] });
  expectPost("app-tests success", withTests([status("app-tests", "success")]), "success", "no open dependency, app-tests passed");
  expectPost("app-tests pending", withTests([status("app-tests", "pending")]), "pending", "waiting for app-tests");
  expectPost("app-tests none", withTests([status("other", "success")]), "pending", "waiting for app-tests");
  expectPost("app-tests failure", withTests([status("app-tests", "failure")]), "failure", "app-tests failed");
  expectPost("app-tests error", withTests([status("app-tests", "error")]), "failure", "app-tests failed");
  expectPost(
    "app-tests with an open dependency",
    withTests([status("app-tests", "success")], { ...body("Depends-on: catenahq/ops#12"), ...dep(12, pull("")) }),
    "pending",
    "waiting for catenahq/ops#12",
  );
  expectPost("app-tests not asked", exec({ ...body("text"), [STATUS]: { statuses: [status("app-tests", "failure")] } }), "success", "no open dependency");
  assert.ok(!exec(body("text")).err.includes("status"), "no status read without the flag");

  // The description is cut at 140 characters.
  const long = "r".repeat(150);
  const cut = exec({ ...body(`Depends-on: catenahq/${long}#1`), [`repos/catenahq/${long}/pulls/1`]: pull("") });
  assert.equal(cut.posts[0].description, `waiting for catenahq/${long}#1`.slice(0, 140));
  assert.equal(cut.posts[0].description.length, 140);

  // target_url is the run's URL when the environment names it, else omitted.
  const env = { GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "catenahq/demo", GITHUB_RUN_ID: "900" };
  assert.equal(expectPost("target", exec(body("text"), { env }), "success", "no open dependency").target_url, "https://github.com/catenahq/demo/actions/runs/900");
  assert.equal("target_url" in exec(body("text")).posts[0], false);

  // An API error exits 1 and posts nothing: an unreadable dependency is not "not merged".
  let bad = exec(body("Depends-on: catenahq/ops#12"));
  assert.equal(bad.status, 1, bad.err);
  assert.ok(bad.err.includes("::error::gate-status: gh api repos/catenahq/ops/pulls/12 failed"), bad.err);
  assert.equal(bad.posts.length, 0);
  bad = exec(body("text"), { fail: ["pulls/7"] });
  assert.equal(bad.status, 1, bad.err);
  bad = exec(body("text"), { args: ["--app-tests"] });
  assert.equal(bad.status, 1, "an unreadable app-tests status is an error");
  bad = exec(body("text"), { fail: ["statuses/"] });
  assert.equal(bad.status, 1, "a failed post is an error");

  // Bad arguments exit 2 and call nothing.
  for (const args of [["--repo", "x"], ["--pr", "x"], ["--sha", "abc"], ["--bogus"]]) {
    const r = spawnSync(process.execPath, [SCRIPT, "--repo", "catenahq/demo", "--pr", "7", "--sha", SHA, ...args], {
      encoding: "utf-8",
      env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "tok" },
    });
    assert.equal(r.status, 2, `${args}\n${r.stderr}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("gate-status: ok");
