#!/usr/bin/env node
// Per-check reuse of the shared PR workflow (.github/workflows/pr.yml): each
// matrix entry, and the scan, has a key; a check that passed records its key
// as an artifact, and a later run drops every entry whose key has a record
// (README.md, "Per-check reuse").
//
//   node reuse.mjs plan --matrix <checks-matrix.mjs output> --repo <owner/name>
//   node reuse.mjs record --entry <matrix entry JSON>
//   node reuse.mjs record --scan <scan settings JSON>
//
// Both run in the caller's checkout (ws/<repo>) and write GITHUB_OUTPUT. plan
// looks the records up with gh (GH_TOKEN) and resolves each sibling's commit
// as checkout-sibling does (SIBLING_TOKEN); record reads the siblings' commits
// from their checkouts beside the caller. Exit 1 on a GitHub API or git error,
// which is never read as "no record", and 2 on bad arguments.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RESOLVE = join(dirname(fileURLToPath(import.meta.url)), "../../.github/actions/checkout-sibling/resolve.sh");
const OWNER = "catenahq";
// The caller's workflow file and the id of its job that calls pr.yml.
const CALLER_WORKFLOW = ".github/workflows/ci.yml";
const CALLER_JOB = "ci";
// The events whose runs' records count. A pull request or push run also looks
// records up; a schedule run never does: plan skips the lookup on it.
const SOURCE_EVENTS = ["pull_request", "push", "schedule"];
// Files every check reads besides its inputs.
const KEY_PATHS = [".github/checks.yml", ".github/catenahq.lock", "ci/run"];
const SHA = /^[0-9a-f]{40}$/;

export class LookupError extends Error {}
class UsageError extends Error {}

function exec(cmd, args, { env = process.env, cwd } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", env, cwd, maxBuffer: 1 << 28 });
  if (r.error || r.status !== 0) {
    throw new LookupError(`${cmd} ${args.slice(0, 2).join(" ")} failed: ${(r.error?.message ?? r.stderr).trim()}`);
  }
  return r.stdout;
}

const gh = (path) => JSON.parse(exec("gh", ["api", path]));

// git with the token as the GitHub authorization header, carried in the
// environment, never on a command line.
function authEnv(token) {
  if (!token) return process.env;
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
  };
}

// The value with every object's keys sorted, so equal entries print the same.
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

// What a key is computed over: a check entry of the matrix, or the scan,
// which reads the whole tree and also the day's vulnerability feed.
export function specOf({ entry, scan }) {
  if (scan !== undefined) return { name: "scan", entry: scan, inputs: ["."], dated: true, jobs: [`${CALLER_JOB} / scan`] };
  if (typeof entry?.name !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(entry.name)) throw new UsageError("an entry needs a check name");
  if (!Array.isArray(entry.inputs) || entry.inputs.length === 0) throw new UsageError(`entry ${entry.name} has no inputs`);
  return { name: entry.name, entry, inputs: entry.inputs, dated: false, jobs: [`${CALLER_JOB} / check (${entry.name})`] };
}

// The siblings an entry checks out, sorted.
export const siblingsOf = (spec) =>
  Object.keys(spec.entry.sib ?? {}).filter((s) => spec.entry.sib[s] !== "").sort();

// The key text: one line per fact the result depends on.
export function keyText({ spec, tree, sibs, workflowSha, date }) {
  const lines = [`entry=${JSON.stringify(sortKeys(spec.entry))}`, `tree=${tree}`];
  for (const [repo, sha] of sibs) lines.push(`sib:${repo}=${sha}`);
  lines.push(`workflow=${workflowSha}`);
  if (spec.dated) lines.push(`date=${date}`);
  return lines.map((l) => `${l}\n`).join("");
}

export const recordName = (name, key) => `ci-check.${name}.${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

export const utcDate = (now = new Date()) => now.toISOString().slice(0, 10);

// The checkout of the caller: trees of its commits, limited to a spec's paths.
class Checkout {
  constructor(dir, token) {
    this.dir = dir;
    this.token = token;
    this.empty = null;
  }

  git(args, env) {
    return exec("git", ["-C", this.dir, ...args], { env });
  }

  // Every file under the spec's inputs and KEY_PATHS at the commit, with its
  // mode and blob. diff-tree against the empty tree reads git pathspecs,
  // globs included, which ls-tree does not.
  tree(commit, spec) {
    this.empty ??= this.git(["hash-object", "-t", "tree", "/dev/null"]).trim();
    return this.git(["diff-tree", "-r", "--no-renames", this.empty, commit, "--", ...spec.inputs, ...KEY_PATHS]).trimEnd();
  }

  has(sha) {
    return spawnSync("git", ["-C", this.dir, "cat-file", "-e", `${sha}^{commit}`]).status === 0;
  }

  // The tree at a commit of this repository, fetched by sha when the checkout
  // lacks it.
  treeAt(sha, spec) {
    if (!this.has(sha)) this.git(["fetch", "--quiet", "--depth=1", "--no-tags", "origin", sha], authEnv(this.token));
    return this.tree(sha, spec);
  }
}

// The commit checkout-sibling checks each sibling out at: resolve.sh's ref
// (the same-named branch, else the lock's commit), a branch read with
// ls-remote.
function siblingResolver(env, lock) {
  const cache = new Map();
  return (name) => {
    if (cache.has(name)) return cache.get(name);
    const repo = `${OWNER}/${name}`;
    const r = spawnSync("bash", [RESOLVE], {
      encoding: "utf-8",
      env: {
        ...env,
        REPOSITORY: repo,
        TOKEN: env.SIBLING_TOKEN ?? "",
        BRANCH: "",
        LOCK: lock,
        TIP: "false",
        EVENT: env.GITHUB_EVENT_NAME ?? "",
        HEAD_REF: env.GITHUB_HEAD_REF ?? "",
        BASE_REF: env.GITHUB_BASE_REF ?? "",
        REF_NAME: env.GITHUB_REF_NAME ?? "",
        REF_TYPE: env.GITHUB_REF_TYPE ?? "",
        DEFAULT_BRANCH: env.DEFAULT_BRANCH ?? "",
      },
    });
    if (r.error || r.status !== 0) throw new LookupError(`resolve.sh ${repo} failed: ${(r.error?.message ?? r.stderr).trim()}`);
    process.stderr.write(r.stderr);
    const ref = r.stdout.trim();
    let sha = ref;
    if (!SHA.test(ref)) {
      if (ref === "") throw new LookupError(`resolve.sh gave no ref for ${repo}`);
      const out = exec("git", ["ls-remote", "--heads", `https://github.com/${repo}.git`, `refs/heads/${ref}`], { env: authEnv(env.SIBLING_TOKEN) });
      sha = out.split(/\s/)[0];
      if (!SHA.test(sha)) throw new LookupError(`${repo} has no branch ${ref}`);
    }
    cache.set(name, sha);
    return sha;
  };
}

// The URL of the first run, newest first, whose record of the name counts:
// not expired; of this repository and not a fork; not this run; the caller's
// workflow, from a source event, calling pr.yml at this commit; the spec's job
// concluded success; and its head commit has our tree. Any run of the
// repository can upload an artifact of any name, so the record alone proves
// nothing. null when none counts.
function findSource(ctx, spec, name, tree) {
  const { artifacts = [] } = gh(`repos/${ctx.repo}/actions/artifacts?name=${name}&per_page=100`);
  const newest = [...artifacts].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  for (const a of newest) {
    const wr = a.workflow_run ?? {};
    if (a.name !== name || a.expired !== false) continue;
    if (String(wr.repository_id) !== ctx.repoId || String(wr.head_repository_id) !== ctx.repoId) continue;
    if (String(wr.id) === ctx.runId) continue;
    const run = ctx.run(wr.id);
    if (run.path !== CALLER_WORKFLOW || !SOURCE_EVENTS.includes(run.event)) continue;
    const prYml = `${ctx.workflowRepo}/.github/workflows/pr.yml@`;
    if (!(run.referenced_workflows ?? []).some((w) => w.path?.startsWith(prYml) && w.sha === ctx.workflowSha)) continue;
    if (!SHA.test(run.head_sha ?? "")) continue;
    if (!ctx.jobs(wr.id).some((j) => spec.jobs.includes(j.name) && j.conclusion === "success")) continue;
    if (ctx.checkout.treeAt(run.head_sha, spec) !== tree) continue;
    return run.html_url;
  }
  return null;
}

function memo(fn) {
  const cache = new Map();
  return (k) => {
    if (!cache.has(k)) cache.set(k, fn(k));
    return cache.get(k);
  };
}

function output(env, values) {
  const text = Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join("");
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

function workflowSha(env) {
  const sha = env.WORKFLOW_SHA ?? "";
  if (!SHA.test(sha)) throw new UsageError("WORKFLOW_SHA must be the 40-hex commit of pr.yml (job.workflow_sha)");
  return sha;
}

export function plan({ matrix, repo }, env = process.env, cwd = process.cwd()) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new UsageError("--repo needs owner/name");
  let parsed;
  try {
    parsed = JSON.parse(matrix ?? "");
  } catch {
    throw new UsageError("--matrix needs the JSON checks-matrix.mjs prints");
  }
  const { include, scan } = parsed;
  if (!Array.isArray(include) || scan === null || typeof scan !== "object") throw new UsageError("--matrix needs include and scan");
  const specs = include.map((entry) => specOf({ entry }));
  if (scan.enabled === true) specs.push(specOf({ scan }));
  const reused = new Set();
  if (env.GITHUB_EVENT_NAME === "schedule") {
    console.log("a scheduled run runs every check: no lookup");
  } else {
    const ctx = {
      repo,
      repoId: env.GITHUB_REPOSITORY_ID ?? "",
      runId: env.GITHUB_RUN_ID ?? "",
      workflowRepo: env.WORKFLOW_REPOSITORY ?? "",
      workflowSha: workflowSha(env),
      checkout: new Checkout(cwd, env.GH_TOKEN),
      run: memo((id) => gh(`repos/${repo}/actions/runs/${id}`)),
      jobs: memo((id) => gh(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`).jobs ?? []),
    };
    if (!/^\d+$/.test(ctx.repoId) || !/^\d+$/.test(ctx.runId)) throw new UsageError("GITHUB_REPOSITORY_ID and GITHUB_RUN_ID must be numbers");
    if (!/^[\w.-]+\/[\w.-]+$/.test(ctx.workflowRepo)) throw new UsageError("WORKFLOW_REPOSITORY must be owner/name (job.workflow_repository)");
    const sibling = siblingResolver(env, resolve(cwd, ".github/catenahq.lock"));
    const date = utcDate();
    for (const spec of specs) {
      const tree = ctx.checkout.tree("HEAD", spec);
      const sibs = siblingsOf(spec).map((s) => [s, sibling(s)]);
      const name = recordName(spec.name, keyText({ spec, tree, sibs, workflowSha: ctx.workflowSha, date }));
      const url = findSource(ctx, spec, name, tree);
      if (url === null) {
        console.log(`${spec.name}: no record (${name})`);
        continue;
      }
      reused.add(spec.name);
      console.log(`::notice::reused ${spec.name} from ${url}`);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `reused ${spec.name} from ${url}\n`);
    }
  }
  const left = include.filter((e) => !reused.has(e.name));
  const bundles = [...new Set(left.flatMap((e) => Object.keys(e.sib ?? {}).filter((s) => e.sib[s] === "bundle")))].sort();
  const result = {
    matrix: JSON.stringify({ include: left }),
    run: String(left.length > 0),
    bundles: JSON.stringify(bundles),
    "scan-reused": String(reused.has("scan")),
  };
  output(env, result);
  return result;
}

// The record of a spec's key, from the commits checked out: the caller at the
// merge commit and each sibling beside it. On a pull request the key is
// recorded only when the merge commit's inputs equal those of the pull
// request head (HEAD^2), the commit a later lookup compares.
export function record(args, env = process.env, cwd = process.cwd()) {
  const spec = specOf(args);
  const sha = workflowSha(env);
  const checkout = new Checkout(cwd);
  const tree = checkout.tree("HEAD", spec);
  const sibs = siblingsOf(spec).map((s) => [s, exec("git", ["-C", join(cwd, "..", s), "rev-parse", "HEAD"]).trim()]);
  const key = keyText({ spec, tree, sibs, workflowSha: sha, date: utcDate() });
  const name = recordName(spec.name, key);
  const keep = env.GITHUB_EVENT_NAME !== "pull_request" || checkout.tree("HEAD^2", spec) === tree;
  const dir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "ci-check-"));
  const path = join(dir, "key.txt");
  writeFileSync(path, key);
  console.log(keep ? `record ${name}` : `no record: the inputs of ${spec.name} differ between the merge commit and the pull request head`);
  const result = { name, path, record: String(keep) };
  output(env, result);
  return result;
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (!["--matrix", "--repo", "--entry", "--scan"].includes(flag) || rest[i + 1] === undefined) throw new UsageError(`unknown argument '${flag}'`);
    opts[flag.slice(2)] = rest[i + 1];
  }
  if (mode === "plan") {
    if (opts.entry !== undefined || opts.scan !== undefined) throw new UsageError("plan takes --matrix and --repo");
    return { mode, opts };
  }
  if (mode === "record") {
    if (opts.matrix !== undefined || opts.repo !== undefined || (opts.entry === undefined) === (opts.scan === undefined)) {
      throw new UsageError("record takes --entry or --scan");
    }
    const which = opts.entry !== undefined ? "entry" : "scan";
    try {
      return { mode, opts: { [which]: JSON.parse(opts[which]) } };
    } catch {
      throw new UsageError(`--${which} needs JSON`);
    }
  }
  throw new UsageError("the mode is plan or record");
}

function main() {
  try {
    const { mode, opts } = parseArgs(process.argv.slice(2));
    if (mode === "plan") plan(opts);
    else record(opts);
  } catch (e) {
    console.error(`::error::reuse: ${e.message}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
