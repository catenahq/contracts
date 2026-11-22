// The workflow policy of a pull request: its workflows, actions and lock, read
// as data, against the rules of README.md, "Workflow policy".
//
//   node workflow-policy.mjs fetch --repo <owner/name> --pr <n> --head <sha> --base <sha> --dir <dir>
//   node workflow-policy.mjs check --repo <owner/name> --sha <head sha> --dir <dir> --zizmor <exit status>
//   node workflow-policy.mjs error --repo <owner/name> --sha <head sha>
//   node workflow-policy.mjs --seed [--local <repo>=<checkout>]... [--out <file>]
//
// GH_TOKEN authenticates gh; GH_READ_TOKEN, when set, makes the comparisons
// of the rule merged, which can reach other repositories. fetch writes every file under .github/ and every
// changed file at the head into <dir>/pr/, the workflows of the base into
// <dir>/base/ and the changed paths into <dir>/changed.json, through the
// contents API: nothing of the pull request is checked out or run. In the
// copies of the workflows and actions it drops each inline zizmor directive. check runs
// the rules over them with the exit status of the zizmor scan, prints the
// summary (and appends it to GITHUB_STEP_SUMMARY), and posts the commit status
// `workflow policy` on the head; error posts it as error. --seed writes the
// policy file (default workflow-policy.json) from the permission ceilings and
// secret names of every workflow of every repository of REPOS, each read from
// its default branch through the API, from this tree for contracts, or from
// the working tree of a --local checkout, and of the caller templates in
// README.md. Exit 1 on a failed rule, a GitHub API error or a failed read, 2
// on bad arguments.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseDocument } from "yaml";
import { ApiError, POLICY_FILE, get, gh, post, readGet } from "./gate-status.mjs";

export { POLICY_FILE };
export const CONTEXT = "workflow policy";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OWNER = "catenahq";
// The repositories whose ci.yml and ci-control.yml call pr.yml and control.yml.
export const REPOS = [
  "catena-admin", "catena-ce", "catena-templates", "ci-runner", "contracts", "docs", "ops", "ops-templates",
  "renovate", "renovate-config", "repertoire-entreprises", "scanctl", "website",
];
export const RULES = [
  "yaml", "pinned", "merged", "secrets-inherit", "permissions", "pull-request-target", "secrets", "gate-needs",
  "ci-gate", "ci-control", "zizmor",
];
const SHA = /^[0-9a-f]{40}$/;
const LEVELS = { none: 0, read: 1, write: 2 };
// The token of the run itself, which no repository or environment stores.
const RUN_TOKEN = "GITHUB_TOKEN";
// A first-party commit and a lock line are on this branch: only merged code runs.
const MERGED_BRANCH = "main";
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION = /^\.github\/(.+\/)?action\.ya?ml$/;
const LOCK = ".github/catenahq.lock";
const CI_CONTROL = ".github/workflows/ci-control.yml";
const CALLER_KEYS = ["uses", "permissions", "with"];
// An inline zizmor directive.
const ZIZMOR_DIRECTIVE = /#\s*zizmor\s*:/g;
const LOCK_LINE = /^([\w.-]+\/[\w.-]+)\s+([0-9a-f]{40})(\s+#.*)?$/;
const REF = /^([^/@\s]+)\/([^/@\s]+)(?:\/[^@\s]*)?@([^@\s]+)$/;
const SECRET_REF = /\bsecrets\.([A-Za-z_][A-Za-z0-9_-]*)/g;
// Paths whose contents run or decide what runs: actions, scripts, ci/run,
// build/, lock files, the checks and scan settings and the scan baseline.
const EXECUTED =
  /^(\.github\/actions\/|scripts\/|ci\/|build\/|\.scanctl\/)|^(\.github\/checks\.yml|scanctl\.yml)$|(^|\/)([^/]+\.lock|package-lock\.json|pnpm-lock\.yaml|go\.sum)$/;
// An expression or ref that names the pull request's code, and a command that fetches code.
const PR_CODE = /github\.event\.pull_request\.head\.|github\.head_ref|merge_commit_sha|refs\/pull\//;
const FETCHES = /\bgit\s+(fetch|checkout|clone|switch|pull|worktree)\b|\bgh\s+pr\s+checkout\b/;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const jobsOf = (doc) => Object.entries(isObject(doc?.jobs) ? doc.jobs : {}).filter(([, job]) => isObject(job));
const stepsOf = (owner) => (Array.isArray(owner?.steps) ? owner.steps.filter(isObject) : []);
const needsOf = (job) => (typeof job?.needs === "string" ? [job.needs] : Array.isArray(job?.needs) ? job.needs : []);
const triggers = (on) => (typeof on === "string" ? [on] : Array.isArray(on) ? on : isObject(on) ? Object.keys(on) : []);
export const secretNames = (text) => [...text.matchAll(SECRET_REF)].map((m) => m[1]);
// A uses: with its owner and repository lowercased: GitHub resolves them
// without regard to case.
const lowerRepo = (uses) => uses.replace(/^[^/@\s]+\/[^/@\s]+/, (s) => s.toLowerCase());

// A caller in catenahq/contracts calls its own pr.yml or control.yml by the
// local path, which takes no ref: GitHub runs the called file of the caller's
// commit, on pull_request_target the last commit of the default branch.
const localCall = (repo, uses, file) =>
  repo.toLowerCase() === `${OWNER}/contracts` && uses === `./.github/workflows/${file}`;

// How a ci-control.yml differs from the caller shape: one job that calls
// control.yml of contracts at a 40-hex commit (contracts: by the local path),
// with no key but CALLER_KEYS.
function callerShape(doc, repo) {
  const ids = isObject(doc?.jobs) ? Object.keys(doc.jobs) : [];
  if (ids.length !== 1) return [`has ${ids.length} jobs; the caller has one`];
  const [id] = ids;
  const job = doc.jobs[id];
  if (!isObject(job)) return [`job ${id} is not a mapping`];
  const problems = [];
  const owner = repo.split("/")[0];
  const control = new RegExp(`^${escape(owner.toLowerCase())}/contracts/\\.github/workflows/control\\.yml@[0-9a-f]{40}$`);
  if (typeof job.uses !== "string" || !(control.test(lowerRepo(job.uses)) || localCall(repo, job.uses, "control.yml"))) {
    problems.push(`job ${id} does not call ${owner}/contracts/.github/workflows/control.yml at a 40-hex commit`);
  }
  const extra = Object.keys(job).filter((k) => !CALLER_KEYS.includes(k));
  if (extra.length) problems.push(`job ${id} has ${extra.join(", ")}; the caller job has only ${CALLER_KEYS.join(", ")}`);
  return problems;
}

// ---- fetch

function safePath(path) {
  const parts = path.split("/");
  if (path.includes("\0") || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new ApiError(`refusing the path '${path}'`);
  }
  return path;
}

// The files under .github/ at the commit, symbolic links left out.
function githubFiles(repo, sha) {
  const root = get(`repos/${repo}/git/trees/${sha}`);
  if (root.truncated) throw new ApiError(`the tree of ${repo} at ${sha} is truncated`);
  const dir = root.tree.find((e) => e.path === ".github" && e.type === "tree");
  if (!dir) return [];
  const sub = get(`repos/${repo}/git/trees/${dir.sha}?recursive=1`);
  if (sub.truncated) throw new ApiError(`the .github tree of ${repo} at ${sha} is truncated`);
  return sub.tree.filter((e) => e.type === "blob" && e.mode !== "120000").map((e) => `.github/${e.path}`);
}

// The files the pull request changes, {path, status}; the API lists 3000 at most.
function changedFiles(repo, pr) {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = get(`repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    files.push(...batch.map((f) => ({ path: f.filename, status: f.status })));
    if (batch.length < 100) break;
  }
  if (files.length >= 3000) throw new ApiError(`${repo}#${pr} changes 3000 files or more, past what the API lists`);
  return files;
}

function download(repo, sha, paths, dir) {
  mkdirSync(dir, { recursive: true });
  for (const path of paths) {
    const target = join(dir, safePath(path));
    const api = `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, gh(["api", api, "-H", "Accept: application/vnd.github.raw+json"], "buffer"));
  }
}

// The head as zizmor reads it: no inline zizmor directive of the pull request
// counts.
function prepareZizmor(dir) {
  for (const path of listFiles(join(dir, ".github"), ".github")) {
    if (!WORKFLOW.test(path) && !ACTION.test(path)) continue;
    const file = join(dir, path);
    writeFileSync(file, readFileSync(file, "utf-8").replace(ZIZMOR_DIRECTIVE, "# dropped-zizmor-directive:"));
  }
}

export function fetchFiles({ repo, pr, head, base, dir }) {
  rmSync(dir, { recursive: true, force: true });
  const changed = changedFiles(repo, pr);
  const paths = new Set(githubFiles(repo, head));
  for (const f of changed) if (f.status !== "removed") paths.add(f.path);
  download(repo, head, [...paths].sort(), join(dir, "pr"));
  prepareZizmor(join(dir, "pr"));
  download(repo, base, githubFiles(repo, base).filter((p) => WORKFLOW.test(p)), join(dir, "base"));
  writeFileSync(join(dir, "changed.json"), `${JSON.stringify(changed)}\n`);
  return { files: paths.size, changed: changed.length };
}

// ---- check

function listFiles(dir, prefix) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) return listFiles(join(dir, e.name), rel);
    return e.isFile() ? [rel] : [];
  });
}

// The workflows and actions of a tree, {path: {text, doc}}, and its lock text
// (null without one). A file that does not parse is reported and left out.
function loadTree(dir, report) {
  const tree = { workflows: {}, actions: {}, lock: null };
  for (const path of listFiles(join(dir, ".github"), ".github").sort()) {
    const text = readFileSync(join(dir, path), "utf-8");
    if (path === LOCK) tree.lock = text;
    const kind = WORKFLOW.test(path) ? "workflows" : ACTION.test(path) ? "actions" : null;
    if (!kind) continue;
    const doc = parseDocument(text);
    if (doc.errors.length) report("yaml", path, doc.errors[0].message.split("\n")[0]);
    else tree[kind][path] = { text, doc: doc.toJS() ?? {} };
  }
  return tree;
}

function usesOf(path, doc) {
  const owners = WORKFLOW.test(path) ? jobsOf(doc).map(([, job]) => job) : [doc?.runs];
  return owners
    .flatMap((owner) => [owner?.uses, ...stepsOf(owner).map((s) => s.uses)])
    .filter((u) => typeof u === "string");
}

function rulePinned(files, report) {
  for (const [path, { text, doc }] of files) {
    for (const uses of usesOf(path, doc)) {
      if (uses.startsWith("./")) continue;
      if (uses.startsWith("docker://")) {
        if (!/@sha256:[0-9a-f]{64}$/.test(uses)) report("pinned", path, `uses: ${uses} is not pinned by digest`);
        continue;
      }
      const m = uses.match(REF);
      const comment = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*(['"]?)${escape(uses)}\\1\\s+#\\s*\\S`, "m");
      if (!m || !SHA.test(m[3])) report("pinned", path, `uses: ${uses} is not pinned by a 40-hex commit`);
      else if (!comment.test(text)) report("pinned", path, `uses: ${uses} has no version comment`);
    }
  }
}

// A uses: of the owner pinned by commit: the repository, the referenced path
// (the uses: without its @ref) and the commit, the owner and repository
// lowercased. null for any other uses:.
function firstParty(uses, owner) {
  const lowered = lowerRepo(uses);
  const m = lowered.match(REF);
  if (!m || m[1] !== owner.toLowerCase() || !SHA.test(m[3])) return null;
  return { repo: `${m[1]}/${m[2]}`, path: lowered.slice(0, lowered.lastIndexOf("@")), sha: m[3] };
}

function ruleMerged(files, lock, owner, base, report) {
  const refs = new Map();
  const add = (repo, sha, where) => refs.set(`${repo}@${sha}`, [...(refs.get(`${repo}@${sha}`) ?? []), where]);
  for (const [path, { doc }] of files) {
    for (const pin of usesOf(path, doc).map((u) => firstParty(u, owner)).filter(Boolean)) add(pin.repo, pin.sha, path);
  }
  (lock ?? "").split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(LOCK_LINE);
    if (m) add(m[1], m[2], `${LOCK}:${i + 1}`);
    else report("merged", `${LOCK}:${i + 1}`, `'${line}' is not '<owner>/<repo> <40-hex sha> # <branch>'`);
  });
  for (const [key, where] of refs) {
    const [repo, sha] = key.split("@");
    let status;
    try {
      status = readGet(`repos/${repo}/compare/${sha}...${MERGED_BRANCH}`).status;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      report("merged", where.join(", "), `${key} could not be compared with ${MERGED_BRANCH}: ${e.message}`);
      continue;
    }
    if (status !== "ahead" && status !== "identical") {
      report("merged", where.join(", "), `${key} is not on ${MERGED_BRANCH} (${status})`);
    }
  }
  ruleNoDowngrade(files, owner, base, report);
}

// No first-party pin of a workflow moves back: each is the base's pin of the
// same workflow file and referenced path, or a descendant of it. A pin the
// base file does not have is new and passes here.
function ruleNoDowngrade(files, owner, base, report) {
  const pins = (path, doc) => usesOf(path, doc).map((u) => firstParty(u, owner)).filter(Boolean);
  const compared = new Set();
  for (const [path, { doc }] of files) {
    if (!WORKFLOW.test(path) || !base.has(path)) continue;
    const was = pins(path, base.get(path).doc);
    for (const pin of pins(path, doc)) {
      for (const old of was) {
        const key = `${path} ${pin.path}@${old.sha}...${pin.sha}`;
        if (old.path !== pin.path || old.sha === pin.sha || compared.has(key)) continue;
        compared.add(key);
        let status;
        try {
          status = readGet(`repos/${pin.repo}/compare/${old.sha}...${pin.sha}`).status;
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          report("merged", path, `${pin.path}@${pin.sha} could not be compared with the base's pin ${old.sha}: ${e.message}`);
          continue;
        }
        if (status !== "ahead" && status !== "identical") {
          report("merged", path, `${pin.path}@${pin.sha} is not at or after the base's pin ${old.sha} (${status})`);
        }
      }
    }
  }
}

// The permissions a job's token gets: its own block, else the workflow's.
const jobPermissions = (doc, job) => (Object.hasOwn(job, "permissions") ? job.permissions : doc.permissions);

function rulePermissions(workflows, repoName, policy, report) {
  for (const [path, { doc }] of workflows) {
    for (const [id, job] of jobsOf(doc)) {
      if (job.secrets === "inherit") report("secrets-inherit", path, `job ${id} passes secrets: inherit`);
      const own = Object.hasOwn(job, "permissions");
      const permissions = jobPermissions(doc, job);
      const has = own ? `job ${id} has` : `job ${id} has no permissions block and the workflow has`;
      if (permissions === undefined) {
        report("permissions", path, `job ${id} has no permissions block and the workflow has none`);
        continue;
      }
      if (!isObject(permissions)) {
        report("permissions", path, `${has} permissions: ${permissions}; name each scope`);
        continue;
      }
      const asked = Object.entries(permissions).filter(([, level]) => level !== "none");
      if (!asked.length) continue;
      const key = `${repoName}:${basename(path)}:${id}`;
      const ceiling = policy.permissions[key];
      if (!ceiling) {
        report("permissions", path, `job ${id} asks for permissions and has no ceiling: add "${key}" to scripts/ci/workflow-policy.json`);
        continue;
      }
      for (const [scope, level] of asked) {
        const max = ceiling[scope] ?? "none";
        if (!(level in LEVELS) || LEVELS[level] > LEVELS[max]) {
          report("permissions", path, `job ${id} ${own ? "asks for" : "gets from the workflow"} ${scope}: ${level}, wider than ${max} (${key})`);
        }
      }
    }
  }
}

// The jobs of a workflow run on pull_request_target, and of each workflow of
// this tree it calls, take no code of the pull request.
function rulePullRequestTarget(workflows, report) {
  const walk = (path, doc, seen) => {
    for (const [id, job] of jobsOf(doc)) {
      if (typeof job.uses === "string" && job.uses.startsWith("./")) {
        const called = job.uses.slice(2);
        if (workflows.has(called) && !seen.has(called)) walk(called, workflows.get(called).doc, seen.add(called));
        continue;
      }
      for (const step of stepsOf(job)) {
        const uses = typeof step.uses === "string" ? step.uses : "";
        const w = isObject(step.with) ? step.with : {};
        const env = JSON.stringify([doc.env, job.env, step.env]);
        const run = typeof step.run === "string" ? step.run : "";
        if (uses.startsWith("actions/checkout@") && PR_CODE.test(`${w.ref ?? ""} ${w.repository ?? ""}`)) {
          report("pull-request-target", path, `job ${id} checks out the pull request's code on pull_request_target`);
        } else if (FETCHES.test(run) && (PR_CODE.test(run) || PR_CODE.test(env) || /\bgh\s+pr\s+checkout\b/.test(run))) {
          report("pull-request-target", path, `job ${id} fetches the pull request's code on pull_request_target`);
        }
      }
    }
  };
  for (const [path, { doc }] of workflows) {
    if (triggers(doc.on).includes("pull_request_target")) walk(path, doc, new Set([path]));
  }
}

function ruleSecrets(files, policy, report) {
  const allowed = new Set([RUN_TOKEN, ...policy.secrets]);
  for (const [path, { text, doc }] of files) {
    const names = new Set(secretNames(text));
    if (WORKFLOW.test(path)) {
      for (const [, job] of jobsOf(doc)) if (isObject(job.secrets)) Object.keys(job.secrets).forEach((n) => names.add(n));
    }
    if (/\bsecrets\s*\[/.test(text)) report("secrets", path, "a secret is named by an index expression; write secrets.<NAME>");
    for (const name of [...names].sort()) {
      if (!allowed.has(name)) report("secrets", path, `secret ${name} is not in the secrets of scripts/ci/workflow-policy.json`);
    }
  }
}

// The gate job of each base workflow and the jobs it needs stay required: none
// leaves its needs, gets continue-on-error or a new if:.
function ruleGateNeeds(head, base, report) {
  for (const [path, { doc }] of base) {
    const baseJobs = Object.fromEntries(jobsOf(doc));
    if (!baseJobs.gate) continue;
    const headJobs = Object.fromEntries(jobsOf(head.get(path)?.doc));
    const headNeeds = needsOf(headJobs.gate);
    for (const id of ["gate", ...needsOf(baseJobs.gate)]) {
      const was = baseJobs[id] ?? {};
      const job = headJobs[id];
      if (!job) {
        report("gate-needs", path, `the required job ${id} is gone`);
        continue;
      }
      if (id !== "gate" && !headNeeds.includes(id)) report("gate-needs", path, `job ${id} left the needs of gate`);
      if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== was["continue-on-error"]) {
        report("gate-needs", path, `the required job ${id} gets continue-on-error`);
      }
      if (String(job.if ?? "").trim() !== String(was.if ?? "").trim()) {
        report("gate-needs", path, `the required job ${id} has a changed if: ${job.if ?? "(none)"}`);
      }
    }
  }
}

// A job's check run name can match: each ${{ }} expression matches anything.
const canBe = (name, target) => new RegExp(`^${name.split(/\$\{\{.*?\}\}/).map(escape).join(".*")}$`).test(target);

// Only the job ci of ci.yml, calling pr.yml of contracts, yields `ci / gate`.
function ruleCiGate(workflows, repo, report) {
  const owner = repo.split("/")[0];
  const prYml = (uses) =>
    lowerRepo(uses).startsWith(`${owner.toLowerCase()}/contracts/.github/workflows/pr.yml@`) || localCall(repo, uses, "pr.yml");
  for (const [path, { doc }] of workflows) {
    for (const [id, job] of jobsOf(doc)) {
      const name = String(job.name ?? id);
      const calls = typeof job.uses === "string";
      if (!canBe(name, "ci / gate") && !(calls && canBe(name, "ci"))) continue;
      if (path === ".github/workflows/ci.yml" && id === "ci" && name === "ci" && calls && prYml(job.uses)) continue;
      report("ci-gate", path, `job ${id} (name '${name}') can yield the check name ci / gate`);
    }
  }
}

export function evaluate({ repo, dir, zizmor, policy }) {
  const [owner, repoName] = repo.split("/");
  const findings = [];
  const report = (rule, file, message) => findings.push({ rule, file, message });
  const head = loadTree(join(dir, "pr"), report);
  const base = loadTree(join(dir, "base"), () => {});
  const workflows = new Map(Object.entries(head.workflows));
  const baseWorkflows = new Map(Object.entries(base.workflows));
  const files = new Map(Object.entries({ ...head.workflows, ...head.actions }));
  rulePinned(files, report);
  ruleMerged(files, head.lock, owner, baseWorkflows, report);
  rulePermissions(workflows, repoName, policy, report);
  rulePullRequestTarget(workflows, report);
  ruleSecrets(files, policy, report);
  ruleGateNeeds(workflows, baseWorkflows, report);
  ruleCiGate(workflows, repo, report);
  if (workflows.has(CI_CONTROL)) {
    for (const problem of callerShape(workflows.get(CI_CONTROL).doc, repo)) report("ci-control", CI_CONTROL, problem);
  }
  if (zizmor !== "0") report("zizmor", ".github", `scanctl exited ${zizmor}; its zizmor findings are in the summary`);
  const changed = JSON.parse(readFileSync(join(dir, "changed.json"), "utf-8"));
  findings.sort((a, b) => RULES.indexOf(a.rule) - RULES.indexOf(b.rule));
  return { findings, executed: changed.filter((f) => EXECUTED.test(f.path)) };
}

export function summary({ findings, executed }) {
  const lines = ["## Workflow policy", "", "| Rule | Result |", "| --- | --- |"];
  for (const rule of RULES) lines.push(`| ${rule} | ${findings.some((f) => f.rule === rule) ? "failed" : "passed"} |`);
  if (findings.length) lines.push("", "### Findings", "", ...findings.map((f) => `- ${f.rule}: \`${f.file}\`: ${f.message}`));
  lines.push("", "### Executed paths the change touches", "");
  lines.push(...(executed.length ? executed.map((f) => `- \`${f.path}\` (${f.status})`) : ["None."]));
  return `${lines.join("\n")}\n`;
}

// ---- seed

const WORKFLOW_FILE = /^[^/]+\.ya?ml$/;
const byName = ([a], [b]) => a.localeCompare(b);

// Each job's permissions, its own block or the workflow's, as its ceiling; a
// key two sources give keeps the wider level of each scope.
function addCeilings(permissions, repo, file, doc) {
  for (const [id, job] of jobsOf(doc)) {
    const asked = jobPermissions(doc, job);
    if (!isObject(asked)) continue;
    const key = `${repo}:${file}:${id}`;
    for (const [scope, level] of Object.entries(asked)) {
      if (!(level in LEVELS) || level === "none") continue;
      permissions[key] ??= {};
      if (LEVELS[level] > LEVELS[permissions[key][scope] ?? "none"]) permissions[key][scope] = level;
    }
  }
}

// The ci.yml and ci-control.yml caller templates of README.md.
function templates() {
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const docs = [...readme.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)]
    .map((m) => parse(m[1]))
    .filter((doc) => isObject(doc) && ["ci", "ci-control"].includes(doc.name) && isObject(doc.jobs));
  if (docs.map((doc) => doc.name).sort().join(",") !== "ci,ci-control") {
    throw new Error("README.md holds one ci and one ci-control caller template");
  }
  return docs;
}

// The workflow files of a checkout's working tree, {name: text}.
export function localWorkflows(root) {
  const dir = join(root, ".github", "workflows");
  const names = readdirSync(dir).filter((name) => WORKFLOW_FILE.test(name)).sort();
  return Object.fromEntries(names.map((name) => [name, readFileSync(join(dir, name), "utf-8")]));
}

// The workflow files of a repository's default branch, read through the
// contents API as data.
function apiWorkflows(repo) {
  const list = get(`repos/${repo}/contents/.github/workflows`);
  if (!Array.isArray(list)) throw new ApiError(`${repo} .github/workflows is not a directory`);
  const names = list.filter((e) => e.type === "file" && WORKFLOW_FILE.test(e.name)).map((e) => e.name).sort();
  const raw = (name) => gh(["api", `repos/${repo}/contents/.github/workflows/${encodeURIComponent(name)}`, "-H", "Accept: application/vnd.github.raw+json"]);
  return Object.fromEntries(names.map((name) => [name, raw(name)]));
}

// The policy of the sources, [{repo, files: {name: text}}], and of the caller
// templates for every repository of REPOS: the ceiling of each job and every
// secret name the workflows use or pass. A file that does not parse throws.
export function policyOf(sources) {
  const permissions = {};
  const secrets = new Set();
  for (const doc of templates()) for (const repo of REPOS) addCeilings(permissions, repo, `${doc.name}.yml`, doc);
  for (const { repo, files } of sources) {
    for (const [name, text] of Object.entries(files)) {
      const parsed = parseDocument(text);
      if (parsed.errors.length) throw new Error(`${repo} .github/workflows/${name} does not parse: ${parsed.errors[0].message.split("\n")[0]}`);
      const doc = parsed.toJS() ?? {};
      addCeilings(permissions, repo, name, doc);
      secretNames(text).forEach((s) => secrets.add(s));
      for (const [, job] of jobsOf(doc)) if (isObject(job.secrets)) Object.keys(job.secrets).forEach((s) => secrets.add(s));
    }
  }
  secrets.delete(RUN_TOKEN);
  const sorted = Object.entries(permissions).sort(byName).map(([key, c]) => [key, Object.fromEntries(Object.entries(c).sort(byName))]);
  return { secrets: [...secrets].sort(), permissions: Object.fromEntries(sorted) };
}

// Every workflow of every repository of REPOS: contracts from this tree, a
// repository of local from that checkout's working tree, any other from its
// default branch through the API. Nothing is written unless every read
// succeeded.
export function seed({ local = {}, out = POLICY_FILE }) {
  const sources = REPOS.map((name) => {
    const root = local[name] ?? (name === "contracts" ? ROOT : null);
    return { repo: name, files: root === null ? apiWorkflows(`${OWNER}/${name}`) : localWorkflows(root) };
  });
  const policy = policyOf(sources);
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`);
  renameSync(tmp, out);
  return { repos: sources.length, files: sources.reduce((n, s) => n + Object.keys(s.files).length, 0) };
}

// ---- main

const FLAGS = {
  fetch: ["repo", "pr", "head", "base", "dir"],
  check: ["repo", "sha", "dir", "zizmor"],
  error: ["repo", "sha"],
};
const FORMATS = { repo: /^[\w.-]+\/[\w.-]+$/, pr: /^[1-9][0-9]*$/, head: SHA, base: SHA, sha: SHA, zizmor: /^[0-9]+$/, dir: /./ };

// --seed [--local <repo>=<path>]... [--out <file>]
function parseSeed(rest) {
  const opts = { cmd: "seed", local: {} };
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (rest[i] === "--out" && value) {
      opts.out = resolve(value);
    } else if (rest[i] === "--local" && /^[\w.-]+=./.test(value ?? "")) {
      const [name, path] = [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)];
      if (!REPOS.includes(name)) throw new Error(`--local ${name}: not a repository the policy covers (${REPOS.join(", ")})`);
      if (!existsSync(join(path, ".github", "workflows"))) throw new Error(`--local ${name}: ${path} has no .github/workflows`);
      opts.local[name] = resolve(path);
    } else {
      throw new Error(`unknown argument '${rest[i]}'`);
    }
  }
  return opts;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--seed") return parseSeed(rest);
  if (!Object.hasOwn(FLAGS, cmd)) throw new Error("the first argument is fetch, check, error or --seed");
  const opts = { cmd };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith("--") || !FLAGS[cmd].includes(key) || rest[i + 1] === undefined) {
      throw new Error(`unknown argument '${rest[i]}'`);
    }
    opts[key] = rest[i + 1];
  }
  for (const key of FLAGS[cmd]) if (!FORMATS[key].test(opts[key] ?? "")) throw new Error(`${cmd} needs --${key}`);
  return opts;
}

function check(opts) {
  const policy = JSON.parse(readFileSync(POLICY_FILE, "utf-8"));
  const result = evaluate({ ...opts, policy });
  const failed = RULES.filter((rule) => result.findings.some((f) => f.rule === rule));
  for (const f of result.findings) console.log(`::error::${f.rule}: ${f.file}: ${f.message}`);
  const text = summary(result);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  const state = failed.length ? "failure" : "success";
  const description = failed.length ? `failed: ${failed.join(", ")}` : "every rule passed";
  post({ repo: opts.repo, sha: opts.sha }, { context: CONTEXT, state, description });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "posted=true\n");
  console.log(`${CONTEXT}: ${state}: ${description}`);
  return failed.length ? 1 : 0;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`::error::workflow-policy: ${e.message}`);
    process.exit(2);
  }
  if (opts.cmd === "seed") {
    try {
      const n = seed(opts);
      console.log(`read ${n.repos} repositories and ${n.files} workflow files; wrote ${opts.out ?? POLICY_FILE}`);
    } catch (e) {
      console.error(`::error::workflow-policy: --seed: ${e.message}`);
      process.exit(1);
    }
    return;
  }
  try {
    if (opts.cmd === "fetch") {
      const n = fetchFiles(opts);
      console.log(`fetched ${n.files} file(s) of the head; the pull request changes ${n.changed}`);
    } else if (opts.cmd === "error") {
      post(opts, { context: CONTEXT, state: "error", description: "the policy run failed before its verdict" });
    } else {
      process.exitCode = check(opts);
    }
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    console.error(`::error::workflow-policy: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
