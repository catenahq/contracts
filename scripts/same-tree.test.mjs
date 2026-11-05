// The same-tree action's script and checkout-sibling's resolve.sh, run with
// stubs on PATH: gh answers from a JSON state file of API payloads in the
// shapes `gh api` returns and applies the script's --jq projection to them;
// git answers ls-remote from the same file; date and sleep share a fake clock
// so waits take no time. A state value written as { seq: [a, b, ...] }
// answers a, then b, and keeps the last. The projection evaluator covers the
// jq the script uses and refuses anything else; it is checked against
// payloads and outputs recorded from `gh api`. Run with
// `node scripts/same-tree.test.mjs`.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ACTIONS = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "actions");
const SCRIPT = join(ACTIONS, "same-tree", "same-tree.sh");
const RESOLVE = join(ACTIONS, "checkout-sibling", "resolve.sh");

const work = mkdtempSync(join(tmpdir(), "catena-same-tree-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

// jq evaluator: pipes, `//`, parentheses, array construction, string
// literals, paths (.a.b, .a[0], .a[], .[]), sort_by, reverse, tostring, @tsv.
writeFileSync(
  join(bin, "jq.cjs"),
  `
function splitTop(s, sep) {
  const parts = [];
  let depth = 0, cur = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      cur += c;
      if (c === "\\\\") cur += s[++i];
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth--;
    if (depth === 0 && s.startsWith(sep, i)) { parts.push(cur.trim()); cur = ""; i += sep.length - 1; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  return parts;
}
function wraps(s, open, close) {
  return s.startsWith(open) && s.endsWith(close) && balanced(s.slice(1, -1));
}
function balanced(s) {
  let depth = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") { depth--; if (depth < 0) return false; }
  }
  return depth === 0;
}
function tsvField(x) {
  if (x === null) return "";
  if (typeof x === "string") return x.replace(/\\\\/g, "\\\\\\\\").replace(/\\t/g, "\\\\t").replace(/\\n/g, "\\\\n").replace(/\\r/g, "\\\\r");
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  throw new Error("@tsv: cannot format " + JSON.stringify(x));
}
function path(s, v) {
  let vals = [v];
  let rest = s;
  while (rest.length) {
    let m;
    if ((m = rest.match(/^\\.([A-Za-z_][A-Za-z0-9_]*)/))) {
      const k = m[1];
      vals = vals.map((x) => {
        if (x === null) return null;
        if (typeof x !== "object" || Array.isArray(x)) throw new Error("cannot index " + typeof x + " with " + k);
        return k in x ? x[k] : null;
      });
    } else if ((m = rest.match(/^\\.?\\[(\\d+)\\]/))) {
      const n = Number(m[1]);
      vals = vals.map((x) => (x === null ? null : (x[n] ?? null)));
    } else if ((m = rest.match(/^\\.?\\[\\]/))) {
      vals = vals.flatMap((x) => {
        if (Array.isArray(x)) return x;
        if (x && typeof x === "object") return Object.values(x);
        throw new Error("cannot iterate over " + JSON.stringify(x));
      });
    } else if ((m = rest.match(/^\\.$/))) {
      // identity
    } else {
      throw new Error("unsupported jq path: " + s);
    }
    rest = rest.slice(m[0].length);
  }
  return vals;
}
function stage(s, v) {
  const alt = splitTop(s, "//");
  if (alt.length === 2) {
    const a = pipe(alt[0], v).filter((x) => x !== null && x !== false);
    return a.length ? a : pipe(alt[1], v);
  }
  if (wraps(s, "(", ")")) return pipe(s.slice(1, -1), v);
  if (wraps(s, "[", "]")) return [splitTop(s.slice(1, -1), ",").flatMap((e) => pipe(e, v))];
  if (/^"([^"\\\\]|\\\\.)*"$/.test(s)) return [JSON.parse(s)];
  if (s === "reverse") return [[...v].reverse()];
  if (s === "tostring") return [typeof v === "string" ? v : JSON.stringify(v)];
  if (s === "@tsv") {
    if (!Array.isArray(v)) throw new Error("@tsv needs an array");
    return [v.map(tsvField).join("\\t")];
  }
  let m;
  if ((m = s.match(/^sort_by\\((.+)\\)$/))) {
    const key = (x) => pipe(m[1], x)[0];
    return [[...v].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))];
  }
  if (s.startsWith(".")) return path(s, v);
  throw new Error("unsupported jq: " + s);
}
function pipe(expr, v) {
  let vals = [v];
  for (const s of splitTop(expr, "|")) vals = vals.flatMap((x) => stage(s, x));
  return vals;
}
// Prints like gh --jq: strings raw, other values as JSON, one per line.
function render(expr, input) {
  return pipe(expr.trim(), input).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\\n");
}
module.exports = { render };
`,
);

const STUB_LIB = `
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
function take(obj, key) {
  const v = obj?.[key];
  if (v && Array.isArray(v.seq)) {
    if (v.seq.length > 1) {
      const first = v.seq.shift();
      fs.writeFileSync(process.env.STUB_STATE, JSON.stringify(state));
      return first;
    }
    return v.seq[0];
  }
  return v;
}
function log(line) { fs.appendFileSync(process.env.STUB_LOG, line + "\\n"); }
`;

// gh api <path> --jq <expr>: the payload for the path, through the projection.
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
${STUB_LIB}
const { render } = require("./jq.cjs");
const [, , cmd, path, flag, expr] = process.argv;
log("gh " + path + " [token " + (process.env.GH_TOKEN || "none") + "]");
if (cmd !== "api" || flag !== "--jq") process.exit(2);
if ((state.fail || []).some((f) => path.includes(f))) { console.error("HTTP 500"); process.exit(1); }
const [p, q = ""] = path.split("?");
const query = Object.fromEntries(new URLSearchParams(q));
let m;
let body;
if ((m = p.match(/\\/git\\/commits\\/([0-9a-f]+)$/))) {
  body = take(state.commits, m[1]);
} else if (/\\/actions\\/artifacts$/.test(p)) {
  const artifacts = take(state.artifacts, query.name) || [];
  body = { total_count: artifacts.length, artifacts };
} else if ((m = p.match(/\\/actions\\/runs\\/([0-9]+)$/))) {
  body = take(state.runs, m[1]);
} else if (/\\/actions\\/workflows\\/[^/]+\\/runs$/.test(p)) {
  const workflow_runs = take(state.shaRuns, query.head_sha) || [];
  body = { total_count: workflow_runs.length, workflow_runs };
}
if (body === undefined) { console.error("HTTP 404"); process.exit(1); }
let text;
try { text = render(expr, body); } catch (e) { console.error("jq stub: " + e.message); process.exit(3); }
if (text) console.log(text);
`,
);

// git ls-remote --heads <url> refs/heads/<b> | git ls-remote --symref <url> HEAD
writeFileSync(
  join(bin, "git"),
  `#!/usr/bin/env node
${STUB_LIB}
const args = process.argv.slice(2);
const header = process.env.GIT_CONFIG_VALUE_0 || "";
const auth = header ? Buffer.from(header.replace(/^AUTHORIZATION: basic /, ""), "base64").toString().replace(/^x-access-token:/, "") : "none";
log("git " + args.join(" ") + " [auth " + auth + "]");
if (args[0] !== "ls-remote" || state.gitFail) process.exit(128);
const repo = args[2].replace(/^https:\\/\\/github.com\\//, "").replace(/\\.git$/, "");
if (args[1] === "--symref") {
  console.log("ref: refs/heads/" + ((state.defaults || {})[repo] || "main") + "\\tHEAD");
} else {
  const b = args[3].replace(/^refs\\/heads\\//, "");
  if (((state.branches || {})[repo] || []).includes(b)) console.log("c".repeat(40) + "\\t" + args[3]);
}
`,
);
writeFileSync(join(bin, "date"), '#!/bin/sh\ncat "$STUB_CLOCK"\n');
writeFileSync(join(bin, "sleep"), '#!/bin/sh\necho $(( $(cat "$STUB_CLOCK") + $1 )) > "$STUB_CLOCK"\n');
for (const f of ["gh", "git", "date", "sleep"]) chmodSync(join(bin, f), 0o755);

const { render } = createRequire(import.meta.url)(join(bin, "jq.cjs"));

const HEAD = "a".repeat(40);
const PARENT = "b".repeat(40);
const MERGE = "d".repeat(40);
const PR_HEAD = "e".repeat(40);
const OTHER = "9".repeat(40);
const REBASED = "7".repeat(40);
const T_HEAD = "1".repeat(40);
const T_PARENT = "2".repeat(40);
const T_OTHER = "3".repeat(40);
const API = "https://api.github.com/repos/catenahq/demo";
const URL = "https://github.com/catenahq/demo/actions/runs/";

// API payloads, in the shapes gh api returns, trimmed of fields the script
// never reads.
function commit(sha, tree, parent) {
  return {
    sha,
    node_id: `C_${sha.slice(0, 8)}`,
    url: `${API}/git/commits/${sha}`,
    html_url: `https://github.com/catenahq/demo/commit/${sha}`,
    author: { name: "t", email: "t@example.com", date: "2026-11-05T00:00:00Z" },
    committer: { name: "t", email: "t@example.com", date: "2026-11-05T00:00:00Z" },
    tree: { sha: tree, url: `${API}/git/trees/${tree}` },
    message: "m",
    parents: parent ? [{ sha: parent, url: `${API}/git/commits/${parent}`, html_url: "" }] : [],
    verification: { verified: false, reason: "unsigned" },
  };
}

function run(id, { path = ".github/workflows/ci.yml", event = "push", status = "completed", conclusion, headSha = HEAD } = {}) {
  return {
    id: Number(id),
    name: "CI",
    node_id: `WFR_${id}`,
    head_branch: "main",
    head_sha: headSha,
    path,
    display_title: "m",
    run_number: 1,
    event,
    status,
    conclusion: status === "completed" ? conclusion ?? null : null,
    workflow_id: 7,
    url: `${API}/actions/runs/${id}`,
    html_url: `${URL}${id}`,
    pull_requests: [],
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:01:00Z",
    run_attempt: 1,
    run_started_at: "2026-11-05T00:00:00Z",
    previous_attempt_url: null,
    repository: { id: 100, full_name: "catenahq/demo" },
    head_repository: { id: 100, full_name: "catenahq/demo" },
  };
}

// Artifacts given newest first; stored oldest first, so only a sort by
// created_at puts them back in order.
function artifacts(name, list) {
  return list
    .map(({ run: runId, repo = 100, headRepo = repo, headSha = HEAD, expired = false }, i) => {
      const at = `2026-11-05T00:00:${String(59 - i).padStart(2, "0")}Z`;
      return {
        id: 9000 + i,
        node_id: `MDg_${i}`,
        name,
        size_in_bytes: 77,
        url: `${API}/actions/artifacts/${9000 + i}`,
        archive_download_url: `${API}/actions/artifacts/${9000 + i}/zip`,
        expired,
        digest: "sha256:00",
        created_at: at,
        updated_at: at,
        expires_at: "2026-12-05T00:00:00Z",
        workflow_run: { id: runId, repository_id: repo, head_repository_id: headRepo, head_branch: "main", head_sha: headSha },
      };
    })
    .reverse();
}

const COMMITS = {
  [HEAD]: commit(HEAD, T_HEAD, PARENT),
  [PARENT]: commit(PARENT, T_PARENT, "8".repeat(40)),
  [MERGE]: commit(MERGE, T_HEAD, PARENT),
  [PR_HEAD]: commit(PR_HEAD, T_HEAD, PARENT),
  [OTHER]: commit(OTHER, T_OTHER, HEAD),
  [REBASED]: commit(REBASED, T_HEAD, OTHER),
};

// The record name for a key, as the README documents it.
function record(lines, name = "ci") {
  const key = lines.map((l) => l + "\n").join("");
  return `same-tree.${name}.${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}
const REC = record([`tree=${T_HEAD}`]);

function outputsOf(file) {
  const outputs = {};
  if (!existsSync(file)) return outputs;
  const lines = readFileSync(file, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([^<=]+)<<(.+)$/);
    if (!m) continue;
    const value = [];
    for (i++; lines[i] !== m[2]; i++) value.push(lines[i]);
    outputs[m[1]] = value.join("\n");
  }
  return outputs;
}

let n = 0;
function exec(state, env = {}, script = SCRIPT) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const files = {
    STUB_STATE: join(dir, "state.json"),
    STUB_LOG: join(dir, "calls.log"),
    STUB_CLOCK: join(dir, "clock"),
    GITHUB_OUTPUT: join(dir, "output"),
    GITHUB_STEP_SUMMARY: join(dir, "summary"),
  };
  writeFileSync(files.STUB_STATE, JSON.stringify({ commits: COMMITS, ...state }));
  writeFileSync(files.STUB_LOG, "");
  writeFileSync(files.STUB_CLOCK, "1000\n");
  const result = spawnSync("bash", [script], {
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      RUNNER_TEMP: dir,
      GITHUB_REPOSITORY: "catenahq/demo",
      GITHUB_REPOSITORY_ID: "100",
      GITHUB_RUN_ID: "900",
      GITHUB_EVENT_NAME: "push",
      GITHUB_SHA: HEAD,
      GITHUB_WORKFLOW_REF: "catenahq/demo/.github/workflows/ci.yml@refs/heads/main",
      GITHUB_REF_NAME: "main",
      GITHUB_REF_TYPE: "branch",
      GH_TOKEN: "api-token",
      ST_SIBLING_TOKEN: "sibling-token",
      ...files,
      ...env,
    },
  });
  return {
    status: result.status,
    out: result.stdout + result.stderr,
    stdout: result.stdout,
    outputs: outputsOf(files.GITHUB_OUTPUT),
    calls: readFileSync(files.STUB_LOG, "utf-8"),
    waited: Number(readFileSync(files.STUB_CLOCK, "utf-8")) - 1000,
    summary: existsSync(files.GITHUB_STEP_SUMMARY) ? readFileSync(files.GITHUB_STEP_SUMMARY, "utf-8") : "",
  };
}

const PR = {
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_SHA: MERGE,
  GITHUB_HEAD_REF: "feature",
  GITHUB_BASE_REF: "main",
  GITHUB_REF_NAME: "7/merge",
  ST_PR_HEAD_SHA: PR_HEAD,
};

// One record of REC from run 500, with that run's spec (or { seq: [spec...] }).
function source(spec, artifact = {}) {
  const runState = spec.seq ? { seq: spec.seq.map((s) => run(500, s)) } : run(500, spec);
  return { artifacts: { [REC]: artifacts(REC, [{ run: 500, ...artifact }]) }, runs: { 500: runState } };
}

function expectRun(label, got, { upload = true, warning = false } = {}) {
  assert.equal(got.status, 0, `${label}: exit ${got.status}\n${got.out}`);
  assert.equal(got.out.includes("::warning::"), warning, `${label}: warning\n${got.out}`);
  assert.ok(!got.out.includes("jq stub"), `${label}: projection\n${got.out}`);
  assert.equal(got.outputs.run, "true", `${label}: run\n${got.out}`);
  assert.equal(got.outputs.state, "", label);
  if (upload) {
    assert.equal(got.outputs["upload-name"], REC, `${label}: upload-name\n${got.out}`);
    assert.equal(readFileSync(got.outputs["upload-path"], "utf-8"), `tree=${T_HEAD}\n`, label);
  } else {
    assert.equal(got.outputs["upload-name"], undefined, `${label}: no upload\n${got.out}`);
  }
}

function expectReuse(label, got, state, status, sha = HEAD) {
  assert.equal(got.status, status, `${label}: exit ${got.status}\n${got.out}`);
  assert.equal(got.outputs.run, "false", `${label}: run\n${got.out}`);
  assert.equal(got.outputs.state, state, label);
  assert.equal(got.outputs.source, `${URL}500`, label);
  assert.equal(got.outputs.results, `${sha} ${state} ${URL}500`, label);
  assert.ok(got.out.includes(`::notice::same tree as ${URL}500 (${state}): nothing ran`), `${label}\n${got.out}`);
  assert.ok(got.summary.includes(`${URL}500`), `${label}: summary`);
  assert.equal(got.outputs["upload-name"], undefined, `${label}: a reuse records nothing`);
}

try {
  // The evaluator gives what gh printed for the script's projections over
  // payloads recorded from catenahq/scanctl.
  const scriptText = readFileSync(SCRIPT, "utf-8");
  const jq = (name) => scriptText.match(new RegExp(`^${name}='(.*)'$`, "m"))[1];
  const rec = {
    commit: {
      sha: "c46dd0fa968af73bfd10e16e05ca29f9fec1518c",
      tree: { sha: "3e74fa2045d578d77d56619b28798c28ee2e2ac6", url: "" },
      parents: [{ sha: "2bba2dcd3e47776c0109ece399e470d1107ccc25", url: "", html_url: "" }],
    },
    artifacts: {
      total_count: 110,
      artifacts: [
        {
          created_at: "2026-11-05T00:36:35Z",
          digest: "sha256:18e22744b3c1db7a293f392417b56d5b662c913954e519a5e89635efb9b219f3",
          expired: false,
          expires_at: "2027-02-03T00:35:35Z",
          id: 13376967331,
          name: "scanctl-sarif",
          size_in_bytes: 4375,
          updated_at: "2026-11-05T00:36:35Z",
          workflow_run: {
            head_branch: "main",
            head_repository_id: 1264592339,
            head_sha: "c46dd0fa968af73bfd10e16e05ca29f9fec1518c",
            id: 41942473047,
            repository_id: 1264592339,
          },
        },
      ],
    },
    run: {
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_repository: { full_name: "catenahq/scanctl", id: 1264592339 },
      head_sha: "c46dd0fa968af73bfd10e16e05ca29f9fec1518c",
      html_url: "https://github.com/catenahq/scanctl/actions/runs/41942473047",
      id: 41942473047,
      name: "CI",
      path: ".github/workflows/ci.yml",
      repository: { full_name: "catenahq/scanctl", id: 1264592339 },
      run_attempt: 1,
      status: "completed",
      workflow_id: 292563667,
    },
  };
  assert.equal(render(jq("JQ_COMMIT"), rec.commit), "3e74fa2045d578d77d56619b28798c28ee2e2ac6\t2bba2dcd3e47776c0109ece399e470d1107ccc25");
  assert.equal(render(jq("JQ_ARTIFACTS"), rec.artifacts), "41942473047\t1264592339\t1264592339\tfalse");
  assert.equal(
    render(jq("JQ_RUN"), rec.run),
    ".github/workflows/ci.yml\tpush\tcompleted\tsuccess\thttps://github.com/catenahq/scanctl/actions/runs/41942473047\tc46dd0fa968af73bfd10e16e05ca29f9fec1518c",
  );
  assert.equal(render(jq("JQ_SHA_RUNS"), { total_count: 1, workflow_runs: [rec.run] }), "41942473047\tpush\tcompleted");
  assert.equal(render(jq("JQ_RUN"), { ...rec.run, conclusion: null, status: "in_progress" }).split("\t")[3], "none");
  assert.equal(render(jq("JQ_COMMIT"), { ...rec.commit, parents: [] }).split("\t")[1], "none");
  // A wrong field name projects to an empty field.
  assert.equal(render("[.workflow_run.idd, .expired] | @tsv", rec.artifacts.artifacts[0]), "\tfalse");
  assert.throws(() => render("map(.id)", rec.run), /unsupported jq/);

  // No record: the checks run and the key is recorded.
  expectRun("no record", exec({}));

  // A success is reused; a failure is carried with exit 1 to a run of its own
  // event, on push and on pull_request.
  expectReuse("success", exec(source({ conclusion: "success" })), "success", 0);
  let got = exec(source({ conclusion: "failure" }));
  expectReuse("failure push", got, "failure", 1);
  assert.ok(got.out.includes(`::error::same tree as ${URL}500, which failed`), got.out);
  expectReuse("failure pr", exec(source({ conclusion: "failure", event: "pull_request" }), PR), "failure", 1, MERGE);

  // A success carries across events; a failure does not: a push judges the
  // absolute gate, a pull request only new failures.
  expectReuse("push pass to pr", exec(source({ conclusion: "success" }), PR), "success", 0, MERGE);
  expectReuse("pr pass to push", exec(source({ conclusion: "success", event: "pull_request" })), "success", 0);
  expectRun("push failure to pr", exec(source({ conclusion: "failure" }), PR));
  expectRun("pr failure to push", exec(source({ conclusion: "failure", event: "pull_request" })));
  expectRun("schedule failure to push", exec(source({ conclusion: "failure", event: "schedule" })));

  // Not a result: a cancelled or timed-out run, a fork's run, a run whose head
  // has another tree (a forged record, or a pull request behind its base),
  // this run itself, an expired record, another workflow file, a run whose
  // event is not a source event.
  expectRun("cancelled", exec(source({ conclusion: "cancelled" })));
  expectRun("timed out", exec(source({ conclusion: "timed_out" })));
  expectRun("fork", exec(source({ conclusion: "success" }, { headRepo: 200 })));
  expectRun("other repo", exec(source({ conclusion: "success" }, { repo: 200, headRepo: 200 })));
  expectRun("other tree", exec(source({ conclusion: "success", headSha: OTHER })));
  expectRun("this run", exec({ artifacts: { [REC]: artifacts(REC, [{ run: 900 }]) }, runs: { 900: run(900, { conclusion: "success" }) } }));
  expectRun("expired", exec(source({ conclusion: "success" }, { expired: true })));
  expectRun("other workflow", exec(source({ conclusion: "success", path: ".github/workflows/security.yml" })));
  expectRun("dispatch source", exec(source({ conclusion: "success", event: "workflow_dispatch" })));
  expectRun("source-events", exec(source({ conclusion: "success", event: "pull_request" }), { ST_SOURCE_EVENTS: "push" }));

  // Newest first by created_at: the first qualifying entry wins, past ones
  // that do not count.
  got = exec({
    artifacts: { [REC]: artifacts(REC, [{ run: 501 }, { run: 502 }, { run: 500 }, { run: 503 }]) },
    runs: {
      501: run(501, { conclusion: "cancelled" }),
      502: run(502, { conclusion: "failure", event: "workflow_dispatch" }),
      500: run(500, { conclusion: "success" }),
      503: run(503, { conclusion: "failure" }),
    },
  });
  expectReuse("newest qualifying", got, "success", 0);

  // An in-progress source is waited for on a pull request, then reused.
  got = exec(source({ seq: [{ status: "in_progress" }, { status: "queued" }, { conclusion: "success" }] }), PR);
  expectReuse("waited", got, "success", 0, MERGE);
  assert.equal(got.waited, 60, got.out);
  assert.ok(got.out.includes("waiting up to 30 min"), got.out);

  // The wait ends at wait-minutes and the checks run.
  got = exec(source({ status: "in_progress" }), { ...PR, ST_WAIT_MINUTES: "2" });
  expectRun("timeout", got);
  assert.ok(got.waited >= 120 && got.waited <= 150, `waited ${got.waited}`);
  assert.ok(got.out.includes("still going after 2 min"), got.out);

  // Push events do not wait by default: the in-progress source is passed over.
  got = exec(source({ status: "in_progress" }));
  expectRun("push no wait", got);
  assert.equal(got.waited, 0);
  assert.ok(!got.calls.includes("/runs?head_sha="), got.calls);

  // With no record yet, a push run of the same commit still going is waited
  // for; its record then appears, and answers once the run completes.
  const pushRunning = [run(500, { status: "in_progress" })];
  got = exec(
    {
      artifacts: { [REC]: { seq: [[], artifacts(REC, [{ run: 500 }])] } },
      runs: { 500: { seq: [run(500, { status: "in_progress" }), run(500, { conclusion: "success" })] } },
      shaRuns: { [HEAD]: pushRunning },
    },
    { ST_WAIT_MINUTES: "5" },
  );
  expectReuse("same commit", got, "success", 0);
  assert.equal(got.waited, 60, got.out);

  // On a pull request, a push run of the PR head is waited for when the head
  // has the merge commit's tree; a pull_request run is not. A waited push run
  // that failed leaves the pull request to run its own checks.
  const prHeadRun = (conclusion) => ({
    artifacts: { [REC]: { seq: [[], artifacts(REC, [{ run: 500, headSha: PR_HEAD }])] } },
    runs: { 500: run(500, { conclusion, headSha: PR_HEAD }) },
    shaRuns: {
      [PR_HEAD]: {
        seq: [[run(500, { status: "in_progress", headSha: PR_HEAD })], [run(500, { conclusion, headSha: PR_HEAD })]],
      },
    },
  });
  got = exec(prHeadRun("success"), PR);
  expectReuse("pr head", got, "success", 0, MERGE);
  assert.equal(got.waited, 30, got.out);
  got = exec(prHeadRun("failure"), PR);
  expectRun("pr head push failed", got);
  assert.equal(got.waited, 30, got.out);
  got = exec({ shaRuns: { [PR_HEAD]: [run(501, { event: "pull_request", status: "in_progress", headSha: PR_HEAD })] } }, PR);
  expectRun("pr head pr run", got);
  assert.equal(got.waited, 0);
  got = exec({ ...prHeadRun("success"), commits: { ...COMMITS, [PR_HEAD]: commit(PR_HEAD, T_OTHER, PARENT) } }, PR);
  expectRun("pr head other tree", got);
  assert.equal(got.waited, 0);
  assert.ok(!got.calls.includes(`head_sha=${PR_HEAD}`), got.calls);

  // judge-change adds the base tree: the first parent, or the line's base. A
  // source counts only when its head's first parent has that base tree.
  const REC_CHANGE = record([`tree=${T_HEAD}`, `base=${T_PARENT}`]);
  got = exec({}, { ST_JUDGE_CHANGE: "true" });
  assert.equal(got.outputs["upload-name"], REC_CHANGE, got.out);
  got = exec({}, { ST_JUDGE_CHANGE: "true", ST_COMMITS: `${HEAD} ${OTHER}` });
  assert.equal(got.outputs["upload-name"], record([`tree=${T_HEAD}`, `base=${T_OTHER}`]), got.out);
  const changeSource = (headSha) => ({
    artifacts: { [REC_CHANGE]: artifacts(REC_CHANGE, [{ run: 500, headSha }]) },
    runs: { 500: run(500, { conclusion: "success", headSha }) },
  });
  got = exec(changeSource(PR_HEAD), { ST_JUDGE_CHANGE: "true" });
  assert.equal(got.outputs.run, "false", `same tree and base tree\n${got.out}`);
  got = exec(changeSource(REBASED), { ST_JUDGE_CHANGE: "true" });
  assert.equal(got.outputs.run, "true", `same tree, other base tree\n${got.out}`);
  assert.equal(got.outputs["upload-name"], REC_CHANGE, got.out);

  // Siblings add the branch each one checks out, the default branch by name,
  // looked up with the sibling token; the API calls use the other token.
  const sib = { branches: { "catenahq/contracts": ["main", "feature"], "catenahq/docs": ["main"] } };
  const twoSibs = { ST_SIBLINGS: "catenahq/docs\ncatenahq/contracts" };
  got = exec(sib, twoSibs);
  const onMain = record([`tree=${T_HEAD}`, "catenahq/contracts=main", "catenahq/docs=main"]);
  assert.equal(got.outputs["upload-name"], onMain, got.out);
  const lines = got.calls.trim().split("\n");
  assert.ok(lines.some((l) => l.startsWith("git ")) && lines.some((l) => l.startsWith("gh ")), got.calls);
  for (const l of lines) {
    if (l.startsWith("git ")) assert.ok(l.endsWith("[auth sibling-token]"), l);
    if (l.startsWith("gh ")) assert.ok(l.endsWith("[token api-token]"), l);
  }
  got = exec(sib, { ...twoSibs, GITHUB_REF_NAME: "other" });
  assert.ok(got.calls.includes("--symref https://github.com/catenahq/docs.git HEAD [auth sibling-token]"), got.calls);
  assert.equal(got.outputs["upload-name"], onMain, `default branch named\n${got.out}`);
  got = exec(sib, { ...twoSibs, GITHUB_REF_NAME: "feature" });
  assert.equal(
    got.outputs["upload-name"],
    record([`tree=${T_HEAD}`, "catenahq/contracts=feature", "catenahq/docs=main"]),
    got.out,
  );
  got = exec(sib, { ...twoSibs, GITHUB_REF_NAME: "feature", ST_BRANCH: "main" });
  assert.equal(got.outputs["upload-name"], onMain, `branch input\n${got.out}`);
  expectRun("sibling error", exec({ gitFail: true }, twoSibs), { upload: false, warning: true });

  // Several commits fill results, never fail the step and record nothing.
  const REC_OTHER = record([`tree=${T_OTHER}`]);
  got = exec(
    {
      artifacts: {
        [REC]: artifacts(REC, [{ run: 500 }]),
        [REC_OTHER]: artifacts(REC_OTHER, [{ run: 501, headSha: OTHER }]),
      },
      runs: { 500: run(500, { conclusion: "success" }), 501: run(501, { conclusion: "failure", headSha: OTHER }) },
    },
    { ST_COMMITS: `${HEAD}\n${OTHER}\n${PARENT}` },
  );
  assert.equal(got.status, 0, got.out);
  assert.equal(got.outputs.run, "true");
  assert.equal(got.outputs.results, `${HEAD} success ${URL}500\n${OTHER} failure ${URL}501`);
  assert.equal(got.outputs["upload-name"], undefined);
  got = exec(source({ conclusion: "success" }), { ST_COMMITS: `${HEAD}\n${HEAD}` });
  assert.equal(got.outputs.run, "false", got.out);

  // An API error means run, with a warning; the key is still recorded when it
  // was computed.
  got = exec({ ...source({ conclusion: "success" }), fail: ["actions/artifacts"] });
  expectRun("api error", got, { warning: true });
  assert.ok(got.out.includes("::warning::same-tree: a GitHub API call failed"), got.out);
  expectRun("run api error", exec({ ...source({ conclusion: "success" }), fail: ["actions/runs/500"] }), { warning: true });
  expectRun("commit api error", exec({ fail: ["git/commits"] }), { upload: false, warning: true });

  // Only push and pull_request reuse. A schedule is recorded; the events
  // whose GITHUB_SHA is not the judged code are neither.
  got = exec(source({ conclusion: "success" }), { GITHUB_EVENT_NAME: "schedule" });
  expectRun("schedule", got);
  assert.ok(!got.calls.includes("actions/artifacts"), got.calls);
  for (const event of ["workflow_dispatch", "pull_request_target", "repository_dispatch", "workflow_run"]) {
    got = exec(source({ conclusion: "success" }), { ...PR, GITHUB_EVENT_NAME: event });
    expectRun(event, got, { upload: false });
    assert.ok(!got.calls.includes("actions/artifacts"), `${event}\n${got.calls}`);
  }

  // record: false records nothing; name and workflow inputs replace the
  // caller's.
  expectRun("record false", exec({}, { ST_RECORD: "false" }), { upload: false });
  const REC_BUILD = record([`tree=${T_HEAD}`], "build");
  got = exec(
    {
      artifacts: { [REC_BUILD]: artifacts(REC_BUILD, [{ run: 500 }]) },
      runs: { 500: run(500, { conclusion: "success", path: ".github/workflows/build.yml" }) },
    },
    { ST_NAME: "build", ST_WORKFLOW: ".github/workflows/build.yml" },
  );
  expectReuse("inputs", got, "success", 0);

  // Bad inputs fail the step.
  assert.equal(exec({}, { ST_SIBLINGS: "not a repo/x/y" }).status, 1);
  assert.equal(exec({}, { ST_COMMITS: "HEAD" }).status, 1);

  // resolve.sh: the first candidate the sibling has wins, bot branches never.
  const branches = { branches: { "catenahq/sib": ["main", "dev", "feature", "renovate/x"] } };
  const resolve = (env) => exec(branches, { REPOSITORY: "catenahq/sib", ...env }, RESOLVE);
  const ref = (env) => {
    const r = resolve(env);
    assert.equal(r.status, 0, r.out);
    return r.stdout.trim();
  };
  assert.equal(ref({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "dev" }), "dev");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "renovate/x" }), "");
  assert.equal(ref({ EVENT: "pull_request", HEAD_REF: "feature", BASE_REF: "dev" }), "feature");
  assert.equal(ref({ EVENT: "pull_request", HEAD_REF: "nope", BASE_REF: "dev" }), "dev");
  assert.equal(ref({ EVENT: "pull_request", HEAD_REF: "scanctl/y", BASE_REF: "main" }), "main");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "tag", REF_NAME: "v1.0.0" }), "");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "tag", REF_NAME: "v1.0.0", BRANCH: "main" }), "main");
  assert.equal(ref({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "dev", BRANCH: "main" }), "main");
  got = resolve({ EVENT: "push", REF_TYPE: "branch", REF_NAME: "dev", TOKEN: "s3cr3t-token" });
  assert.ok(got.calls.includes("refs/heads/dev [auth s3cr3t-token]"), got.calls);
  got = exec({ gitFail: true }, { REPOSITORY: "catenahq/sib", EVENT: "push", REF_TYPE: "branch", REF_NAME: "dev" }, RESOLVE);
  assert.notEqual(got.status, 0, "an unreadable sibling fails");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("same-tree: ok");
