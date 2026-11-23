// validate-json.mjs, run over a scratch tree holding host-layout/layout.json. Run with
// `node scripts/validate-json.test.mjs`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAYOUT = JSON.parse(readFileSync(join(HERE, "..", "host-layout", "layout.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "catena-validate-json-test-"));

mkdirSync(join(work, "scripts"));
copyFileSync(join(HERE, "validate-json.mjs"), join(work, "scripts", "validate-json.mjs"));
for (const dir of ["brand", "pricing", "legal", "default-apps", "host-layout"]) mkdirSync(join(work, dir));

const run = (layout) => {
  writeFileSync(join(work, "host-layout", "layout.json"), JSON.stringify(layout));
  const r = spawnSync(process.execPath, [join(work, "scripts", "validate-json.mjs")], { encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
};
const changed = (edit) => {
  const copy = structuredClone(LAYOUT);
  edit(copy);
  return copy;
};

const bad = [
  ["a relative path", (l) => (l.files.release = "var/lib/catena/release.json"), "files.release: must be an absolute, clean path"],
  ["a trailing slash", (l) => (l.data_folders.apps = "/srv/catena/apps/"), "data_folders.apps: must be an absolute, clean path"],
  ["a dot segment", (l) => (l.backup_set[4] = "/etc/./ssh"), "backup_set[4]: must be an absolute, clean path"],
  ["the filesystem root", (l) => l.machine_trees.push("/"), "must be an absolute, clean path below /"],
  ["a value twice among the named paths", (l) => (l.files.preflight = l.files.release), "is also files.release"],
  ["a value twice in a list", (l) => l.data_trees.push("/srv/catena/apps"), "data_trees: /srv/catena/apps appears twice"],
  ["a data folder outside the data root", (l) => (l.data_folders.apps = "/srv/other/apps"), "data_folders.apps: /srv/other/apps is not under roots.data"],
  ["a file outside the config and state roots", (l) => (l.files.release = "/opt/catena/release.json"), "files.release: /opt/catena/release.json is not under roots.config"],
  ["a data root missing from the machine trees", (l) => (l.machine_trees = l.machine_trees.filter((t) => t !== "/srv/catena")), "machine_trees must hold roots.data"],
  ["a data tree outside the machine trees", (l) => l.data_trees.push("/opt/data"), "data_trees: /opt/data is not under a machine_trees entry"],
  ["a backup path under the data root that is no data folder", (l) => l.backup_set.push("/srv/catena/extra"), "backup_set: /srv/catena/extra is under roots.data and is not one of data_folders"],
  ["a missing key", (l) => delete l.roots.state, "roots missing state"],
];

try {
  let r = run(LAYOUT);
  assert.equal(r.status, 0, r.out);
  assert.ok(r.out.includes("ok   host-layout/layout.json"), r.out);

  // A backup path outside the data root is not held to the data folders.
  r = run(changed((l) => l.backup_set.push("/opt/anything")));
  assert.equal(r.status, 0, r.out);

  for (const [name, edit, message] of bad) {
    r = run(changed(edit));
    assert.equal(r.status, 1, `${name}: ${r.out}`);
    assert.ok(r.out.includes(message), `${name}: ${r.out}`);
  }
  console.log("validate-json tests passed");
} finally {
  rmSync(work, { recursive: true, force: true });
}
