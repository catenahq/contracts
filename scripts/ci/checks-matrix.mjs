#!/usr/bin/env node
// Reads the caller's .github/checks.yml and .github/catenahq.lock, from the
// current directory, and prints the plan of the shared PR workflow
// (.github/workflows/pr.yml) as one line of JSON: "include", the matrix its
// checks run from, "scan", the settings of its scan jobs, and "apps", the
// settings of its app checks with the entry each changed app gets
// (scripts/ci/app-plan.sh adds those).
//
//   node ../contracts/scripts/ci/checks-matrix.mjs --repo <name> --runner <label>
//
// --repo is the caller's repository name, checked out under ws/<name>;
// --runner is the label of every check that names no runs-on (the workflow's
// runner input). checks.yml is data: a key or tool the parser does not know
// fails, with the key named. Every entry, and the scan, carries every key, so
// no workflow expression reads a missing one. An entry's kind says what check
// runs it: gates, check (bash ci/run), apps-repo or app (scripts/ci/app-check.sh).
// A sibling's value is the checkout's fetch depth, "bundle" for one fetched
// with a token, or empty when the check does not use it. README.md, "Shared PR
// workflow", gives the file.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const OWNER = "catenahq";
// Each sibling has its own checkout step in pr.yml (check, and plan's bundle
// fetch) and in .github/actions/scan.
export const SIBLINGS = ["catena-admin", "catena-ce", "catena-templates", "contracts", "docs", "ops"];
const CHECK_KEYS = ["runs-on", "timeout-minutes", "tools", "siblings", "inputs", "go-cache"];
const GATE_KEYS = ["core-app-names", "duplication"];
const SCAN_KEYS = ["profile", "own-images", "image-inputs", "siblings", "tools"];
const APPS_KEYS = ["catalog", "own-images"];
// The uv the app checks run the catalog tools with, as the scan action's.
const APPS_UV = "0.13.9";
const APP_TIMEOUT = 60;
// The tools of the catalog repository: with apps.catalog false they come from
// catena-templates, whose commit joins the key as a sibling's.
const APP_TOOLS = ["build/", "lib/", "pyproject.toml", "uv.lock", "app.schema.json", "block.schema.json"];
// What an app check reads besides blueprints/<id>/, which app-plan.sh adds.
const APP_INPUTS = [...APP_TOOLS, ".clamav-allow.sfp", ".scanctl/"];
const APPS_REPO_INPUTS = ["blueprints/", ...APP_TOOLS];
const APP_CHECK_NAME = /^(app-.*|apps-repo)$/;
// An image repository without a tag or digest.
const IMAGE_NAME = /^[a-z0-9][a-z0-9._/-]*$/;
// The profiles scanctl run takes.
const SCAN_PROFILES = ["full", "sellable"];
const SIBLING_KEYS = ["fetch-depth", "token"];
const TOOL_KEYS = ["node", "uv", "go", "staticcheck"];
const TIMEOUT_DEFAULT = 20;
// The Node major the contracts gates run on.
const GATES_NODE = "26";
const EXACT = /^\d+\.\d+\.\d+$/;
const CHECK_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const LOCK_LINE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+[0-9a-f]{40}(\s+#.*)?$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+$/;
const GO_SIBLING = /^([a-z-]+)\/go\.mod$/;

const fail = (msg) => {
  throw new Error(msg);
};
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysOf = (where, value, allowed) => {
  if (!isMap(value)) fail(`${where} must be a mapping`);
  for (const k of Object.keys(value)) {
    if (!allowed.includes(k)) fail(`${where}: unknown key '${k}'`);
  }
  return value;
};

// The owner/name of each line of a catenahq.lock.
export function lockedRepos(text) {
  const repos = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = LOCK_LINE.exec(line);
    if (!m) fail(`.github/catenahq.lock: malformed line '${line}'`);
    repos.add(m[1]);
  }
  return repos;
}

// The secret names a workflow's on.workflow_call.secrets declares.
export function declaredSecrets(workflowText) {
  const secrets = parse(workflowText)?.on?.workflow_call?.secrets;
  return isMap(secrets) ? Object.keys(secrets) : [];
}

// go-file is the go.mod setup-go reads: ws/<repo>/go.mod for go.mod, and
// ws/<sibling>/go.mod for <sibling>/go.mod, which is allowed when sibs (the
// siblings the entry declares) holds the name.
function tools(where, value, { allowed = TOOL_KEYS, repo = "", sibs = null } = {}) {
  const out = { node: "", uv: "", go: "", "go-file": "", staticcheck: "", "staticcheck-sha256": "" };
  if (value === undefined) return out;
  keysOf(where, value, allowed);
  for (const t of ["node", "uv"]) {
    if (value[t] === undefined) continue;
    if (typeof value[t] !== "string" || !EXACT.test(value[t])) {
      fail(`${where}.${t} must be an exact version such as 1.2.3`);
    }
    out[t] = value[t];
  }
  if (value.go !== undefined) {
    const sibling = sibs === null ? null : GO_SIBLING.exec(String(value.go));
    if (value.go === "go.mod") {
      out["go-file"] = `ws/${repo}/go.mod`;
    } else if (sibling !== null && sibs.includes(sibling[1])) {
      out["go-file"] = `ws/${sibling[1]}/go.mod`;
    } else if (!(typeof value.go === "string" && EXACT.test(value.go))) {
      fail(
        sibs === null
          ? `${where}.go must be go.mod or an exact version such as 1.26.1`
          : `${where}.go must be go.mod, <sibling>/go.mod of a sibling the check declares, or an exact version such as 1.26.1`,
      );
    }
    out.go = value.go;
  }
  if (value.staticcheck !== undefined) {
    const sc = keysOf(`${where}.staticcheck`, value.staticcheck, ["version", "sha256"]);
    if (typeof sc.version !== "string" || !/^\d+\.\d+(\.\d+)?$/.test(sc.version)) {
      fail(`${where}.staticcheck.version must be a release such as 2026.2.2`);
    }
    if (typeof sc.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sc.sha256)) {
      fail(`${where}.staticcheck.sha256 must be 64 lowercase hex digits`);
    }
    out.staticcheck = sc.version;
    out["staticcheck-sha256"] = sc.sha256;
  }
  return out;
}

function siblings(where, value, locked, secrets, allowed = SIBLING_KEYS) {
  const out = Object.fromEntries(SIBLINGS.map((s) => [s, ""]));
  if (value === undefined) return out;
  if (!isMap(value)) fail(`${where} must be a mapping`);
  for (const [name, spec] of Object.entries(value)) {
    const at = `${where}.${name}`;
    if (!SIBLINGS.includes(name)) fail(`${where}: unknown sibling '${name}' (known: ${SIBLINGS.join(", ")})`);
    if (!locked.has(`${OWNER}/${name}`)) fail(`${at}: ${OWNER}/${name} has no line in .github/catenahq.lock`);
    const s = spec === null ? {} : keysOf(at, spec, allowed);
    const depth = s["fetch-depth"] ?? 1;
    if (!Number.isInteger(depth) || depth < 0) fail(`${at}.fetch-depth must be a whole number`);
    if (s.token !== undefined) {
      if (!secrets.includes(s.token)) {
        fail(`${at}.token: ${s.token} is not a secret pr.yml declares in on.workflow_call.secrets`);
      }
      out[name] = "bundle";
    } else {
      out[name] = String(depth);
    }
  }
  return out;
}

// The git pathspecs a check reads; default the whole tree.
function inputs(where, value) {
  if (value === undefined) return ["."];
  if (!Array.isArray(value) || value.length === 0 || value.some((p) => typeof p !== "string" || p === "")) {
    fail(`${where} must be a list of git pathspecs`);
  }
  return value;
}

function gatesEntry(value, locked, runner) {
  const g = value === null ? {} : keysOf("gates", value, GATE_KEYS);
  const args = g["core-app-names"];
  if (args !== undefined) {
    if (!Array.isArray(args) || args.length === 0 || args.some((a) => typeof a !== "string" || a === "" || a.includes("\n"))) {
      fail("gates.core-app-names must be a list of the script's arguments");
    }
  }
  if (g.duplication !== undefined && typeof g.duplication !== "boolean") fail("gates.duplication must be true or false");
  if (!locked.has(`${OWNER}/contracts`)) fail(`gates: ${OWNER}/contracts has no line in .github/catenahq.lock`);
  return {
    name: "gates",
    kind: "gates",
    "runs-on": runner,
    timeout: TIMEOUT_DEFAULT,
    "go-cache": false,
    inputs: ["."],
    tools: { ...tools("gates", undefined), node: GATES_NODE },
    sib: { ...siblings("gates", undefined, locked, []), contracts: "1" },
    gates: { "core-app-names": args ?? [], duplication: g.duplication ?? false },
  };
}

function checkEntry(name, value, locked, secrets, runner, repo, apps) {
  const where = `checks.${name}`;
  if (!CHECK_NAME.test(name)) fail(`${where}: a check name is lowercase letters, digits, - and _`);
  if (name === "gates") fail(`${where}: the name gates belongs to the contracts gates (the top-level gates key)`);
  if (apps && APP_CHECK_NAME.test(name)) fail(`${where}: the names apps-repo and app-<id> belong to the app checks (the top-level apps key)`);
  const c = value === null ? {} : keysOf(where, value, CHECK_KEYS);
  const runsOn = c["runs-on"] ?? runner;
  if (typeof runsOn !== "string" || runsOn === "") fail(`${where}.runs-on must be a runner label`);
  const timeout = c["timeout-minutes"] ?? TIMEOUT_DEFAULT;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 360) fail(`${where}.timeout-minutes must be 1 to 360`);
  const goCache = c["go-cache"] ?? false;
  if (typeof goCache !== "boolean") fail(`${where}.go-cache must be true or false`);
  const paths = inputs(`${where}.inputs`, c.inputs);
  const sib = siblings(`${where}.siblings`, c.siblings, locked, secrets);
  const sibs = Object.keys(sib).filter((s) => sib[s] !== "");
  const toolset = tools(`${where}.tools`, c.tools, { repo, sibs });
  if (goCache && toolset.go === "") fail(`${where}.go-cache needs tools.go: the caches are Go's`);
  return {
    name,
    kind: "check",
    "runs-on": runsOn,
    timeout,
    "go-cache": goCache,
    inputs: paths,
    tools: toolset,
    sib,
    gates: { "core-app-names": [], duplication: false },
  };
}

// The settings of the scan jobs; enabled is false when checks.yml has no scan
// key. own-images is space-separated, as the scan action reads it. A scan
// sibling takes no token: the scan jobs hold none.
function scanEntry(value, locked) {
  const s = value === undefined || value === null ? {} : keysOf("scan", value, SCAN_KEYS);
  const profile = s.profile ?? "full";
  if (!SCAN_PROFILES.includes(profile)) fail(`scan.profile must be one of ${SCAN_PROFILES.join(", ")}`);
  const own = s["own-images"] ?? [];
  if (!Array.isArray(own) || own.some((r) => typeof r !== "string" || !/^\S+$/.test(r))) {
    fail("scan.own-images must be a list of image refs");
  }
  if (own.length > 0 && s["image-inputs"] === undefined) {
    fail("scan.own-images needs image-inputs, the git pathspecs the images are built from");
  }
  inputs("scan.image-inputs", s["image-inputs"]);
  return {
    enabled: value !== undefined,
    profile,
    "own-images": own.join(" "),
    "image-inputs": s["image-inputs"] ?? [],
    sib: siblings("scan.siblings", s.siblings, locked, [], ["fetch-depth"]),
    tools: { go: tools("scan.tools", s.tools, { allowed: ["go"] }).go },
  };
}

// The settings of the app checks and their entries: "repo", the apps-repo
// entry, and "app", the entry of a changed app without its name and its
// blueprints/<id>/ input. enabled is false when checks.yml has no apps key.
// With catalog false the tools come from catena-templates at the lock, the
// one sibling the entries read; own-images is space-separated.
function appsSettings(value, locked, runner) {
  const a = value === undefined ? { catalog: false } : keysOf("apps", value, APPS_KEYS);
  if (typeof a.catalog !== "boolean") fail("apps.catalog must be true (the tools of this tree) or false (catena-templates' at the lock)");
  if (!a.catalog && value !== undefined && !locked.has(`${OWNER}/catena-templates`)) {
    fail(`apps.catalog false reads the tools from catena-templates: ${OWNER}/catena-templates has no line in .github/catenahq.lock`);
  }
  const own = a["own-images"] ?? [];
  if (!Array.isArray(own) || own.some((r) => typeof r !== "string" || !IMAGE_NAME.test(r))) {
    fail("apps.own-images must be a list of image names without a tag");
  }
  const entry = (kind, timeout, inputs) => ({
    kind,
    "runs-on": runner,
    timeout,
    "go-cache": false,
    inputs,
    tools: { ...tools("apps", undefined), uv: APPS_UV },
    sib: { ...siblings("apps", undefined, locked, []), "catena-templates": a.catalog ? "" : "1" },
    gates: { "core-app-names": [], duplication: false },
  });
  return {
    enabled: value !== undefined,
    catalog: a.catalog,
    "own-images": own.join(" "),
    repo: { name: "apps-repo", ...entry("apps-repo", TIMEOUT_DEFAULT, APPS_REPO_INPUTS) },
    app: entry("app", APP_TIMEOUT, APP_INPUTS),
  };
}

// The plan of checks.yml (text), given the lock (text), the secret names
// pr.yml declares, the default runner label and the caller's repository name:
// the matrix include list, the scan settings and the app settings. Throws an
// Error naming the key on anything it refuses.
export function buildMatrix({ checks, lock, secrets, runner, repo }) {
  if (typeof runner !== "string" || runner === "") fail("--runner needs a runner label");
  if (typeof repo !== "string" || !REPO_NAME.test(repo)) fail("--repo needs the caller's repository name");
  const doc = keysOf(".github/checks.yml", parse(checks) ?? {}, ["gates", "checks", "scan", "apps"]);
  const locked = lockedRepos(lock);
  const apps = appsSettings(doc.apps, locked, runner);
  const include = [];
  if (doc.gates !== undefined) include.push(gatesEntry(doc.gates, locked, runner));
  if (doc.checks !== undefined) {
    if (!isMap(doc.checks)) fail("checks must be a mapping of check names");
    for (const [name, value] of Object.entries(doc.checks)) {
      include.push(checkEntry(name, value, locked, secrets, runner, repo, apps.enabled));
    }
  }
  if (apps.enabled) include.push(apps.repo);
  if (include.length === 0) fail(".github/checks.yml names no gates, no check and no apps");
  return { include, scan: scanEntry(doc.scan, locked), apps };
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? "" : argv[i + 1];
  };
  const read = (path) => {
    try {
      return readFileSync(path, "utf-8");
    } catch (e) {
      if (e.code === "ENOENT") fail(`${path} is missing`);
      throw e;
    }
  };
  const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf-8");
  const matrix = buildMatrix({
    checks: read(".github/checks.yml"),
    lock: read(".github/catenahq.lock"),
    secrets: declaredSecrets(workflow),
    runner: arg("--runner"),
    repo: arg("--repo"),
  });
  console.log(JSON.stringify(matrix));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`::error::checks-matrix: ${e.message}`);
    process.exit(1);
  }
}
