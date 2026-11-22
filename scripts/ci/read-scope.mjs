// The repositories the read-only App token of a control job covers: the
// caller's, and every catenahq repository that the lock files at a pull
// request's base and head and its body's Depends-on lines name; with --open,
// those the Depends-on lines of every open pull request of the caller name.
//
//   node read-scope.mjs --repo <owner/name> --pr <n> --base <sha> --head <sha>
//   node read-scope.mjs --repo <owner/name> --open
//
// GH_TOKEN reads the caller. Prints the names, deduplicated and
// comma-separated as actions/create-github-app-token reads them, and writes
// repositories=<names> to GITHUB_OUTPUT. More than MAX names fail. Exit 1 on a
// GitHub API error or too many names, 2 on bad arguments (README.md, "Control
// workflow").
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, get, gh, parseDependsOn } from "./gate-status.mjs";

export const OWNER = "catenahq";
export const MAX = 15;
const LOCK_LINE = /^([\w.-]+)\/([\w.-]+)\s+[0-9a-f]{40}(\s+#.*)?$/;
const SHA = /^[0-9a-f]{40}$/;

export class ScopeError extends Error {}

// The catenahq repositories a lock file names; other lines are left to the
// workflow policy.
export function lockRepos(text) {
  return text
    .split("\n")
    .map((line) => line.trim().match(LOCK_LINE))
    .filter((m) => m && m[1].toLowerCase() === OWNER)
    .map((m) => m[2].toLowerCase());
}

// The repositories a pull request body's Depends-on lines name.
export const bodyRepos = (body) => parseDependsOn(body).deps.map((d) => d.repo.split("/")[1].toLowerCase());

// The lock file of the caller at a commit; a 404 is no lock.
function lockAt(repo, sha) {
  try {
    return gh(["api", `repos/${repo}/contents/.github/catenahq.lock?ref=${sha}`, "-H", "Accept: application/vnd.github.raw+json"]);
  } catch (e) {
    if (e instanceof ApiError && e.message.includes("(HTTP 404)")) return "";
    throw e;
  }
}

// The caller's name first, then the others named, sorted, each once.
export function scope(repo, names) {
  const own = repo.split("/")[1].toLowerCase();
  const all = [own, ...[...new Set(names)].filter((n) => n !== own).sort()];
  if (all.length > MAX) throw new ScopeError(`${all.length} repositories to read, more than ${MAX}: ${all.join(", ")}`);
  return all;
}

export function readScope({ repo, pr, base, head, open }) {
  if (open) {
    const pulls = JSON.parse(gh(["pr", "list", "--repo", repo, "--state", "open", "--json", "body", "--limit", "1000"]));
    return scope(repo, pulls.flatMap((p) => bodyRepos(p.body)));
  }
  const names = [...lockRepos(lockAt(repo, base)), ...lockRepos(lockAt(repo, head)), ...bodyRepos(get(`repos/${repo}/pulls/${pr}`).body)];
  return scope(repo, names);
}

function parseArgs(argv) {
  const opts = { open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--open") opts.open = true;
    else if (["--repo", "--pr", "--base", "--head"].includes(a)) opts[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument '${a}'`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo ?? "")) throw new Error("--repo needs owner/name");
  if (opts.open) {
    if (opts.pr !== undefined || opts.base !== undefined || opts.head !== undefined) throw new Error("--open takes no --pr, --base or --head");
    return opts;
  }
  if (!/^[1-9][0-9]*$/.test(opts.pr ?? "")) throw new Error("--pr needs a pull request number");
  if (!SHA.test(opts.base ?? "") || !SHA.test(opts.head ?? "")) throw new Error("--base and --head need 40-hex commits");
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`::error::read-scope: ${e.message}`);
    process.exit(2);
  }
  try {
    const names = readScope(opts).join(",");
    console.log(names);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `repositories=${names}\n`);
  } catch (e) {
    if (!(e instanceof ApiError) && !(e instanceof ScopeError)) throw e;
    console.error(`::error::read-scope: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
