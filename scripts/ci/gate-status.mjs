// Computes and posts the commit status `ci / gate` of a pull request head.
//
//   node gate-status.mjs --repo <owner/name> --pr <n> --sha <head sha> [--app-tests]
//
// GH_TOKEN authenticates gh. The pull request body names its dependencies, one
// per line, as `Depends-on: catenahq/<repo>#<n>`; the status is pending until
// each named pull request is merged. With --app-tests the newest `app-tests`
// status of the sha must also be success. The whole state is recomputed on
// every call, so the newest post is right. Exit 1 on a GitHub API error, 2 on
// bad arguments.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CONTEXT = "ci / gate";
export const MAX_DESCRIPTION = 140;
const DEPENDS_LINE = /^Depends-on:/;
const DEPENDS = /^Depends-on: (catenahq\/[A-Za-z0-9._-]+)#([1-9][0-9]*)$/;

export class ApiError extends Error {}

export function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf-8" });
  if (r.error || r.status !== 0) {
    throw new ApiError(`gh ${args.slice(0, 2).join(" ")} failed: ${(r.error?.message ?? r.stderr).trim()}`);
  }
  return r.stdout;
}

export const get = (path) => JSON.parse(gh(["api", path]));

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

// pending with the reason of the first dependency not merged, else null.
export function unmetDependency(deps) {
  for (const { repo, number } of deps) {
    const pr = get(`repos/${repo}/pulls/${number}`);
    if (pr.merged_at) continue;
    const name = `${repo}#${number}`;
    return pr.state === "closed" ? `${name} closed without merging` : `waiting for ${name}`;
  }
  return null;
}

// The newest app-tests status of the sha: its state, or null when it has none.
export function appTestsState(repo, sha) {
  const combined = get(`repos/${repo}/commits/${sha}/status?per_page=100`);
  return (combined.statuses ?? []).find((s) => s.context === "app-tests")?.state ?? null;
}

export function computeState({ repo, pr, sha, appTests }, warn = () => {}) {
  const { deps, malformed } = parseDependsOn(get(`repos/${repo}/pulls/${pr}`).body);
  for (const line of malformed) warn(`ignoring malformed line '${line}': write Depends-on: catenahq/<repo>#<number>`);
  if (appTests) {
    const state = appTestsState(repo, sha);
    if (state === "failure" || state === "error") return { state: "failure", description: "app-tests failed" };
    const waiting = unmetDependency(deps);
    if (waiting) return { state: "pending", description: waiting };
    if (state !== "success") return { state: "pending", description: "waiting for app-tests" };
    return { state: "success", description: "no open dependency, app-tests passed" };
  }
  const waiting = unmetDependency(deps);
  return waiting ? { state: "pending", description: waiting } : { state: "success", description: "no open dependency" };
}

export function post({ repo, sha }, { state, description }, env = process.env) {
  const args = [
    "api", "-X", "POST", `repos/${repo}/statuses/${sha}`,
    "-f", `context=${CONTEXT}`,
    "-f", `state=${state}`,
    "-f", `description=${description.slice(0, MAX_DESCRIPTION)}`,
  ];
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
    args.push("-f", `target_url=${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
  }
  gh(args);
}

function parseArgs(argv) {
  const opts = { appTests: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--app-tests") opts.appTests = true;
    else if (a === "--repo" || a === "--pr" || a === "--sha") opts[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? "")) throw new Error("--repo needs owner/name");
  if (!/^[1-9][0-9]*$/.test(opts.pr ?? "")) throw new Error("--pr needs a pull request number");
  if (!/^[0-9a-f]{40}$/.test(opts.sha ?? "")) throw new Error("--sha needs a 40-hex commit");
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
