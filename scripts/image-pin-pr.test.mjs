// The image-pin-pr action's script, run against a local bare repository as the
// remote (IMAGE_PIN_PR_REMOTE_BASE) and a gh stub on PATH. The stub appends
// each call to a log and answers the default-branch and pr-list queries from
// GH_STUB_DEFAULT and GH_STUB_PR. Run with `node scripts/image-pin-pr.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "actions", "image-pin-pr", "image-pin-pr.sh");
const work = mkdtempSync(join(tmpdir(), "catena-image-pin-pr-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env bash
echo "$*" >> "$GH_STUB_LOG"
case "$*" in
  "pr list"*) echo "$GH_STUB_PR" ;;
  "api repos/"*"--jq .default_branch") echo "$GH_STUB_DEFAULT" ;;
esac
`,
);
chmodSync(join(bin, "gh"), 0o755);

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const IMAGE = "ghcr.io/catenahq/catena-reports";
const OLD = "0.12.0";
const files = {
  "blueprints/a/services.yml": `image: ${IMAGE}:v${OLD}\nother: ghcr.io/catenahq/other:1.2.3\n`,
  "blueprints/a/app.json": `{"image": "${IMAGE}:${OLD}"}\n`,
  "blueprints/a/unnamed.yml": `image: ${IMAGE}:v${OLD}\n`,
};

let n = 0;
// A fresh remote holding `files`, then one run of the script.
function run({ version, pr = "", named = ["blueprints/a/services.yml", "blueprints/a/app.json"] }) {
  const root = join(work, `case${n++}`);
  const base = join(root, "remote");
  const bare = join(base, "o", "templates.git");
  mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", "trunk");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "trunk");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), text);
  }
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "seed");
  git(seed, "push", "-q", bare, "trunk");
  const log = join(root, "gh.log");
  writeFileSync(log, "");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: root,
      RUNNER_TEMP: root,
      GH_TOKEN: "tok",
      GH_STUB_LOG: log,
      GH_STUB_PR: pr,
      GH_STUB_DEFAULT: "trunk",
      IMAGE_PIN_PR_REMOTE_BASE: `file://${base}`,
      IPP_REPOSITORY: "o/templates",
      IPP_APP: "reports",
      IPP_IMAGE: IMAGE,
      IPP_VERSION: version,
      IPP_FILES: named.join("\n") + "\n",
      IPP_BODY: "the body",
    },
  });
  const calls = readFileSync(log, "utf-8").split("\n").filter(Boolean);
  const pinned = (path) => {
    const t = spawnSync("git", ["show", `image-pin/reports:${path}`], { cwd: bare, encoding: "utf-8" });
    return t.status === 0 ? t.stdout : null;
  };
  const branch = spawnSync("git", ["rev-parse", "--verify", "-q", "image-pin/reports"], { cwd: bare }).status === 0;
  const subject = branch ? git(bare, "log", "-1", "--format=%s", "image-pin/reports") : null;
  return { r, calls, pinned, branch, subject };
}

try {
  // v-prefixed version: named files move, the unnamed one and other images stay.
  {
    const { r, calls, pinned, subject } = run({ version: "v0.13.0" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pinned("blueprints/a/services.yml"), `image: ${IMAGE}:v0.13.0\nother: ghcr.io/catenahq/other:1.2.3\n`);
    assert.equal(pinned("blueprints/a/app.json"), `{"image": "${IMAGE}:v0.13.0"}\n`);
    assert.equal(pinned("blueprints/a/unnamed.yml"), `image: ${IMAGE}:v${OLD}\n`);
    assert.equal(subject, "chore(reports): pin v0.13.0");
    assert.deepEqual(calls, [
      "pr list --repo o/templates --head image-pin/reports --state open --json number --jq .[0].number // empty",
      "api repos/o/templates --jq .default_branch",
      "pr create --repo o/templates --base trunk --head image-pin/reports --title chore(reports): pin v0.13.0 --body the body",
    ]);
  }

  // Bare version.
  {
    const { r, pinned } = run({ version: "0.13.0" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(pinned("blueprints/a/services.yml"), `image: ${IMAGE}:0.13.0\nother: ghcr.io/catenahq/other:1.2.3\n`);
    assert.equal(pinned("blueprints/a/app.json"), `{"image": "${IMAGE}:0.13.0"}\n`);
  }

  // Already pinned: nothing pushed, no gh call.
  {
    const { r, calls, branch } = run({ version: `v${OLD}`, named: ["blueprints/a/services.yml"] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`o/templates already pins ${IMAGE}:v${OLD}`));
    assert.equal(branch, false);
    assert.deepEqual(calls, []);
  }

  // Open pull request: PATCHed, none created, no default-branch lookup.
  {
    const { r, calls, branch } = run({ version: "v0.13.0", pr: "7" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(branch, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1], "api -X PATCH repos/o/templates/pulls/7 -f title=chore(reports): pin v0.13.0 -f body=the body");
    assert.ok(!calls.some((c) => c.startsWith("pr create")));
    assert.match(r.stdout, /updated https:\/\/github\.com\/o\/templates\/pull\/7/);
  }
  console.log("image-pin-pr: ok");
} finally {
  rmSync(work, { recursive: true, force: true });
}
