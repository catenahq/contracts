// Computes and posts the commit status `ci / gate` of a pull request head.
//
//   node gate-status.mjs --repo <owner/name> --pr <n> --sha <head sha>
//                        [--app-tests | --apps-from <sha> --expect-apps <true|false>] [--gate-job]
//                        [--pend-unreadable]
//
// GH_TOKEN authenticates gh, and GH_READ_TOKEN, when set, reads the
// dependencies. The status is success only once the `ci / gate` check run
// GitHub Actions made on the sha completed with success; --gate-job skips that
// read, for the gate job itself, the run being judged, and posts pending
// "waiting for the control run" for a dependency it cannot read.
// --pend-unreadable posts that pending too and still reads the check run, for
// the app-tests verdict of ops, whose token may not read a dependency's
// repository. The pull request body names its dependencies, one per line, as
// `Depends-on: catenahq/<repo>#<n>`; the status is pending until each named
// pull request is merged, and failure when one names a repository CI does not
// know. With --app-tests the newest `app-tests` status of the
// sha must also be success; --apps-from asks for it when the repository's
// .github/checks.yml at that commit declares apps, and --expect-apps, the
// caller's own setting, must agree. The whole state is recomputed on every
// call, so the newest post is right. Exit 1 on a GitHub API error or a
// disagreement, 2 on bad arguments.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { declaresApps } from "./checks-matrix.mjs";

export const CONTEXT = "ci / gate";
export const MAX_DESCRIPTION = 140;
const DEPENDS_LINE = /^Depends-on:/;
const DEPENDS = /^Depends-on: (catenahq\/[A-Za-z0-9._-]+)#([1-9][0-9]*)$/;
const SHA = /^[0-9a-f]{40}$/;
// Any App with checks write can create a check run of any name: only the one
// GitHub Actions made for the gate job counts.
const ACTIONS_APP = "github-actions";
export const POLICY_FILE = join(dirname(fileURLToPath(import.meta.url)), "workflow-policy.json");

export class ApiError extends Error {}

// A Depends-on pull request the read-only token gets a 404 for: the token
// covers its repository, so the pull request does not exist.
export class DependencyNotFound extends ApiError {
  constructor(dependency, message) {
    super(message);
    this.dependency = dependency;
  }
}

// The catenahq repositories CI knows, lowercased: the repository part of each
// ceiling key of workflow-policy.json.
export const knownRepos = () =>
  new Set(Object.keys(JSON.parse(readFileSync(POLICY_FILE, "utf-8")).permissions).map((key) => key.split(":")[0].toLowerCase()));

// The output of gh: a string, or a Buffer with encoding "buffer". token
// replaces GH_TOKEN.
export function gh(args, encoding = "utf-8", token = null) {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const r = spawnSync("gh", args, { encoding, env, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new ApiError(`gh ${args.slice(0, 2).join(" ")} failed: ${(r.error?.message ?? String(r.stderr)).trim()}`);
  }
  return r.stdout;
}

export const get = (path) => JSON.parse(gh(["api", path]));
// A read that can reach another repository: GH_READ_TOKEN, the read-only
// token of the repositories the pull requests name (read-scope.mjs), else
// GH_TOKEN.
export const readGet = (path) => JSON.parse(gh(["api", path], "utf-8", process.env.GH_READ_TOKEN || null));

// The dependencies of a pull request body, and the lines that look like one
// and are not.
export function parseDependsOn(body) {
  const deps = [];
  const malformed = [];
  for (const line of (body ?? "").split(/\r?\n/)) {
    if (!DEPENDS_LINE.test(line)) continue;
    const m = line.match(DEPENDS);
    if (m) deps.push({ repo: m[1], number: Number(m[2]) });
    else malformed.push(line);
  }
  return { deps, malformed };
}

// The verdict of the dependencies while one is not merged, else null: failure
// when one names a repository CI does not know, else pending with the reason
// of the first one not merged. With unreadable, a dependency that cannot be
// read is pending with that reason instead of an error: the gate job holds no
// token for other repositories. Without it, a 404 throws DependencyNotFound.
export function unmetDependency(deps, unreadable = null) {
  const known = knownRepos();
  const unknown = deps.find((d) => !known.has(d.repo.split("/")[1].toLowerCase()));
  if (unknown) return { state: "failure", description: `unknown repository: ${unknown.repo}#${unknown.number}` };
  for (const { repo, number } of deps) {
    const name = `${repo}#${number}`;
    let pr;
    try {
      pr = readGet(`repos/${repo}/pulls/${number}`);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (unreadable !== null) return { state: "pending", description: unreadable };
      if (e.message.includes("(HTTP 404)")) throw new DependencyNotFound(name, e.message);
      throw e;
    }
    if (pr.merged_at) continue;
    return { state: "pending", description: pr.state === "closed" ? `${name} closed without merging` : `waiting for ${name}` };
  }
  return null;
}

// The newest app-tests status of the sha: its state, or null when it has none.
export function appTestsState(repo, sha) {
  const combined = get(`repos/${repo}/commits/${sha}/status?per_page=100`);
  return (combined.statuses ?? []).find((s) => s.context === "app-tests")?.state ?? null;
}

// The newest `ci / gate` check run GitHub Actions made on the commit, or null.
export function gateRun(repo, sha) {
  const { check_runs: runs } = get(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CONTEXT)}&per_page=100`);
  return (
    runs
      .filter((r) => r.name === CONTEXT && r.app?.slug === ACTIONS_APP)
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0] ?? null
  );
}

// The checks' verdict on the sha: null once the gate check run passed,
// pending while it is missing or going, failure when it ended otherwise.
function checksState(repo, sha) {
  const run = gateRun(repo, sha);
  if (!run || run.status !== "completed") return { state: "pending", description: "waiting for checks" };
  if (run.conclusion !== "success") return { state: "failure", description: `${CONTEXT} check run ${run.conclusion}` };
  return null;
}

// Whether the repository runs app-tests at the ref: its .github/checks.yml,
// read as data, declares apps. A 404 is no checks.yml, so no app-tests; any
// other failed read fails.
export function repoDeclaresApps(repo, ref) {
  let file;
  try {
    file = get(`repos/${repo}/contents/.github/checks.yml?ref=${ref}`);
  } catch (e) {
    if (e instanceof ApiError && e.message.includes("(HTTP 404)")) return false;
    throw e;
  }
  if (file.encoding !== "base64") throw new ApiError(`${repo} .github/checks.yml at ${ref}: encoding '${file.encoding}', not base64`);
  try {
    return declaresApps(Buffer.from(file.content, "base64").toString("utf-8"));
  } catch (e) {
    throw new ApiError(`${repo} .github/checks.yml at ${ref} does not parse: ${e.message.split("\n")[0]}`);
  }
}

export function computeState({ repo, pr, sha, appTests, gateJob = false, pendUnreadable = false }, warn = () => {}) {
  const { deps, malformed } = parseDependsOn(get(`repos/${repo}/pulls/${pr}`).body);
  for (const line of malformed) warn(`ignoring malformed line '${line}': write Depends-on: catenahq/<repo>#<number>`);
  const tests = appTests ? appTestsState(repo, sha) : null;
  if (tests === "failure" || tests === "error") return { state: "failure", description: "app-tests failed" };
  const checks = gateJob ? null : checksState(repo, sha);
  if (checks?.state === "failure") return checks;
  const unmet = unmetDependency(deps, gateJob || pendUnreadable ? "waiting for the control run" : null);
  if (unmet) return unmet;
  if (checks) return checks;
  if (!appTests) return { state: "success", description: "no open dependency" };
  if (tests !== "success") return { state: "pending", description: "waiting for app-tests" };
  return { state: "success", description: "no open dependency, app-tests passed" };
}

export function post({ repo, sha }, { state, description, context = CONTEXT }, env = process.env) {
  const args = [
    "api", "-X", "POST", `repos/${repo}/statuses/${sha}`,
    "-f", `context=${context}`,
    "-f", `state=${state}`,
    "-f", `description=${description.slice(0, MAX_DESCRIPTION)}`,
  ];
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    args.push("-f", `target_url=${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
  }
  gh(args);
}

function parseArgs(argv) {
  const opts = { appTests: false, gateJob: false, pendUnreadable: false };
  const values = { "--repo": "repo", "--pr": "pr", "--sha": "sha", "--apps-from": "appsFrom", "--expect-apps": "expectApps" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--app-tests") opts.appTests = true;
    else if (a === "--gate-job") opts.gateJob = true;
    else if (a === "--pend-unreadable") opts.pendUnreadable = true;
    else if (Object.hasOwn(values, a)) opts[values[a]] = argv[++i];
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? "")) throw new Error("--repo needs owner/name");
  if (!/^[1-9][0-9]*$/.test(opts.pr ?? "")) throw new Error("--pr needs a pull request number");
  if (!SHA.test(opts.sha ?? "")) throw new Error("--sha needs a 40-hex commit");
  if (opts.appsFrom === undefined && opts.expectApps === undefined) return opts;
  if (opts.appTests) throw new Error("--app-tests and --apps-from exclude each other");
  if (!SHA.test(opts.appsFrom ?? "")) throw new Error("--apps-from needs a 40-hex commit");
  if (!["true", "false"].includes(opts.expectApps)) throw new Error("--apps-from needs --expect-apps true or false");
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`::error::gate-status: ${e.message}`);
    process.exit(2);
  }
  try {
    if (opts.appsFrom !== undefined) {
      opts.appTests = repoDeclaresApps(opts.repo, opts.appsFrom);
      if (String(opts.appTests) !== opts.expectApps) {
        const has = opts.appTests ? "has the key apps" : "has no key apps";
        const description = `apps is ${opts.expectApps} in ci-control.yml and .github/checks.yml at ${opts.appsFrom.slice(0, 7)} ${has}`;
        post(opts, { state: "failure", description });
        console.error(`::error::gate-status: ${description}: set apps: ${opts.appTests} in the job that calls control.yml`);
        process.exit(1);
      }
    }
    const result = computeState(opts, (m) => console.error(`::warning::gate-status: ${m}`));
    post(opts, result);
    console.log(`${CONTEXT}: ${result.state}: ${result.description.slice(0, MAX_DESCRIPTION)}`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    console.error(`::error::gate-status: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
