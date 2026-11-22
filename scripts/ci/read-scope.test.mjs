// read-scope.mjs with a gh stub on PATH: gh answers `gh api <path>` (raw with
// the raw media type) and `gh pr list` from a JSON state file. Run with
// `node scripts/ci/read-scope.test.mjs` after `npm ci --prefix scripts/ci`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "read-scope.mjs");
const work = mkdtempSync(join(tmpdir(), "catena-read-scope-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

// gh api <path>: state.get[path], or state.raw[path] with the raw media type;
// gh pr list: state.open. state.fail lists path fragments that answer an error.
writeFileSync(
  join(bin, "gh"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const args = process.argv.slice(2);
if (process.env.GH_TOKEN !== "tok") process.exit(4);
if (args[0] === "pr" && args[1] === "list") { console.log(JSON.stringify(state.open || [])); process.exit(0); }
if (args[0] !== "api") process.exit(2);
const path = args[1];
if ((state.fail || []).some((f) => path.includes(f))) { console.error("gh: HTTP 500"); process.exit(1); }
const raw = args[2] === "-H" && args[3] === "Accept: application/vnd.github.raw+json";
const answer = raw ? (state.raw || {})[path] : (state.get || {})[path];
if (answer === undefined) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
process.stdout.write(raw ? answer : JSON.stringify(answer));
`,
);
chmodSync(join(bin, "gh"), 0o755);

const REPO = "catenahq/demo";
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const lock = (sha) => `repos/${REPO}/contents/.github/catenahq.lock?ref=${sha}`;
const line = (repo) => `${repo} ${"a".repeat(40)} # main`;

let n = 0;
function exec(args, state = {}) {
  const dir = join(work, `run${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "output"), "");
  const r = spawnSync(process.execPath, [SCRIPT, "--repo", REPO, ...args], {
    encoding: "utf-8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, GH_TOKEN: "tok", STUB_STATE: join(dir, "state.json"), GITHUB_OUTPUT: join(dir, "output") },
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr, output: readFileSync(join(dir, "output"), "utf-8") };
}
const forPull = ["--pr", "7", "--base", BASE, "--head", HEAD];

try {
  // The caller first, then each catenahq repository the base and head locks
  // and the body name, once; another owner and a malformed line are left out.
  const state = {
    raw: {
      [lock(BASE)]: [line("catenahq/ops"), line("other/ops"), "# comment", "catenahq/docs main", ""].join("\n"),
      [lock(HEAD)]: [line("CatenaHQ/Catena-Admin"), line("catenahq/ops"), line("catenahq/demo")].join("\n"),
    },
    get: { [`repos/${REPO}/pulls/7`]: { body: "Depends-on: catenahq/website#3\nDepends-on: catenahq/ops#9\nDepends-on: other/x#1" } },
  };
  let r = exec(forPull, state);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "demo,catena-admin,ops,website");
  assert.equal(r.output, "repositories=demo,catena-admin,ops,website\n");

  // No lock at either commit (404) and no Depends-on: the caller alone.
  r = exec(forPull, { get: { [`repos/${REPO}/pulls/7`]: { body: null } } });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "demo");

  // --open: the Depends-on lines of every open pull request.
  r = exec(["--open"], { open: [{ body: "Depends-on: catenahq/ops#1" }, { body: "" }, { body: "Depends-on: catenahq/docs#2\nDepends-on: catenahq/ops#3" }] });
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, "demo,docs,ops");

  // More than 15 repositories fail, and write nothing.
  const many = Array.from({ length: 15 }, (_, i) => `Depends-on: catenahq/r${i}#1`).join("\n");
  r = exec(["--open"], { open: [{ body: many }] });
  assert.equal(r.status, 1, r.err);
  assert.ok(r.err.includes("16 repositories to read, more than 15"), r.err);
  assert.equal(r.output, "");
  r = exec(["--open"], { open: [{ body: many.split("\n").slice(1).join("\n") }] });
  assert.equal(r.status, 0, "15 is the cap");

  // A failed read fails: an unread lock is never "no repository".
  for (const fail of ["catenahq.lock?ref=" + HEAD, "pulls/7"]) {
    r = exec(forPull, { ...state, fail: [fail] });
    assert.equal(r.status, 1, `${fail}: ${r.err}`);
    assert.ok(r.err.includes("::error::read-scope: gh api"), r.err);
    assert.equal(r.output, "");
  }

  // Bad arguments exit 2.
  for (const args of [[], ["--pr", "7"], ["--pr", "7", "--base", BASE, "--head", "x"], ["--open", "--pr", "7"], ["--bogus"]]) {
    assert.equal(exec(args).status, 2, `${args}`);
  }
  const noRepo = spawnSync(process.execPath, [SCRIPT, "--open"], { encoding: "utf-8" });
  assert.equal(noRepo.status, 2);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("read-scope: ok");
