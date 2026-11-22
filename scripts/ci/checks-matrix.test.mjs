// checks-matrix.mjs over the checks.yml of ci-runner, catena-admin and ops,
// their scan settings, the app checks, and each key it refuses. Run with `node scripts/ci/checks-matrix.test.mjs`
// after `npm ci --prefix scripts/ci`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMatrix, declaredSecrets, declaresApps, SIBLINGS } from "./checks-matrix.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "checks-matrix.mjs");
const PR_YML = readFileSync(join(HERE, "../../.github/workflows/pr.yml"), "utf-8");

const LOCK = {
  "ci-runner": "catenahq/contracts 131ab7ee507055641860b5a8e90da5c47cfefacf # main\n",
  "catena-admin": [
    "catenahq/catena-ce a7be66d3277666c4a6f5339ef456bc4f95ce2065 # dev",
    "catenahq/catena-templates 5ab277dc23d11593f0c39534192ee99c68ba00cd # main",
    "catenahq/contracts 131ab7ee507055641860b5a8e90da5c47cfefacf # main",
  ].join("\n"),
  ops: [
    "# siblings of ops",
    "catenahq/catena-admin 5c776b55ff9fd85be5d59d91b006430008da0464 # dev",
    "catenahq/catena-ce a7be66d3277666c4a6f5339ef456bc4f95ce2065 # dev",
    "",
    "catenahq/catena-templates 5ab277dc23d11593f0c39534192ee99c68ba00cd # main",
    "catenahq/contracts 131ab7ee507055641860b5a8e90da5c47cfefacf # main",
    "catenahq/docs 30a84641265728af1d606c7701c5fdc367141763 # dev",
  ].join("\n"),
};

const CHECKS = {
  "ci-runner": `gates: {}
checks:
  python:
    tools: {uv: 0.13.9}
    inputs: [src/, tests/, pyproject.toml, uv.lock, .python-version]
`,
  "catena-admin": `gates:
  core-app-names: [--exclude, central/, .]
  duplication: true
checks:
  go:
    timeout-minutes: 40
    tools: {go: go.mod}
    go-cache: true
    siblings: {catena-ce: {fetch-depth: 0}, catena-templates: {}, contracts: {}}
    inputs: [.]
  staticcheck:   # report-only: ci/run exits 0 with a warning
    tools: {go: go.mod, staticcheck: {version: 2026.2.2, sha256: 14c081e0f0d05b5a4d4c53fd3d357d4a5af9d20501465fefc9024ee828d3aa5c}}
    inputs: ['*.go', '**/*.go', go.mod, go.sum]
scan:
  profile: full
  own-images: [catena-admin:ci]
  image-inputs: [Dockerfile, go.mod, go.sum, scripts/vendor-catena-ce.sh, scanctl.yml, .scanctl/]
  siblings: {catena-ce: {fetch-depth: 0}}
  tools: {go: go.mod}
`,
  ops: `gates:
  duplication: true
checks:
  python:
    timeout-minutes: 40
    tools: {uv: 0.13.9}
    siblings:
      catena-admin: {token: CATENA_EE_READ_TOKEN}
      catena-ce: {}
      catena-templates: {}
      contracts: {}
      docs: {}
    inputs: [.]
  audit:
    tools: {uv: 0.13.9, go: 1.26.10}
    siblings:
      catena-admin: {token: CATENA_EE_READ_TOKEN}
      catena-ce: {}
      catena-templates: {}
    inputs: [.]
`,
};

const NO_TOOLS = { node: "", uv: "", go: "", "go-file": "", staticcheck: "", "staticcheck-sha256": "" };
const NO_SIB = Object.fromEntries(SIBLINGS.map((s) => [s, ""]));
const NO_GATES = { "core-app-names": [], duplication: false };
const NO_SCAN = { enabled: false, profile: "full", "own-images": "", "image-inputs": [], sib: NO_SIB, tools: { go: "" } };
const APP_TOOLS = ["build/", "lib/", "pyproject.toml", "uv.lock", "app.schema.json", "block.schema.json"];
// The entries of the app checks, with catena-templates checked out at depth
// templates ("" for the catalog itself, whose tools are its own).
const appEntries = (templates) => {
  const common = {
    "runs-on": "catena-ci", "go-cache": false, tools: { ...NO_TOOLS, uv: "0.13.9" },
    sib: { ...NO_SIB, "catena-templates": templates }, gates: NO_GATES,
  };
  return {
    repo: { name: "apps-repo", kind: "apps-repo", timeout: 20, inputs: ["blueprints/", ...APP_TOOLS], ...common },
    app: { kind: "app", timeout: 60, inputs: [...APP_TOOLS, ".clamav-allow.sfp", ".scanctl/"], ...common },
  };
};
const NO_APPS = { enabled: false, catalog: false, "own-images": "", ...appEntries("1") };
const matrix = (repo, extra = {}) =>
  buildMatrix({ checks: CHECKS[repo], lock: LOCK[repo], secrets: [], runner: "catena-ci", repo, ...extra });
const refuses = (extra, message, repo = "ci-runner") =>
  assert.throws(() => matrix(repo, extra), (e) => {
    assert.ok(e.message.includes(message), `want "${message}", got "${e.message}"`);
    return true;
  });

// pr.yml declares the one secret a check fetches a private sibling with.
assert.deepEqual(declaredSecrets(PR_YML), ["CATENA_EE_READ_TOKEN"]);
assert.deepEqual(
  declaredSecrets("on:\n  workflow_call:\n    secrets:\n      CATENA_EE_READ_TOKEN:\n        required: false\n"),
  ["CATENA_EE_READ_TOKEN"],
);

// ci-runner: the contracts gates and its python check, on the runner input.
assert.deepEqual(matrix("ci-runner"), {
  include: [
    {
      name: "gates", kind: "gates", "runs-on": "catena-ci", timeout: 20, "go-cache": false, inputs: ["."],
      tools: { ...NO_TOOLS, node: "26" }, sib: { ...NO_SIB, contracts: "1" }, gates: NO_GATES,
    },
    {
      name: "python", kind: "check", "runs-on": "catena-ci", timeout: 20, "go-cache": false,
      inputs: ["src/", "tests/", "pyproject.toml", "uv.lock", ".python-version"],
      tools: { ...NO_TOOLS, uv: "0.13.9" }, sib: NO_SIB, gates: NO_GATES,
    },
  ],
  scan: NO_SCAN,
  apps: NO_APPS,
});

// catena-admin: gate arguments, a deep sibling, Go from go.mod, staticcheck by
// its checksum, a check's own runner, and a scan with an own image.
{
  const { include: [gates, go, staticcheck], scan } = matrix("catena-admin");
  assert.deepEqual(scan, {
    enabled: true, profile: "full", "own-images": "catena-admin:ci",
    "image-inputs": ["Dockerfile", "go.mod", "go.sum", "scripts/vendor-catena-ce.sh", "scanctl.yml", ".scanctl/"],
    sib: { ...NO_SIB, "catena-ce": "0" }, tools: { go: "go.mod" },
  });
  assert.deepEqual(gates.gates, { "core-app-names": ["--exclude", "central/", "."], duplication: true });
  assert.deepEqual(go, {
    name: "go", kind: "check", "runs-on": "catena-ci", timeout: 40, "go-cache": true, inputs: ["."],
    tools: { ...NO_TOOLS, go: "go.mod", "go-file": "ws/catena-admin/go.mod" },
    sib: { ...NO_SIB, "catena-ce": "0", "catena-templates": "1", contracts: "1" },
    gates: NO_GATES,
  });
  assert.deepEqual(staticcheck.tools, {
    ...NO_TOOLS, go: "go.mod", "go-file": "ws/catena-admin/go.mod", staticcheck: "2026.2.2",
    "staticcheck-sha256": "14c081e0f0d05b5a4d4c53fd3d357d4a5af9d20501465fefc9024ee828d3aa5c",
  });
  const own = buildMatrix({
    checks: "checks:\n  go:\n    runs-on: ubuntu-26.04\n", lock: "", secrets: [], runner: "catena-ci", repo: "catena-admin",
  });
  assert.equal(own.include[0]["runs-on"], "ubuntu-26.04");
  assert.deepEqual(own.include[0].inputs, ["."], "a check that names no inputs reads the whole tree");
  assert.deepEqual(staticcheck.inputs, ["*.go", "**/*.go", "go.mod", "go.sum"]);
}

// ops: a token sibling needs the secret declared in pr.yml; declared, it is a bundle.
refuses({}, "checks.python.siblings.catena-admin.token: CATENA_EE_READ_TOKEN is not a secret pr.yml declares", "ops");
{
  const [gates, python, audit] = matrix("ops", { secrets: ["CATENA_EE_READ_TOKEN"] }).include;
  assert.deepEqual(gates.gates, { "core-app-names": [], duplication: true });
  assert.deepEqual(python.sib, { "catena-admin": "bundle", "catena-ce": "1", "catena-templates": "1", contracts: "1", docs: "1", ops: "" });
  assert.equal(python.timeout, 40);
  assert.deepEqual(audit.tools, { ...NO_TOOLS, uv: "0.13.9", go: "1.26.10" });
}

// Go from a declared sibling's go.mod, a bundle sibling's included; a sibling
// the check does not declare is refused.
{
  const plan = (body) =>
    buildMatrix({ checks: body, lock: LOCK.ops, secrets: ["CATENA_EE_READ_TOKEN"], runner: "catena-ci", repo: "ops" });
  const bundled = plan("checks:\n  audit:\n    tools: {go: catena-admin/go.mod}\n    siblings: {catena-admin: {token: CATENA_EE_READ_TOKEN}}\n");
  assert.deepEqual(bundled.include[0].tools, { ...NO_TOOLS, go: "catena-admin/go.mod", "go-file": "ws/catena-admin/go.mod" });
  assert.equal(bundled.include[0].sib["catena-admin"], "bundle");
  const own = plan("checks:\n  audit:\n    tools: {go: go.mod}\n    siblings: {catena-ce: {}}\n");
  assert.equal(own.include[0].tools["go-file"], "ws/ops/go.mod");
  assert.throws(
    () => plan("checks:\n  audit:\n    tools: {go: catena-admin/go.mod}\n    siblings: {catena-ce: {}}\n"),
    /checks\.audit\.tools\.go must be go\.mod, <sibling>\/go\.mod of a sibling the check declares/,
  );
  assert.throws(
    () => plan("checks:\n  audit:\n    tools: {go: catena-admin/go.mod}\n    siblings: {catena-admin: {}}\n    inputs: [.]\n" +
      "scan:\n  tools: {go: catena-admin/go.mod}\n  siblings: {catena-admin: {}}\n"),
    /scan\.tools\.go must be go\.mod or an exact version/,
  );
}

// An empty scan key scans the tree with profile full and builds no image.
{
  const { scan } = matrix("ci-runner", { checks: "gates: {}\nscan:\n" });
  assert.deepEqual(scan, { ...NO_SCAN, enabled: true });
  const sellable = matrix("ci-runner", { checks: "gates: {}\nscan: {profile: sellable}\n" });
  assert.equal(sellable.scan.profile, "sellable");
}

// apps: the catalog's own tools, or catena-templates' at the lock; the
// apps-repo entry joins the matrix and app is the entry of each changed app.
{
  const catalog = matrix("ci-runner", { checks: "gates: {}\napps: {catalog: true}\n" });
  assert.deepEqual(catalog.include.map((e) => e.name), ["gates", "apps-repo"]);
  assert.deepEqual(catalog.include[1], appEntries("").repo);
  assert.deepEqual(catalog.apps, { enabled: true, catalog: true, "own-images": "", ...appEntries("") });
  const folder = matrix("ops", {
    checks: "apps:\n  catalog: false\n  own-images: [ghcr.io/catenahq/repertoire, ghcr.io/catenahq/catena-reports]\n",
  });
  assert.deepEqual(folder.include, [appEntries("1").repo], "apps alone is a plan");
  assert.deepEqual(folder.apps, {
    enabled: true, catalog: false, "own-images": "ghcr.io/catenahq/repertoire ghcr.io/catenahq/catena-reports", ...appEntries("1"),
  });
  // A check of another name than the app entries' stays a check.
  const named = matrix("ci-runner", { checks: "checks:\n  app-ci: {}\n  apps: {}\n" });
  assert.deepEqual(named.include.map((e) => [e.name, e.kind]), [["app-ci", "check"], ["apps", "check"]]);
  // declaresApps, the answer every reader that waits for app-tests uses, is
  // the plan's apps.enabled.
  for (const checks of ["gates: {}\napps: {catalog: true}\n", "gates: {}\n", CHECKS["ci-runner"], "checks:\n  apps: {}\n"]) {
    assert.equal(declaresApps(checks), matrix("ci-runner", { checks }).apps.enabled, checks);
  }
  assert.equal(declaresApps(""), false, "an empty checks.yml");
}

// Each refusal names its key.
const ci = (body) => ({ checks: body });
refuses(ci("apps:\n"), "apps must be a mapping");
refuses(ci("apps: {}\n"), "apps.catalog must be true (the tools of this tree) or false");
refuses(ci("apps: {catalog: 'yes'}\n"), "apps.catalog must be true");
refuses(ci("apps: {catalog: true, tools: {uv: 0.13.9}}\n"), "apps: unknown key 'tools'");
refuses(ci("apps: {catalog: false}\n"), "apps.catalog false reads the tools from catena-templates: catenahq/catena-templates has no line");
refuses(ci("apps: {catalog: true, own-images: [ghcr.io/catenahq/repertoire:1.0]}\n"), "apps.own-images must be a list of image names without a tag");
refuses(ci("apps: {catalog: true, own-images: ghcr.io/catenahq/repertoire}\n"), "apps.own-images must be a list");
refuses(ci("apps: {catalog: true}\nchecks:\n  app-web: {}\n"), "checks.app-web: the names apps-repo and app-<id> belong to the app checks");
refuses(ci("apps: {catalog: true}\nchecks:\n  apps-repo: {}\n"), "checks.apps-repo: the names apps-repo and app-<id> belong to the app checks");
refuses(ci("gates: {}\nlint: {}\n"), ".github/checks.yml: unknown key 'lint'");
refuses(ci("gates: {}\nscan: {no-gate: true}\n"), "scan: unknown key 'no-gate'");
refuses(ci("gates: {}\nscan: [full]\n"), "scan must be a mapping");
refuses(ci("gates: {}\nscan: {profile: fast}\n"), "scan.profile must be one of full, sellable");
refuses(ci("gates: {}\nscan: {own-images: [app:ci]}\n"), "scan.own-images needs image-inputs");
refuses(ci("gates: {}\nscan: {own-images: app:ci, image-inputs: [Dockerfile]}\n"), "scan.own-images must be a list of image refs");
refuses(ci("gates: {}\nscan: {own-images: ['app :ci'], image-inputs: [Dockerfile]}\n"), "scan.own-images must be a list of image refs");
refuses(ci("gates: {}\nscan: {own-images: [app:ci], image-inputs: Dockerfile}\n"), "scan.image-inputs must be a list of git pathspecs");
refuses(ci("gates: {}\nscan: {siblings: {catena-ce: {}}}\n"), "scan.siblings.catena-ce: catenahq/catena-ce has no line in .github/catenahq.lock");
refuses(ci("gates: {}\nscan: {tools: {uv: 0.13.9}}\n"), "scan.tools: unknown key 'uv'");
refuses(ci("gates: {}\nscan: {tools: {go: '1.26'}}\n"), "scan.tools.go must be go.mod or an exact version");
refuses(
  { checks: "gates: {}\nscan: {siblings: {catena-admin: {token: CATENA_EE_READ_TOKEN}}}\n", secrets: ["CATENA_EE_READ_TOKEN"] },
  "scan.siblings.catena-admin: unknown key 'token'",
  "ops",
);
refuses(ci("checks:\n  python:\n    command: make\n"), "checks.python: unknown key 'command'");
refuses(ci("checks:\n  python:\n    tools: {python: 3.13.0}\n"), "checks.python.tools: unknown key 'python'");
refuses(ci("checks:\n  python:\n    tools: {uv: latest}\n"), "checks.python.tools.uv must be an exact version");
refuses(ci("checks:\n  python:\n    tools: {node: '26'}\n"), "checks.python.tools.node must be an exact version");
refuses(ci("checks:\n  go:\n    tools: {go: '1.26'}\n"), "checks.go.tools.go must be go.mod, <sibling>/go.mod of a sibling the check declares, or an exact version");
refuses(ci("checks:\n  sc:\n    tools: {staticcheck: {version: 2026.2.2}}\n"), "checks.sc.tools.staticcheck.sha256 must be");
refuses(ci("checks:\n  sc:\n    tools: {staticcheck: {version: 2026.2.2, sha256: x, url: y}}\n"), "checks.sc.tools.staticcheck: unknown key 'url'");
refuses(ci("checks:\n  python:\n    siblings: {website: {}}\n"), "checks.python.siblings: unknown sibling 'website'");
refuses(ci("checks:\n  python:\n    siblings: {catena-ce: {}}\n"), "checks.python.siblings.catena-ce: catenahq/catena-ce has no line in .github/catenahq.lock");
refuses(ci("checks:\n  python:\n    siblings: {contracts: {depth: 0}}\n"), "checks.python.siblings.contracts: unknown key 'depth'");
refuses(ci("checks:\n  python:\n    siblings: {contracts: {fetch-depth: -1}}\n"), "checks.python.siblings.contracts.fetch-depth must be");
refuses(ci("checks:\n  python:\n    siblings: {contracts: {token: GH_TOKEN}}\n"), "checks.python.siblings.contracts.token: GH_TOKEN is not a secret pr.yml declares");
refuses(ci("checks:\n  gates: {}\n"), "checks.gates: the name gates belongs to the contracts gates");
refuses(ci("checks:\n  Python: {}\n"), "checks.Python: a check name is");
refuses(ci("checks:\n  python:\n    timeout-minutes: 0\n"), "checks.python.timeout-minutes must be 1 to 360");
refuses(ci("checks:\n  python:\n    go-cache: yes\n"), "checks.python.go-cache must be true or false");
refuses(ci("checks:\n  python:\n    go-cache: true\n    tools: {uv: 0.13.9}\n"), "checks.python.go-cache needs tools.go");
refuses(ci("checks:\n  python:\n    inputs: src/\n"), "checks.python.inputs must be a list of git pathspecs");
refuses(ci("checks: [python]\n"), "checks must be a mapping of check names");
refuses(ci("gates:\n  prose: false\n"), "gates: unknown key 'prose'");
refuses(ci("gates:\n  core-app-names: .\n"), "gates.core-app-names must be a list");
refuses(ci("gates:\n  duplication: 1\n"), "gates.duplication must be true or false");
refuses({ checks: "gates: {}\n", lock: "" }, "gates: catenahq/contracts has no line in .github/catenahq.lock");
refuses({ lock: "catenahq/contracts main\n" }, ".github/catenahq.lock: malformed line 'catenahq/contracts main'");
refuses(ci(""), ".github/checks.yml names no gates, no check and no apps");
refuses({ runner: "" }, "--runner needs a runner label");
refuses({ repo: "" }, "--repo needs the caller's repository name");
refuses({ repo: "catenahq/ops" }, "--repo needs the caller's repository name");

// The command reads the files of the current directory and prints one line of JSON.
const work = mkdtempSync(join(tmpdir(), "catena-checks-matrix-test-"));
const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, encoding: "utf-8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
};
try {
  const args = ["--repo", "ci-runner", "--runner", "catena-ci"];
  let r = run(...args);
  assert.equal(r.status, 1, r.err);
  assert.ok(r.err.includes("::error::checks-matrix: .github/checks.yml is missing"), r.err);

  mkdirSync(join(work, ".github"));
  writeFileSync(join(work, ".github/checks.yml"), CHECKS["ci-runner"]);
  writeFileSync(join(work, ".github/catenahq.lock"), LOCK["ci-runner"]);
  r = run(...args);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.trim().split("\n").length, 1, r.out);
  assert.deepEqual(JSON.parse(r.out), matrix("ci-runner"));

  r = run("--repo", "ci-runner");
  assert.equal(r.status, 1, r.err);
  assert.ok(r.err.includes("--runner needs a runner label"), r.err);
  r = run("--runner", "catena-ci");
  assert.equal(r.status, 1, r.err);
  assert.ok(r.err.includes("--repo needs the caller's repository name"), r.err);

  writeFileSync(join(work, ".github/checks.yml"), "checks:\n  python:\n    tools: {uv: 0.13.9, rust: 1.0.0}\n");
  r = run(...args);
  assert.equal(r.status, 1, r.err);
  assert.ok(r.err.includes("checks.python.tools: unknown key 'rust'"), r.err);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("checks-matrix: ok");
