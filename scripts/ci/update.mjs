// Brings the auto-merge pull requests of a repository up to date with their
// base one at a time, and recomputes the `ci / gate` status of the pull
// requests that depend on one.
//
//   node update.mjs --repo <owner/name> --event <name> [--sha <pushed commit>] [--apps]
//
// GH_TOKEN authenticates gh. On every event, for each base of BASES: when a
// candidate (an open pull request with auto-merge on) that is not behind its
// base has its `ci / gate` check run queued or in progress, nothing is
// updated; otherwise the oldest candidate that is behind its base, whose head
// passed the `ci / gate` check run, with --apps whose `app-tests` status is
// success, and with no open Depends-on pull request, is updated with its base.
// On push, each open pull request of the owner whose body names a pull request
// merged as --sha gets its `ci / gate` status recomputed, with app-tests for
// this repository with --apps and for another one whose .github/checks.yml at
// the pull request head declares apps; on schedule, each open pull request of
// the repository with a Depends-on line does. Exit 1 on a GitHub API error, 2
// on bad arguments (README.md, "Control workflow").
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ApiError, CONTEXT, appTestsState, computeState, get, gh, parseDependsOn, post, unmetDependency } from "./gate-status.mjs";

export const BASES = ["main", "release"];
const EVENTS = ["push", "workflow_run", "schedule", "pull_request_target"];
// Any App with checks write can create a check run of any name: only the one
// GitHub Actions made for the gate job counts.
const ACTIONS_APP = "github-actions";
const PR_FIELDS = "number,isDraft,autoMergeRequest,headRefOid,mergeStateStatus,createdAt,body";

const ghJSON = (args) => JSON.parse(gh(args));

function openPulls(repo, base) {
  const args = ["pr", "list", "--repo", repo, "--state", "open", "--json", PR_FIELDS, "--limit", "1000"];
  if (base) args.push("--base", base);
  return ghJSON(args);
}

// The newest `ci / gate` check run GitHub Actions made on the commit, or null.
function gateRun(repo, sha) {
  const { check_runs: runs } = get(`repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(CONTEXT)}&per_page=100`);
  return (
    runs
      .filter((r) => r.name === CONTEXT && r.app?.slug === ACTIONS_APP)
      .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))[0] ?? null
  );
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
  return unmetDependency(parseDependsOn(pr.body).deps);
}

// Updates the oldest ready candidate of the base with its base; its number,
// or null when none is updated.
export function updateBase(repo, base, apps, log) {
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
    const reason = skipReason(repo, pr, apps);
    if (reason) {
      log(`${base}: skip #${pr.number}: ${reason}`);
      continue;
    }
    gh(["api", "-X", "PUT", `repos/${repo}/pulls/${pr.number}/update-branch`, "-f", `expected_head_sha=${pr.headRefOid}`]);
    log(`${base}: updated #${pr.number} with its base`);
    return pr.number;
  }
  log(`${base}: no pull request to update`);
  return null;
}

// Whether the repository runs app-tests at the commit: its .github/checks.yml,
// read as data, declares apps. A 404 is no checks.yml, so no app-tests; any
// other failed read fails.
function declaresApps(repo, sha) {
  let file;
  try {
    file = get(`repos/${repo}/contents/.github/checks.yml?ref=${sha}`);
  } catch (e) {
    if (e instanceof ApiError && e.message.includes("(HTTP 404)")) return false;
    throw e;
  }
  if (file.encoding !== "base64") throw new ApiError(`${repo} .github/checks.yml at ${sha}: encoding '${file.encoding}', not base64`);
  const doc = parse(Buffer.from(file.content, "base64").toString("utf-8"));
  return doc !== null && typeof doc === "object" && Object.hasOwn(doc, "apps");
}

function refresh(repo, number, sha, appTests, warn, log) {
  const result = computeState({ repo, pr: number, sha, appTests }, warn);
  post({ repo, sha }, result);
  log(`${repo}#${number}: ${CONTEXT} ${result.state}: ${result.description}`);
}

// The open pull requests of the owner whose body names a pull request merged
// as sha. Search matches words, so each hit's body is read and parsed again.
export function refreshDependents(repo, sha, apps, warn, log) {
  const owner = repo.split("/")[0];
  const merged = get(`repos/${repo}/commits/${sha}/pulls`).filter((pr) => pr.merged_at && pr.merge_commit_sha === sha);
  for (const { number } of merged) {
    const line = `Depends-on: ${repo}#${number}`;
    const hits = ghJSON(["search", "prs", "--owner", owner, "--state", "open", "--match", "body", "--json", "number,repository", "--limit", "100", line]);
    for (const hit of hits) {
      const target = hit.repository.nameWithOwner;
      const pr = get(`repos/${target}/pulls/${hit.number}`);
      if (!parseDependsOn(pr.body).deps.some((d) => d.repo === repo && d.number === number)) continue;
      const appTests = target === repo ? apps : declaresApps(target, pr.head.sha);
      refresh(target, hit.number, pr.head.sha, appTests, warn, log);
    }
  }
}

// Every open pull request of the repository with a Depends-on line: covers a
// dependent the search did not index yet when its dependency merged.
export function refreshDependsOn(repo, apps, warn, log) {
  for (const pr of openPulls(repo)) {
    if (parseDependsOn(pr.body).deps.length) refresh(repo, pr.number, pr.headRefOid, apps, warn, log);
  }
}

export function run({ repo, event, sha, apps }, warn, log) {
  for (const base of BASES) updateBase(repo, base, apps, log);
  if (event === "push") refreshDependents(repo, sha, apps, warn, log);
  if (event === "schedule") refreshDependsOn(repo, apps, warn, log);
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
  if (opts.event === "push" && !/^[0-9a-f]{40}$/.test(opts.sha ?? "")) throw new Error("--sha needs the pushed 40-hex commit on push");
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
  try {
    run(opts, (m) => console.error(`::warning::update: ${m}`), (m) => console.log(m));
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    console.error(`::error::update: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
