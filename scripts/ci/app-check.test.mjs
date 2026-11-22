// app-plan.sh and app-check.sh over scratch callers with stubs on PATH: uv
// answers each catalog tool command from a JSON state file, docker serves the
// pulls, the app checker's report, an image export and clamscan, git answers
// the change's paths and its base, and scanctl writes a summary. Run with
// `node scripts/ci/app-check.test.mjs` after `npm ci --prefix scripts/ci`.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMatrix } from "./checks-matrix.mjs";
import { fails, ok } from "./run-result.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PLAN = join(HERE, "app-plan.sh");
const APP_CHECK = join(HERE, "app-check.sh");

const work = mkdtempSync(join(tmpdir(), "catena-app-check-test-"));
const bin = join(work, "bin");
mkdirSync(bin);

const STUB_HEAD = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = JSON.parse(fs.readFileSync(process.env.STUB_STATE, "utf-8"));
const args = process.argv.slice(2);
const log = (line) => fs.appendFileSync(process.env.STUB_LOG, line + "\\n");
`;
// uv run <script> <command> [<arg>]: state.uv["<script file> <command> <arg>"],
// else state.uv["<script file> <command>"], else no output and status 0. The
// log names the script's path, the paths piped to scope and changed, and the
// tool environment.
const UV = `${STUB_HEAD}
const [, script, ...rest] = args;
const key = [path.basename(script), ...rest].join(" ");
const piped = ["scope", "changed"].includes(rest[0]) ? " < " + fs.readFileSync(0, "utf-8").trim().split("\\n").join(",") : "";
const own = process.env.PROVENANCE_OWN_IMAGES === undefined ? "" : " own=" + process.env.PROVENANCE_OWN_IMAGES;
log("uv " + [script, ...rest].join(" ") + piped + own + " root=" + process.env.TEMPLATES_ROOT);
const answer = state.uv[key] ?? state.uv[key.split(" ").slice(0, 2).join(" ")] ?? {};
process.stdout.write(answer.out ?? "");
process.stderr.write(answer.err ?? "");
process.exit(answer.status ?? 0);
`;
// docker: pull fails for an image of state.pullFail; run with catena-applint
// prints state.applint[<image>].report and exits with its status; run with
// clamscan logs each listed file, mapping the -v mounts back to the host;
// export writes $STUB_TAR.
const DOCKER = `${STUB_HEAD}
const mounts = {};
args.forEach((a, i) => { if (a === "-v") { const [src, dst] = args[i + 1].split(":"); mounts[dst] = src; } });
switch (args[0]) {
  case "pull":
    log("docker pull " + args[1]);
    if ((state.pullFail ?? []).includes(args[1])) { console.error("pull access denied"); process.exit(1); }
    break;
  case "create":
    log("docker create " + args[1]);
    console.log("cid");
    break;
  case "export":
    process.stdout.write(fs.readFileSync(process.env.STUB_TAR));
    break;
  case "run": {
    const entrypoint = args[args.indexOf("--entrypoint") + 1];
    const image = args[args.indexOf("--entrypoint") + 2];
    if (entrypoint.endsWith("/catena-applint")) {
      log("docker applint " + args.slice(args.indexOf(image)).join(" "));
      const answer = state.applint[image] ?? {};
      process.stdout.write(JSON.stringify(answer.report ?? []));
      process.exit(answer.status ?? 0);
    }
    log("docker clamscan allow=" + mounts["/var/lib/clamav/catena-allow.sfp"]);
    const list = args.find((a) => a.startsWith("--file-list=")).slice("--file-list=/lists/".length);
    for (const line of fs.readFileSync(path.join(mounts["/lists"], list), "utf-8").split("\\n").filter(Boolean)) {
      log("scanned " + line);
    }
    break;
  }
  default:
    log("docker " + args.join(" "));
}
`;
// git: the change's paths (diff --name-only HEAD^1 HEAD) and its base.
const GIT = `${STUB_HEAD}
log("git " + args.join(" "));
if (args.join(" ") === "diff --name-only HEAD^1 HEAD") console.log((state.paths ?? []).join("\\n"));
else if (args.join(" ") === "rev-parse HEAD^1") console.log(state.base);
else process.exit(128);
`;
const SCANCTL = `${STUB_HEAD}
log("scanctl " + args.join(" "));
fs.writeFileSync(args[args.indexOf("-summary") + 1], "scanctl summary\\n");
process.exit(state.scanctl ?? 0);
`;
for (const [name, text] of [["uv", UV], ["docker", DOCKER], ["git", GIT]]) {
  writeFileSync(join(bin, name), text);
  chmodSync(join(bin, name), 0o755);
}

// A ustar archive: a directory, a regular file and a character device (dev/null).
function tarEntry(name, { type = "0", data = Buffer.alloc(0), mode = 0o644, major = 0, minor = 0 } = {}) {
  const h = Buffer.alloc(512);
  const put = (offset, length, text) => h.write(text, offset, length, "latin1");
  const octal = (offset, length, n) => put(offset, length, `${n.toString(8).padStart(length - 1, "0")}\0`);
  put(0, 100, name);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, data.length);
  octal(136, 12, 0);
  h.fill(0x20, 148, 156);
  put(156, 1, type);
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  octal(329, 8, major);
  octal(337, 8, minor);
  const sum = h.reduce((s, b) => s + b, 0);
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const IMAGE_FILES = { "etc/app.conf": "a=1\n", "app/main.js": "run()\n" };
const IMAGE_TAR = Buffer.concat([
  tarEntry("dev/", { type: "5", mode: 0o755 }),
  tarEntry("dev/null", { type: "3", major: 1, minor: 3 }),
  tarEntry("etc/", { type: "5", mode: 0o755 }),
  tarEntry("app/", { type: "5", mode: 0o755 }),
  ...Object.entries(IMAGE_FILES).map(([name, text]) => tarEntry(name, { data: Buffer.from(text) })),
  Buffer.alloc(1024),
]);

const write = (dir, files) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
};
// The catalog (its own tools) and another repository's blueprints, whose
// tools are catena-templates' beside it.
const ws = join(work, "ws");
const catalog = join(ws, "catalog");
write(catalog, {
  "blueprints/web/docker-compose.yml": "services: {}\n", "blueprints/blog/docker-compose.yml": "services: {}\n",
  "blueprints/notes/README.md": "no compose\n", "images/helper/Dockerfile": "FROM scratch\n", ".clamav-allow.sfp": "# allow\n",
});
const folder = join(ws, "ops-templates");
write(folder, { "blueprints/web/docker-compose.yml": "services: {}\n" });
write(join(ws, "catena-templates"), { ".clamav-allow.sfp": "# allow\n" });

const BASE = "b".repeat(40);
let n = 0;
function exec(script, args, { cwd = catalog, state = {}, env = {}, tar = IMAGE_TAR } = {}) {
  const dir = join(work, `run${n++}`);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin/scanctl"), SCANCTL);
  chmodSync(join(dir, "bin/scanctl"), 0o755);
  const files = {
    STUB_STATE: join(dir, "state.json"), STUB_LOG: join(dir, "calls.log"), STUB_TAR: join(dir, "image.tar"),
    GITHUB_OUTPUT: join(dir, "output"), GITHUB_STEP_SUMMARY: join(dir, "summary"),
  };
  writeFileSync(files.STUB_STATE, JSON.stringify({ uv: {}, applint: {}, base: BASE, ...state }));
  writeFileSync(files.STUB_TAR, tar);
  for (const f of ["STUB_LOG", "GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"]) writeFileSync(files[f], "");
  const r = spawnSync("bash", [script, ...args], {
    cwd,
    encoding: "utf-8",
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, ...files, RUNNER_TEMP: dir,
      CATALOG: "true", OWNER: "CatenaHQ", OWN_IMAGES: "", ...env,
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(files.GITHUB_OUTPUT, "utf-8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return {
    status: r.status, out: r.stdout, err: r.stderr, outputs,
    summary: readFileSync(files.GITHUB_STEP_SUMMARY, "utf-8"), log: readFileSync(files.STUB_LOG, "utf-8").split("\n").filter(Boolean),
  };
}

const LOCK = `catenahq/contracts ${"c".repeat(40)} # main\ncatenahq/catena-templates ${"d".repeat(40)} # main\n`;
const planOf = (catalogTools) =>
  buildMatrix({ checks: `gates: {}\napps: {catalog: ${catalogTools}}\n`, lock: LOCK, secrets: [], runner: "catena-ci", repo: "demo" });

const CHECKER = "ghcr.io/catenahq/catena-admin:v0.12.0";
const LATEST = "ghcr.io/catenahq/catena-admin:latest";
const file = (id) => `/work/blueprints/${id}/docker-compose.yml`;
const finding = (severity, rule) => ({ severity, rule, message: `${rule} found` });
// The uv answers of an app that passes every check.
const APP_UV = {
  "app_check.py checker web": { out: `${CHECKER}\n` },
  "app_check.py images web": { out: "example/web:1\nexample/db:2\n" },
  "app_check.py plain web": { out: "true\n" },
};
const REPORT = [
  { file: file("web"), findings: [finding("warning", "W1")] },
  { file: file("blog"), findings: [finding("error", "E9")] },
];

try {
  // app-plan.sh: one entry per app the change touches and still has, from the
  // plan's apps.app; the change is piped to the scope check, then to changed.
  {
    const plan = planOf(true);
    let r = ok(exec(APP_PLAN, [], {
      state: { paths: ["blueprints/web/app.json", "blueprints/gone/app.json", "README.md"], uv: { "app_check.py changed": { out: "gone web\n" } } },
      env: { PLAN: JSON.stringify(plan) },
    }), "plan");
    const out = JSON.parse(r.outputs.plan);
    assert.deepEqual(out.include.map((e) => e.name), ["gates", "apps-repo", "app-web"]);
    assert.deepEqual(out.include[2], { name: "app-web", ...plan.apps.app, inputs: ["blueprints/web/", ...plan.apps.app.inputs] });
    assert.equal(out.include[2].kind, "app");
    assert.equal(out.include[2].timeout, 60);
    assert.equal(out.include[2].tools.uv, "0.13.9");
    assert.ok(r.out.includes("gone: deleted, nothing to check"), r.out);
    const piped = "blueprints/web/app.json,blueprints/gone/app.json,README.md";
    assert.deepEqual(r.log.filter((l) => l.startsWith("uv ")), [
      `uv ./build/versions.py scope < ${piped} root=undefined`,
      `uv ./build/app_check.py changed < ${piped} root=undefined`,
    ]);

    // No app touched: the plan is unchanged.
    r = ok(exec(APP_PLAN, [], { state: { paths: ["README.md"] }, env: { PLAN: JSON.stringify(plan) } }), "no app");
    assert.deepEqual(JSON.parse(r.outputs.plan), plan);

    // The tools of catena-templates, beside another repository's tree.
    const folderPlan = planOf(false);
    r = ok(exec(APP_PLAN, [], {
      cwd: folder, state: { paths: ["blueprints/web/docker-compose.yml"], uv: { "app_check.py changed": { out: "web\n" } } },
      env: { PLAN: JSON.stringify(folderPlan), CATALOG: "false" },
    }), "folder");
    assert.ok(r.log.some((l) => l.startsWith("uv ../catena-templates/build/versions.py scope")), r.log.join("\n"));
    const folderEntry = JSON.parse(r.outputs.plan).include.at(-1);
    assert.equal(folderEntry.sib["catena-templates"], "1");
    assert.deepEqual(folderEntry.inputs.slice(0, 1), ["blueprints/web/"]);

    // The scope check refuses a change of two apps: plan fails before it lists any.
    r = fails(exec(APP_PLAN, [], {
      state: { paths: ["blueprints/web/a", "blueprints/blog/b"], uv: { "versions.py scope": { status: 1, err: "the change touches 2 apps (blog, web)\n" } } },
      env: { PLAN: JSON.stringify(plan) },
    }), "two apps", "the change touches 2 apps");
    assert.deepEqual(r.outputs, {});
    assert.ok(!r.log.some((l) => l.includes("changed")), "changed is not asked");

    // An id outside the plain slug form, and a failed listing, fail plan: a
    // failed listing is never "no app".
    fails(exec(APP_PLAN, [], {
      state: { paths: ["blueprints/Web/a"], uv: { "app_check.py changed": { out: "Web\n" } } }, env: { PLAN: JSON.stringify(plan) },
    }), "bad id", "'Web' is not a plain app id");
    r = fails(exec(APP_PLAN, [], {
      state: { paths: ["blueprints/web/a"], uv: { "app_check.py changed": { status: 1, err: "'a b' is not a plain app id\n" } } },
      env: { PLAN: JSON.stringify(plan) },
    }), "failed listing");
    assert.deepEqual(r.outputs, {});
  }

  // app-check.sh app: every check of one app, in order, with the checker image
  // app_check.py names; ClamAV extracts an image holding dev/null.
  {
    const r = ok(exec(APP_CHECK, ["app", "web"], {
      state: { uv: APP_UV, applint: { [CHECKER]: { report: REPORT, status: 1 } } },
      env: { OWN_IMAGES: "ghcr.io/catenahq/repertoire  ghcr.io/catenahq/catena-reports" },
    }), "app");
    const root = `root=`;
    const calls = r.log.filter((l) => !l.startsWith("scanned ") && !l.startsWith("docker clamscan"));
    assert.deepEqual(calls, [
      "docker stack config --skip-interpolation -c blueprints/web/docker-compose.yml",
      `uv ./build/app_check.py checker web ${root}`,
      `docker pull ${CHECKER}`,
      `docker applint ${CHECKER} --catalog --nodes 2 --json /work/blueprints`,
      `uv ./build/app_check.py images web ${root}`,
      "docker pull example/web:1",
      "docker pull example/db:2",
      `uv ./build/app_check.py plain web ${root}`,
      `uv ./build/pack.py plain-check web ${root}`,
      `uv ./build/app_check.py provenance web own=ghcr.io/catenahq/repertoire,ghcr.io/catenahq/catena-reports,ghcr.io/catenahq/helper ${root}`,
      `git rev-parse HEAD^1`,
      `scanctl run -config ${join(work, `run${n - 1}`, "scanctl-app.yml")} -baseline-ref ${BASE} -baseline .scanctl/baseline.sarif`
        + ` -out ${join(work, `run${n - 1}`, "scanctl.sarif")} -summary ${join(work, `run${n - 1}`, "scanctl-summary.md")} .`,
      "docker create example/web:1",
      "docker rm cid",
      "docker create example/db:2",
      "docker rm cid",
    ]);
    assert.ok(r.out.includes(`catena-applint of ${CHECKER}: no error in web`), "an error of another app's file does not count");
    const config = readFileSync(join(work, `run${n - 1}`, "scanctl-app.yml"), "utf-8");
    assert.ok(config.includes("  - file: blueprints/web/docker-compose.yml\n"), config);
    assert.ok(config.includes(`    pattern: '(?m)^\\s*image:\\s*["'']?([^"''\\s#]+)'\n`), config);
    assert.equal(r.summary, "scanctl summary\n");
    const scanned = r.log.filter((l) => l.startsWith("scanned ")).map((l) => l.slice("scanned ".length)).sort();
    assert.deepEqual(scanned, [...Object.keys(IMAGE_FILES), ...Object.keys(IMAGE_FILES)].map((f) => `/scan/${f}`).sort());
    assert.ok(r.log.includes(`docker clamscan allow=${join(catalog, ".clamav-allow.sfp")}`), r.log.join("\n"));
    if (process.getuid() !== 0) assert.ok(r.err.includes("dev/null: Cannot mknod: Operation not permitted"), "tar's mknod failure is tolerated");
  }

  // An app that does not opt in to the plain export skips it.
  {
    const r = ok(exec(APP_CHECK, ["app", "web"], {
      state: { uv: { ...APP_UV, "app_check.py plain web": { out: "false\n" } }, applint: { [CHECKER]: { report: REPORT } } },
    }), "no plain");
    assert.ok(r.out.includes("web does not opt in to the plain export check"), r.out);
    assert.ok(!r.log.some((l) => l.includes("plain-check")));
  }

  // The checker: a failed pull, an error of the app's file, a status above 1,
  // and a report without the app's file each fail before any image is pulled.
  const checkerFails = (label, state, message) => {
    const r = fails(exec(APP_CHECK, ["app", "web"], { state: { uv: APP_UV, ...state } }), label, message);
    assert.ok(!r.log.includes("docker pull example/web:1"), `${label}: the app's images are not pulled`);
  };
  checkerFails("pull", { pullFail: [CHECKER] }, `The pull of ${CHECKER} failed`);
  checkerFails("error", { applint: { [CHECKER]: { report: [{ file: file("web"), findings: [finding("error", "E1")] }], status: 1 } } },
    `${file("web")}: error E1: E1 found`);
  checkerFails("status", { applint: { [CHECKER]: { report: REPORT, status: 2 } } }, `catena-applint of ${CHECKER} ended with status 2`);
  checkerFails("unread", { applint: { [CHECKER]: { report: [{ file: file("blog"), findings: [] }] } } },
    `catena-applint of ${CHECKER} did not read ${file("web")}`);

  // A failed scan fails the check, and its summary still reaches the job summary.
  {
    const r = fails(exec(APP_CHECK, ["app", "web"], { state: { uv: APP_UV, applint: { [CHECKER]: { report: REPORT } }, scanctl: 1 } }), "scan");
    assert.equal(r.summary, "scanctl summary\n");
    assert.ok(!r.log.some((l) => l.startsWith("docker create")), "ClamAV does not run");
  }

  // ClamAV: a device node tar cannot make is tolerated; an archive cut short
  // (inside etc/app.conf's data) is not.
  {
    const cut = IMAGE_TAR.subarray(0, 512 * 5 + 2);
    const r = fails(exec(APP_CHECK, ["app", "web"], { state: { uv: APP_UV, applint: { [CHECKER]: { report: REPORT } } }, tar: cut }), "cut archive");
    assert.ok(r.err.includes("Unexpected EOF"), r.err);
    assert.ok(!r.log.some((l) => l.startsWith("scanned ")));
  }

  // Another repository's blueprints: the tools of catena-templates beside it,
  // the checker in folder mode, only the caller's own images.
  {
    const r = ok(exec(APP_CHECK, ["app", "web"], {
      cwd: folder, state: { uv: APP_UV, applint: { [CHECKER]: { report: [{ file: file("web"), findings: [] }] } } },
      env: { CATALOG: "false", OWN_IMAGES: "ghcr.io/catenahq/repertoire" },
    }), "folder app");
    const tools = join(ws, "catena-templates");
    assert.ok(r.log.includes(`uv ${tools}/build/app_check.py checker web root=${folder}`), r.log.join("\n"));
    assert.ok(r.log.includes(`docker applint ${CHECKER} --nodes 2 --json /work/blueprints`), r.log.join("\n"));
    assert.ok(r.log.includes(`uv ${tools}/build/app_check.py provenance web own=ghcr.io/catenahq/repertoire root=${folder}`), r.log.join("\n"));
    assert.ok(r.log.includes(`docker clamscan allow=${join(tools, ".clamav-allow.sfp")}`), r.log.join("\n"));
  }

  // A bad id is refused before anything runs.
  {
    const r = fails(exec(APP_CHECK, ["app", "../web"]), "bad id", "'../web' is not a plain app id");
    assert.deepEqual(r.log, []);
    assert.equal(exec(APP_CHECK, ["other"]).status, 2);
  }

  // app-check.sh repo: the swarm lint, then the checker each app names, run
  // once per image; each app is judged by its own image's report.
  {
    const repoUv = { "app_check.py checker web": { out: `${CHECKER}\n` }, "app_check.py checker blog": { out: `${LATEST}\n` } };
    const passing = { [CHECKER]: { report: REPORT, status: 1 }, [LATEST]: { report: [{ file: file("blog"), findings: [] }, { file: file("web"), findings: [] }] } };
    let r = ok(exec(APP_CHECK, ["repo"], { state: { uv: repoUv, applint: passing } }), "repo");
    assert.deepEqual(r.log, [
      "uv ./build/lint_swarm.py root=",
      "uv ./build/app_check.py checker blog root=",
      "uv ./build/app_check.py checker web root=",
      `docker pull ${LATEST}`,
      `docker applint ${LATEST} --catalog --nodes 2 --json /work/blueprints`,
      `docker pull ${CHECKER}`,
      `docker applint ${CHECKER} --catalog --nodes 2 --json /work/blueprints`,
    ]);

    // An error of web's file in web's image fails; the other image still runs.
    r = fails(exec(APP_CHECK, ["repo"], {
      state: { uv: repoUv, applint: { ...passing, [CHECKER]: { report: [{ file: file("web"), findings: [finding("error", "E2")] }], status: 1 } } },
    }), "repo error", `${file("web")}: error E2: E2 found`);
    assert.ok(r.log.includes(`docker applint ${LATEST} --catalog --nodes 2 --json /work/blueprints`), r.log.join("\n"));

    // A failed swarm lint fails the check.
    fails(exec(APP_CHECK, ["repo"], { state: { uv: { ...repoUv, "lint_swarm.py": { status: 1 } }, applint: passing } }), "lint");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("app-check: ok");
