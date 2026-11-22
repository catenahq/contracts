// Brings the auto-merge pull requests of a repository up to date with their
// base one at a time, and recomputes the `ci / gate` status of the pull
// requests whose checks ended, and hourly of every open one.
//
//   node update.mjs --repo <owner/name> --event <name> [--sha <run head>] [--apps]
//
// GH_TOKEN, a token of this repository alone, authenticates gh. On every
// event, for each base of BASES: when a
// candidate (an open pull request with auto-merge on) that is not behind its
// base has its `ci / gate` check run queued or in progress, nothing is
// updated; otherwise the oldest candidate that is behind its base, whose head
// passed the `ci / gate` check run, with --apps whose `app-tests` status is
// success, and with no open Depends-on pull request, is updated with its base;
// a failed update, or a candidate that cannot be read, is reported and the
// next candidate is tried. On workflow_run without --apps, --sha is the run's
// head, and each open pull request of the repository with that head gets its
// `ci / gate` status recomputed; on schedule, each open pull request of the
// repository does, so a merged dependency reaches its dependents within the
// hour. A Depends-on pull request that does not exist skips its candidate and
// fails its status; a pull request whose status cannot be recomputed is
// reported and the next one recomputed. Exit 1 on a GitHub API error, a failed
// update or a failed read, once every pull request is done; 2 on bad
// arguments (README.md, "Control workflow").
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ApiError, CONTEXT, DependencyNotFound, appTestsState, computeState, gateRun, gh, parseDependsOn, post, unmetDependency,
} from "./gate-status.mjs";

export const BASES = ["main", "release"];
const EVENTS = ["push", "workflow_run", "schedule", "pull_request_target"];
const PR_FIELDS = "number,isDraft,autoMergeRequest,headRefOid,mergeStateStatus,createdAt,body";

const ghJSON = (args) => JSON.parse(gh(args));

function openPulls(repo, base) {
  const args = ["pr", "list", "--repo", repo, "--state", "open", "--json", PR_FIELDS, "--limit", "1000"];
  if (base) args.push("--base", base);
  return ghJSON(args);
}

// Why a candidate is not updated, or null when it is the one to update.
function skipReason(repo, pr, apps) {
  if (pr.isDraft) return "draft";
  if (pr.mergeStateStatus === "DIRTY") return "conflicts with its base (DIRTY)";
  if (pr.mergeStateStatus !== "BEHIND") return `not behind its base (${pr.mergeStateStatus})`;
  const run = gateRun(repo, pr.headRefOid);
  if (!run) return `no ${CONTEXT} check run`;
  if (run.status !== "completed") return `${CONTEXT} ${run.status}`;
  if (run.conclusion !== "success") return `${CONTEXT} ${run.conclusion}`;
  if (apps) {
    const state = appTestsState(repo, pr.headRefOid);
    if (state !== "success") return `app-tests ${state ?? "not reported"}`;
  }
  return unmetDependency(parseDependsOn(pr.body).deps)?.description ?? null;
}

// Updates the oldest ready candidate of the base with its base; its number,
// or null when none is updated. A candidate whose update fails goes to fail
// and the next one is tried.
export function updateBase(repo, base, apps, log, fail) {
  const candidates = openPulls(repo, base)
    .filter((pr) => pr.autoMergeRequest)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A candidate validated against the current base merges next; another one
  // updated now would fall behind again at that merge and run its checks twice.
  for (const pr of candidates) {
    if (pr.isDraft || pr.mergeStateStatus === "BEHIND" || pr.mergeStateStatus === "DIRTY") continue;
    const run = gateRun(repo, pr.headRefOid);
    if (run && run.status !== "completed") {
      log(`${base}: #${pr.number} is up to date and its ${CONTEXT} check run is ${run.status}: nothing updated`);
      return null;
    }
  }
  for (const pr of candidates) {
    let reason;
    try {
      reason = skipReason(repo, pr, apps);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e instanceof DependencyNotFound) {
        reason = `dependency not found: ${e.dependency}`;
      } else {
        fail(`${base}: #${pr.number} not judged: ${e.message}`);
        reason = "not judged";
      }
    }
    if (reason) {
      log(`${base}: skip #${pr.number}: ${reason}`);
      continue;
    }
    try {
      gh(["api", "-X", "PUT", `repos/${repo}/pulls/${pr.number}/update-branch`, "-f", `expected_head_sha=${pr.headRefOid}`]);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      fail(`${base}: #${pr.number} not updated: ${e.message}`);
      continue;
    }
    log(`${base}: updated #${pr.number} with its base`);
    return pr.number;
  }
  log(`${base}: no pull request to update`);
  return null;
}

// A Depends-on pull request that does not exist is failure.
function refresh(repo, number, sha, appTests, warn, log) {
  let result;
  try {
    result = computeState({ repo, pr: number, sha, appTests }, warn);
  } catch (e) {
    if (!(e instanceof DependencyNotFound)) throw e;
    result = { state: "failure", description: `dependency not found: ${e.dependency}` };
  }
  post({ repo, sha }, result);
  log(`${repo}#${number}: ${CONTEXT} ${result.state}: ${result.description}`);
}

// The open pull requests of the repository, all or those whose head is sha.
// All on schedule: a dependency merged since the last run, and a head whose
// run's recompute a newer updater run replaced. One that fails goes to fail
// and the next one is recomputed.
export function refreshOpen(repo, sha, apps, warn, log, fail) {
  for (const pr of openPulls(repo)) {
    if (sha !== null && pr.headRefOid !== sha) continue;
    try {
      refresh(repo, pr.number, pr.headRefOid, apps, warn, log);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      fail(`#${pr.number}: ${CONTEXT} not recomputed: ${e.message}`);
    }
  }
}

export function run({ repo, event, sha, apps }, warn, log, fail) {
  for (const base of BASES) updateBase(repo, base, apps, log, fail);
  // The status once the checks ended, for a pull request whose gate job posts
  // none (from a fork). With apps, dispatch posts it after the same run.
  if (event === "workflow_run" && !apps) refreshOpen(repo, sha, apps, warn, log, fail);
  if (event === "schedule") refreshOpen(repo, null, apps, warn, log, fail);
}

function parseArgs(argv) {
  const opts = { apps: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apps") opts.apps = true;
    else if (a === "--repo" || a === "--event" || a === "--sha") opts[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? "")) throw new Error("--repo needs owner/name");
  if (!EVENTS.includes(opts.event)) throw new Error(`--event needs one of ${EVENTS.join(", ")}`);
  if (opts.event === "workflow_run" && !/^[0-9a-f]{40}$/.test(opts.sha ?? "")) {
    throw new Error("--sha needs the 40-hex head of the workflow run");
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`::error::update: ${e.message}`);
    process.exit(2);
  }
  let failed = 0;
  const fail = (m) => {
    failed++;
    console.error(`::error::update: ${m}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- update failed: ${m}\n`);
  };
  try {
    run(opts, (m) => console.error(`::warning::update: ${m}`), (m) => console.log(m), fail);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    console.error(`::error::update: ${e.message}`);
    process.exit(1);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
