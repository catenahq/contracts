// check-repo-rules.mjs, run over a scratch repo. Run with
// `node scripts/check-repo-rules.test.mjs`.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-repo-rules.mjs");
const work = mkdtempSync(join(tmpdir(), "catena-repo-rules-test-"));

const git = (...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: work, stdio: "pipe" });
const put = (path, body) => {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), body);
  git("add", "-f", path);
};
const run = () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: work, encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
};

try {
  git("init", "-q");
  put(".gitignore", "*.env\n.env.*\n!*.env.example\n");
  put("README.md", "x\n");
  let r = run();
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes("Repo rules: clean"), r.out);

  // A file whose name only starts like the directory is not under it.
  put(".agent-notes.md", "x\n");
  put("src/.agent/plan.md", "x\n");
  r = run();
  assert.equal(r.status, 0, r.out);

  // Any tracked file under .agent/ fails and is named.
  put(".agent/plan.md", "plan\n");
  put(".agent/notes/n.md", "notes\n");
  r = run();
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes(".agent/plan.md is tracked as .agent"), r.out);
  assert.ok(r.out.includes(".agent/notes/n.md is tracked as .agent"), r.out);

  // A non-ASCII name, which git quotes unless asked for -z, is still named.
  put(".agent/café.md", "x\n");
  r = run();
  assert.ok(r.out.includes(".agent/café.md is tracked as .agent"), r.out);

  // Untracked, the files pass.
  git("rm", "-q", "--cached", ".agent/plan.md", ".agent/notes/n.md", ".agent/café.md");
  r = run();
  assert.equal(r.status, 0, r.out);

  // A root file named .agent fails too.
  rmSync(join(work, ".agent"), { recursive: true });
  put(".agent", "x\n");
  r = run();
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes(".agent is tracked as .agent"), r.out);
  git("rm", "-q", "--cached", ".agent");
  rmSync(join(work, ".agent"));

  // .agents files that are repo content, and names that only look like the state paths, pass.
  put(".agents/AGENTS.md", "x\n");
  put(".agents-notes.md", "x\n");
  put(".agents/loop-state-notes.md", "x\n");
  put("src/.agents/tmp/x", "x\n");
  r = run();
  assert.equal(r.status, 0, r.out);

  // Tracked aidevops runtime state fails and is named.
  put(".agents/loop-state/x", "x\n");
  put(".agents/tmp/y/z", "x\n");
  put(".agents/memory/m.db", "x\n");
  put(".agents/.full-loop-cleanup-deferred", "x\n");
  r = run();
  assert.equal(r.status, 1, r.out);
  for (const f of [".agents/loop-state/x", ".agents/tmp/y/z", ".agents/memory/m.db", ".agents/.full-loop-cleanup-deferred"]) {
    assert.ok(r.out.includes(`${f} is tracked aidevops runtime state`), r.out);
  }
  assert.ok(!r.out.includes(".agents/AGENTS.md"), r.out);

  // Untracked, the state passes.
  git("rm", "-q", "--cached", ".agents/loop-state/x", ".agents/tmp/y/z", ".agents/memory/m.db", ".agents/.full-loop-cleanup-deferred");
  r = run();
  assert.equal(r.status, 0, r.out);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("check-repo-rules: ok");
