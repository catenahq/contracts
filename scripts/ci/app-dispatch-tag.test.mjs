// app-dispatch.sh and app-tag.sh over scratch git repositories with stubs on
// PATH: gh answers `gh api <path>` from a JSON state file and logs each write
// with the token it used; uv answers each tool command from the state and logs
// it; sleep logs its wait. git and jq are the real ones. Run with
// `node scripts/ci/app-dispatch-tag.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fails, ok } from "./run-result.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(HERE, "app-dispatch.sh");
const TAG = join(HERE, "app-tag.sh");
const PULL = JSON.parse(readFileSync(join(HERE, "fixtures", "update", "pull.json"), "utf-8"));
const [MERGED_PULL] = JSON.parse(readFileSync(join(HERE, "fixtures", "update", "commit-pulls.json"), "utf-8"));

const work = mkdtempSync(join(tmpdir(), "catena-app-dispatch-tag-test-"));
const bin = join(work, "bin");
const tools = join(work, "tools");
mkdirSync(bin);
mkdirSync(tools);

const STUB_HEAD = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const args = process.argv.slice(2);
const log = (line) => fs.appendFileSync(process.env.STUB_LOG, line + "\\n");
`;
// gh api <path> [--paginate]: state.get[path], else a 404; a path of
// state.failGet answers an error. gh api -X <method> <path> -f|-F k=v...: the
// write, appended as a JSON line to STUB_WRITES with GH_TOKEN; it fails while
// state.fail[path] is above the writes of the path so far, else prints
// state.answer[path].
const GH = `${STUB_HEAD}
if (args[0] !== "api") process.exit(2);
const method = args[1] === "-X" ? args[2] : "GET";
const rest = method === "GET" ? args.slice(1) : args.slice(3);
const target = rest[0];
if (method === "GET") {
  if ((state.failGet || []).includes(target)) { console.error("gh: HTTP 500"); process.exit(1); }
  if (!(target in state.get)) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
  console.log(JSON.stringify(state.get[target]));
  process.exit(0);
}
const write = { method, path: target, token: process.env.GH_TOKEN };
for (let i = 1; i < rest.length; i += 2) {
  if (rest[i] !== "-f" && rest[i] !== "-F") process.exit(2);
  const [k, ...v] = rest[i + 1].split("=");
  write[k] = v.join("=");
}
const writes = fs.readFileSync(process.env.STUB_WRITES, "utf-8").split("\\n").filter(Boolean).map((l) => JSON.parse(l));
const failing = ((state.fail || {})[target] || 0) > writes.filter((w) => w.path === target).length;
fs.appendFileSync(process.env.STUB_WRITES, JSON.stringify({ ...write, failed: failing }) + "\\n");
if (failing) { console.error("gh: Reference already exists (HTTP 422)"); process.exit(1); }
console.log(JSON.stringify((state.answer || {})[target] || {}));
`;
// uv run <script> <command> [<args>]: state.uv["<script file> <command> <args>"],
// else state.uv["<script file> <command>"], else no output and status 0. The
// log names the paths piped to scope and changed, the directory and the tree
// the tools read.
const UV = `${STUB_HEAD}
const [, script, ...rest] = args;
const key = [path.basename(script), ...rest].join(" ");
const piped = ["scope", "changed"].includes(rest[0]) ? " < " + fs.readFileSync(0, "utf-8").trim().split("\\n").join(",") : "";
log("uv " + key + piped + " cwd=" + process.cwd() + " root=" + process.env.TEMPLATES_ROOT);
const answer = state.uv[key] ?? state.uv[key.split(" ").slice(0, 2).join(" ")] ?? {};
process.stdout.write(answer.out ?? "");
process.stderr.write(answer.err ?? "");
process.exit(answer.status ?? 0);
`;
const SLEEP = `${STUB_HEAD}
log("sleep " + args.join(" "));
`;
for (const [name, text] of [["gh", GH], ["uv", UV], ["sleep", SLEEP]]) {
  writeFileSync(join(bin, name), text);
  chmodSync(join(bin, name), 0o755);
}

const GIT_ENV = {
  HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const commit = (dir, files, message) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
};

const OPS_SHA = "1".repeat(40);
const CONTRACTS_SHA = "2".repeat(40);
const LOCK = `# siblings\ncatenahq/ops ${OPS_SHA} # main\ncatenahq/contracts ${CONTRACTS_SHA} # main\n`;

// origin: main at c0 with the app web and a hand-made tag; the pull request
// branch web-update (c1, then its head c2) squash-merged into main as m; the
// branch no-lock (c3, a head whose lock has no ops line) and docs (c4, a
// change of no app). It serves any commit by its id, as GitHub does.
const origin = join(work, "origin");
mkdirSync(origin);
git(origin, "init", "-q", "-b", "main");
git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
const c0 = commit(origin, {
  "blueprints/web/docker-compose.yml": "services: {}\n", "blueprints/web/app.json": "{}\n", ".github/catenahq.lock": LOCK, "README.md": "x\n",
}, "web");
git(origin, "tag", "-a", "web/1.0-1", "-m", "made by hand");
git(origin, "checkout", "-q", "-b", "web-update");
const c1 = commit(origin, { "blueprints/web/app.json": '{"a": 1}\n' }, "web: a");
const c2 = commit(origin, { "blueprints/web/app.json": '{"a": 2}\n' }, "web: b");
git(origin, "checkout", "-q", "-b", "no-lock");
const c3 = commit(origin, { ".github/catenahq.lock": `catenahq/contracts ${CONTRACTS_SHA} # main\n` }, "lock");
git(origin, "checkout", "-q", "-b", "docs", "main");
const c4 = commit(origin, { "README.md": "y\n" }, "docs");
git(origin, "checkout", "-q", "main");
git(origin, "merge", "-q", "--squash", "web-update");
git(origin, "commit", "-q", "-m", "web: a and b (#7)");
const m = git(origin, "rev-parse", "HEAD");

const REPO = "catenahq/demo";
const APP_BOT = "catena-ci[bot]";
const RUN = "https://github.com/catenahq/ops/actions/runs/4048";
const EARLIER_RUN = "https://github.com/catenahq/ops/actions/runs/4000";
const statuses = (sha, ...list) => ({ [`repos/${REPO}/commits/${sha}/statuses?per_page=100`]: list });
const appTests = (state, description, { creator = APP_BOT, url = RUN } = {}) =>
  ({ context: "app-tests", state, description, creator: { login: creator }, target_url: url });

let n = 0;
function exec(script, { root, get = {}, uv = {}, env = {}, ...state }) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  const files = { STUB_STATE: join(dir, "state.json"), STUB_LOG: join(dir, "calls.log"), STUB_WRITES: join(dir, "writes") };
  writeFileSync(files.STUB_STATE, JSON.stringify({ get, uv, ...state }));
  writeFileSync(files.STUB_LOG, "");
  writeFileSync(files.STUB_WRITES, "");
  const r = spawnSync("bash", [script], {
    cwd: work,
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`, ...GIT_ENV, ...files, REPO, TOOLS: tools, TEMPLATES_ROOT: root,
      APP_SLUG: "catena-ci", GH_TOKEN: "read", OPS_TOKEN: "ops", TAG_TOKEN: "tag",
      GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: REPO, GITHUB_RUN_ID: "99", ...env,
    },
  });
  const lines = (f) => readFileSync(f, "utf-8").split("\n").filter(Boolean);
  return { status: r.status, out: r.stdout, err: r.stderr, log: lines(files.STUB_LOG), writes: lines(files.STUB_WRITES).map((l) => JSON.parse(l)) };
}

try {
  // dispatch: the pull request head checked out with its history.
  const pr = join(work, "pr");
  git(work, "clone", "-q", "--no-local", origin, pr);
  const dispatch = (head, { get = {}, uv = {}, ...rest } = {}) => {
    git(pr, "checkout", "-q", "--detach", head);
    return exec(DISPATCH, {
      root: pr,
      env: { PR: "7", SHA: head, OWN_IMAGES: "ghcr.io/catenahq/a  ghcr.io/catenahq/b" },
      get: {
        [`repos/${REPO}/pulls/7`]: { ...PULL, number: 7, head: { sha: head, ref: "web-update", repo: { full_name: REPO } }, base: { ref: "main" } },
        [`repos/${REPO}/pulls/7/commits?per_page=100`]: [{ sha: c1 }, { sha: head }],
        ...statuses(head),
        ...statuses(c1),
        ...get,
      },
      uv: { "app_check.py changed": { out: "web\n" }, "versions.py same": { status: 1 }, ...uv },
      ...rest,
    });
  };
  const payload = (fields) => ({
    method: "POST", path: "repos/catenahq/ops/dispatches", token: "ops", failed: false, event_type: "app-test",
    "client_payload[sha]": c2, "client_payload[base]": c0, "client_payload[ids]": "web", "client_payload[ref]": "web-update",
    "client_payload[repo]": "demo", "client_payload[carry]": "", "client_payload[carry_state]": "",
    "client_payload[own_images]": "ghcr.io/catenahq/a,ghcr.io/catenahq/b",
    "client_payload[ops_sha]": OPS_SHA, "client_payload[contracts_sha]": CONTRACTS_SHA, "client_payload[pr]": "7",
    ...fields,
  });

  // The payload: the change from where the head left main, the lock's commits,
  // the pull request; an earlier commit of the App's pass for the same change
  // is carried, and the tools run in their own tree on the head as data.
  {
    const r = ok(dispatch(c2, {
      get: statuses(c1, appTests("success", "passed 1 app(s): web (the same change as run 3900)", { url: EARLIER_RUN })),
      uv: { [`versions.py same web --ref ${c2} --base ${c0} --from ${c1}`]: {} },
    }), "carry");
    assert.deepEqual(r.writes, [payload({ "client_payload[carry]": EARLIER_RUN, "client_payload[carry_state]": "success" })]);
    const paths = "blueprints/web/app.json";
    assert.deepEqual(r.log, [
      `uv versions.py scope < ${paths} cwd=${tools} root=${pr}`,
      `uv app_check.py changed < ${paths} cwd=${tools} root=${pr}`,
      `uv versions.py same web --ref ${c2} --base ${c0} --from ${c1} cwd=${tools} root=${pr}`,
    ]);
    assert.ok(r.out.includes(`carries the success of ${c1} (${EARLIER_RUN})`), r.out);
  }

  // Nothing to carry: a verdict of another creator, a failure naming another
  // app, a pass the tools do not judge the same change, and no tagged run.
  for (const [label, found] of [
    ["another creator", appTests("success", "passed 1 app(s): web", { creator: "github-actions[bot]" })],
    ["another app", appTests("failure", "failed: webmail")],
    ["not an ops run", appTests("success", "passed 1 app(s): web", { url: "https://example.com/runs/1" })],
    ["not the same change", appTests("success", "passed 1 app(s): web")],
  ]) {
    const r = ok(dispatch(c2, { get: statuses(c1, found) }), label);
    assert.deepEqual(r.writes, [payload({})], label);
    assert.ok(r.out.includes(`${c2}: runs`), `${label}\n${r.out}`);
  }

  // The head's own failure is carried; the run of the app's newest tag is
  // carried as a success.
  {
    let r = ok(dispatch(c2, {
      get: statuses(c2, appTests("failure", "failed: web (update_oldest)")),
      uv: { [`versions.py same web --ref ${c2} --base ${c0} --from ${c2}`]: {} },
    }), "head failure");
    assert.deepEqual(r.writes, [payload({ "client_payload[carry]": RUN, "client_payload[carry_state]": "failure" })]);
    r = ok(dispatch(c2, { uv: { "versions.py tested-run": { out: `${RUN}\n` } } }), "tag run");
    assert.deepEqual(r.writes, [payload({ "client_payload[carry]": RUN, "client_payload[carry_state]": "success" })]);
  }

  // No app changed: app-tests success with the run's address, nothing sent.
  {
    const r = ok(dispatch(c4, { uv: { "app_check.py changed": { out: "" } } }), "no app");
    assert.deepEqual(r.writes, [{
      method: "POST", path: `repos/${REPO}/statuses/${c4}`, token: "read", failed: false, context: "app-tests", state: "success",
      description: "no app changed", target_url: `https://github.com/${REPO}/actions/runs/99`,
    }]);
  }

  // A lock with no ops line fails before the send.
  {
    const r = fails(dispatch(c3), "no ops line", `.github/catenahq.lock at ${c3} has no line for catenahq/ops`);
    assert.deepEqual(r.writes, []);
  }

  // A head that moved on, or a closed pull request, is left to the newer run.
  {
    const moved = { [`repos/${REPO}/pulls/7`]: { ...PULL, number: 7, head: { sha: c1, ref: "web-update", repo: { full_name: REPO } }, base: { ref: "main" } } };
    const r = ok(dispatch(c2, { get: moved }), "moved");
    assert.deepEqual(r.writes, []);
    assert.deepEqual(r.log, []);
  }

  // A change of two apps, an id outside the slug form, a fork's head and a
  // failed status read fail with nothing sent: a failed read is never "no verdict".
  {
    let r = fails(dispatch(c2, { uv: { "versions.py scope": { status: 1, err: "the change touches 2 apps (blog, web)\n" } } }), "two apps", "touches 2 apps");
    assert.deepEqual(r.writes, []);
    r = fails(dispatch(c2, { uv: { "app_check.py changed": { out: "Web\n" } } }), "bad id", "'Web' is not a plain app id");
    assert.deepEqual(r.writes, []);
    const fork = { [`repos/${REPO}/pulls/7`]: { ...PULL, number: 7, head: { sha: c2, ref: "x", repo: { full_name: "someone/demo" } }, base: { ref: "main" } } };
    r = fails(dispatch(c2, { get: fork }), "fork", "#7 comes from someone/demo");
    assert.deepEqual(r.writes, []);
    r = fails(dispatch(c2, { failGet: [`repos/${REPO}/commits/${c1}/statuses?per_page=100`] }), "failed read");
    assert.deepEqual(r.writes, []);
  }

  // tag: the pushed main commit m, cloned without the pull request's branch, so
  // its head c2 is fetched by id.
  const caller = join(work, "caller");
  git(work, "clone", "-q", "--no-local", "--single-branch", "--branch", "main", origin, caller);
  const PASS = "passed 1 app(s): web (the same change as run 4000)";
  const SAME = `versions.py same web --ref ${m} --base ${c0} --from ${c2}`;
  const tag = ({ get = {}, uv = {}, ...rest } = {}) =>
    exec(TAG, {
      root: caller,
      env: { SHA: m },
      get: { [`repos/${REPO}/commits/${m}/pulls`]: [{ ...MERGED_PULL, number: 7, head: { sha: c2 }, merge_commit_sha: m }], ...statuses(c2, appTests("success", PASS)), ...get },
      uv: { [SAME]: {}, "versions.py same": { status: 1 }, ...uv },
      answer: { [`repos/${REPO}/git/tags`]: { sha: "f".repeat(40) } },
      ...rest,
    });
  const tagObject = (message, object = m, tagName = "web/1.0-2") =>
    ({ method: "POST", path: `repos/${REPO}/git/tags`, token: "tag", failed: false, tag: tagName, message, object, type: "commit" });
  const ref = (failed = false) => ({ method: "POST", path: `repos/${REPO}/git/refs`, token: "tag", failed, ref: "refs/tags/web/1.0-2", sha: "f".repeat(40) });
  const annotation = `app-tests passed at ${c2}: ${RUN}`;

  // create: an annotated tag on the merged commit naming the tested head and its run.
  {
    assert.throws(() => git(caller, "cat-file", "-e", `${c2}^{commit}`));
    const r = ok(tag({ uv: { "versions.py plan": { out: "create web/1.0-2\n" } } }), "create");
    assert.deepEqual(r.writes, [tagObject(annotation), ref()]);
    assert.deepEqual(r.log, [
      `uv ${SAME} cwd=${tools} root=${caller}`,
      `uv versions.py plan web --ref ${m} cwd=${tools} root=${caller}`,
    ]);
    assert.ok(r.out.includes("web: tagged web/1.0-2"), r.out);
    git(caller, "cat-file", "-e", `${c2}^{commit}`);
  }

  // create FROM, mark and skip.
  {
    let r = ok(tag({ uv: { "versions.py plan": { out: "create web/1.0-2 web/1.0-1\n" } } }), "create from");
    const from = `${annotation}\n\nRuntime and tests as web/1.0-1; this revision changes the presentation alone.`;
    assert.deepEqual(r.writes, [tagObject(from), ref()]);
    r = ok(tag({ uv: { "versions.py plan": { out: "mark web/1.0-1\n" } } }), "mark");
    assert.deepEqual(r.writes, [
      tagObject(annotation, c0, "web/1.0-1"),
      { method: "PATCH", path: `repos/${REPO}/git/refs/tags/web/1.0-1`, token: "tag", failed: false, sha: "f".repeat(40), force: "true" },
    ]);
    r = ok(tag({ uv: { "versions.py plan": { out: "skip web/1.0-1\n" } } }), "skip");
    assert.deepEqual(r.writes, []);
    assert.ok(r.out.includes("web: keeps web/1.0-1"), r.out);
  }

  // A tag another run made first: the tags are read again and the app planned once more.
  {
    const r = ok(tag({ uv: { "versions.py plan": { out: "create web/1.0-2\n" } }, fail: { [`repos/${REPO}/git/refs`]: 1 } }), "retry");
    assert.deepEqual(r.writes, [tagObject(annotation), ref(true), tagObject(annotation), ref()]);
    assert.equal(r.log.filter((l) => l.startsWith("uv versions.py plan")).length, 2);
  }

  // Nothing is tagged: no pull request merged as the commit (asked again after
  // a wait), and a merged change of no app.
  {
    let r = ok(tag({ get: { [`repos/${REPO}/commits/${m}/pulls`]: [{ ...MERGED_PULL, merge_commit_sha: c0 }] } }), "no pull request");
    assert.deepEqual(r.writes, []);
    assert.deepEqual(r.log, ["sleep 10"]);
    r = ok(tag({ get: statuses(c2, appTests("success", "no app changed", { creator: "github-actions[bot]", url: "" })) }), "no app");
    assert.deepEqual(r.writes, []);
    assert.deepEqual(r.log, []);
  }

  // Refused, with nothing written: no success, a success of another creator, a
  // merge whose app differs from the tested head, an unreadable status.
  for (const [label, args, message] of [
    ["pending", { get: statuses(c2, appTests("pending", "running")) }, `${c2} has no app-tests success (pending)`],
    ["forged", { get: statuses(c2, appTests("success", PASS, { creator: "github-actions[bot]" })) }, "is github-actions[bot]'s"],
    ["not the same", { uv: { [SAME]: { status: 1 } } }, `web at ${m} is not the change the app tests passed at ${c2}`],
    ["failed read", { failGet: [`repos/${REPO}/commits/${c2}/statuses?per_page=100`] }, ""],
  ]) {
    const r = fails(tag(args), label, message);
    assert.deepEqual(r.writes, [], label);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("app-dispatch-tag: ok");
