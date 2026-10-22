// check-core-app-names.mjs, run over a scratch repo. Run with
// `node scripts/check-core-app-names.test.mjs`.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-core-app-names.mjs");
const work = mkdtempSync(join(tmpdir(), "catena-app-names-test-"));
const DEBT = join(work, ".github", "core-app-names-debt.json");

const git = (...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: work, stdio: "pipe" });
const put = (path, body) => {
  mkdirSync(dirname(join(work, path)), { recursive: true });
  writeFileSync(join(work, path), body);
  git("add", "-A");
};
const run = (...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
};
const debt = () => JSON.parse(readFileSync(DEBT, "utf-8"));

try {
  git("init", "-q");
  mkdirSync(join(work, ".github"));
  put("core/a.yml", "image: nextcloud\nname: Nextcloud\n");
  put("core/b.yml", "image: traefik\nkeycloak postgres catena-admin cloudflared oauth2-proxy gatus healthchecks beszel\n");
  put("outside/c.yml", "nextcloud\n");

  // A repo with no debt file is seeded by --update; paths outside the roots stay out.
  let r = run("core");
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes("core/a.yml: 2 (debt 0)"), r.out);
  r = run("--update", "core");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(debt(), { "core/a.yml": 2 });
  r = run("core");
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes("clean"), r.out);

  // Structural names are ignored (core/b.yml is not in the debt and passes).
  // A raised count fails.
  put("core/a.yml", "image: nextcloud\nname: Nextcloud\nurl: NEXTCLOUD\n");
  r = run("core");
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes("core/a.yml: 3 (debt 2)"), r.out);

  // --update refuses a rise and leaves the file alone.
  r = run("--update", "core");
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(debt(), { "core/a.yml": 2 });

  // A new path fails.
  put("core/a.yml", "image: nextcloud\nname: Nextcloud\n");
  put("core/d.yml", "image: erpnext\n");
  r = run("core");
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes("core/d.yml: 1 (debt 0)"), r.out);
  put("core/d.yml", "image: traefik\n");

  // A fall without --update fails; --update after the fall passes.
  put("core/a.yml", "image: nextcloud\n");
  r = run("core");
  assert.equal(r.status, 1, r.out);
  assert.ok(r.out.includes("core/a.yml: 1 (debt 2)"), r.out);
  r = run("--update", "core");
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(debt(), { "core/a.yml": 1 });
  assert.equal(run("core").status, 0);

  // A path drained to zero leaves the debt file.
  put("core/a.yml", "image: traefik\n");
  assert.equal(run("core").status, 1);
  assert.equal(run("--update", "core").status, 0);
  assert.deepEqual(debt(), {});
  assert.equal(run("core").status, 0);

  // Whole words only, any case; letters and digits attach, other characters do not.
  put("core/w.txt", "mynextcloud nextcloudy xnextcloud1 n8nx\nNEXTCLOUD, nextcloud_dir nextcloud-s3 \"N8N\" (WordPress)\n");
  r = run("core");
  assert.ok(r.out.includes("core/w.txt: 5 (debt 0)"), r.out);
  put("core/w.txt", "mynextcloud nextcloudy\n");
  r = run("core");
  assert.equal(r.status, 0, r.out);

  // The spellings an app goes by besides its name count, each as a whole word;
  // portainer is an app.
  put("core/s.txt", "Rocket.Chat talk-hpb catena-nextcloud_talk-hpb JVB occ clamd clamdscan rspamd Synapse Portainer\n");
  r = run("core");
  assert.ok(r.out.includes("core/s.txt: 11 (debt 0)"), r.out);
  put("core/s.txt", "occupied rocketxchat jvbs preoccupied unsynapse portainers mail server\n");
  r = run("core");
  assert.equal(r.status, 0, r.out);

  assert.ok(existsSync(DEBT));
  assert.equal(run().status, 2);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("check-core-app-names: ok");
