# catenahq/contracts

Single source of truth for everything that more than one catena repo
depends on. Consumers read this repo as a sibling checkout, so one copy
of each fact serves every repo.

## What lives here

| Directory | Contract | Primary consumers |
|-----------|----------|-------------------|
| `brand/`  | Design tokens (CSS variables) + Conthrax wordmark binary + catena logo SVG | catenahq/website, catenahq/docs |
| `pricing/`| Billing facts that are not an edition price: the a-la-carte hourly rate and its billing increment, and the Polar checkout link of each paid edition | catenahq/website (the pricing matrix's Subscribe buttons), catenahq/catena-admin (the Subscription section's checkout links) |
| `legal/`  | Canonical MSA markdown + version pin (commit SHA) + effective date + published URL | catenahq/website (renders `/legal/master-agreement`) |
| `default-apps/` | Wiring of the default apps (Gatus, Healthchecks, Beszel): stack, services, networks, ports, volumes, capabilities | catenahq/catena-ce, catenahq/catena-admin, catenahq/catena-templates, catenahq/ops |

Add a new directory whenever a fact lives in more than one repo. Do
NOT add app-specific copy, operator-only configuration, or anything
under active iteration that doesn't have a stable shape yet -- those
belong in the consuming repo until they stabilize.

## How consumers depend on it

Each web consumer (website, docs) declares a sibling-directory read in
its `package.json`:

```json
{
  "dependencies": {
    "@catenahq/contracts": "file:../contracts"
  }
}
```

npm symlinks `node_modules/@catenahq/contracts` to the sibling
checkout, so an edit here is visible on the consumer's next dev/build.
CI mirrors the layout: each consumer's workflow checks this repo out
alongside itself with `.github/actions/checkout-sibling`.

A consumer pins each sibling in its own `.github/catenahq.lock`, one line per
sibling, so a push to a sibling changes no open pull request's result there:

```
catenahq/<repo> <40-hex sha> # <branch the sha was read from>
```

Blank lines and lines starting with `#` are ignored. With the lock,
checkout-sibling takes the sibling's branch of the same name as the run's
branch when the sibling has it and a bot did not name it (`renovate/`,
`engine-bump/`, `scanctl/`, `merge-back/`), else the pinned commit; the base
branch and the default branch do not apply. A lock without a line for the
requested sibling, or with a malformed line, fails the step. The `lock`
input names the file when it is not `.github/catenahq.lock` under the
workspace root (a consumer checked out under `ws/<repo>` passes
`ws/<repo>/.github/catenahq.lock`). The input `tip: 'true'` takes the
sibling's default branch and ignores the lock. The `ref` output is the
branch or the commit checked out.

With no lock file the checkout is at the branch the consumer runs on when
this repo has it and a bot did not name it, else on a pull request at the
base branch, else at the default branch. A run on its own repository's
default branch takes the default branch here too.

The scripts under `scripts/` (unicode, prose, repo-rule and core-app-name
gates, and the brand-asset sync each site runs on install) run from that
checkout the same way. The repo-rule gate refuses a tracked env file, a
tracked `.agent` path (on every branch the repo's CI runs on, so an agent
branch that holds `.agent/` fails it until a later run removes it), a tracked
aidevops runtime-state path (`.agents/loop-state/`, `.agents/tmp/`,
`.agents/memory/`, `.agents/.full-loop-cleanup-deferred`) and a branch
name where something is checked out, installed or compared. The core-app-name gate takes the roots to scan as
arguments (catena-ce `.`; catena-admin `--exclude central/ .`) and keeps
its debt in the consumer's `.github/core-app-names-debt.json` and its
accepted uses in `.github/core-app-names-exceptions.json`.

Direct file imports:

```js
import tiers from "@catenahq/contracts/pricing/tiers.json";
import msa from "@catenahq/contracts/legal/msa.json";
// Canonical MSA markdown -- consumed by the website via fs.readFileSync
// (the Astro page renders it through @astrojs/markdown-remark).
```

The MSA markdown ships as a file under the package; consumers read
it with `fs.readFileSync(require.resolve("@catenahq/contracts/legal/master-agreement.md"))`
(Node) or the equivalent vite / Astro asset import.

CSS:

```css
@import "@catenahq/contracts/brand/tokens/all.css";
```

## Changes fail only on new failures

`.github/actions/new-failures-only` runs a gate command so that a change is
judged on what it introduces. The base commit is the `base` input; else, on a
pull request, the first parent of the merge commit checked out at `repo-path`
(the current tip of the base branch, read from the raw commit so a 1-deep
clone works); else, when the checkout is not that merge commit, the event's
`base.sha`, which can be an older commit of the base branch. With none (a push
without `base`) the command runs and
its exit status is the verdict: the absolute gate. With a base the command
runs at the head and passes if it passes. If it fails, the action fetches the
base commit (depth 1), checks it
out detached in `repo-path`, runs the command again, and checks the head
back out. The job then fails only when the head output has a failure line the
base output lacks. New lines print as `::error::`, lines the base carries as
`::warning::`, and a summary line gives the counts. Untracked files in
`repo-path` are removed before each checkout; nested repositories (sibling
checkouts) and ignored files stay.

| Input | Meaning |
| --- | --- |
| `run` | Required. The gate command (multi-line allowed), run with `bash -eo pipefail`; output is shown live. |
| `working-directory` | Where `run` runs. Default `.`. |
| `repo-path` | Required. The checkout that moves to the base commit. |
| `failure-lines` | Extended regex. Each matched part of an output line is one failure's identity, so a regex that stops before a timing or a line number keeps identities stable between runs. Empty (or no match in the head output): the exit status alone, and a failing base passes the pull request. |
| `base` | The commit the change is judged from. Empty: on a pull request, the first parent of the merge commit checked out at `repo-path`, else the event's base commit; any other event keeps the absolute gate. |
| `token` | Fetches the base commit (default `github.token`; sent as an http extraheader on that one fetch). |

```yaml
      - uses: catenahq/contracts/.github/actions/new-failures-only@main
        with:
          working-directory: catena-admin
          repo-path: catena-admin
          failure-lines: '^--- FAIL: [^ ]+|^FAIL[[:space:]]+[^[:space:]]+'
          run: go test ./...
```

`scripts/new-failures-only.test.mjs` drives the action's script
(`new-failures-only.sh`) over a scratch repository.

## Runs once per tree

`.github/actions/same-tree` lets a workflow skip code it has already judged.
A first job runs it; every other job needs that job and runs only when its
`run` output is not `false`.

The key is `tree=<tree>`, then `base=<base tree>` with `judge-change`, then
one `<owner/name>=<sha>` line per sibling, sorted, naming the commit at the
commit `checkout-sibling/resolve.sh` picks from the lock, else the tip of the
branch it picks (the default branch when it picks none), read with
`git ls-remote`. Trees and parents come from the commits API, so no checkout is needed.
The job has no checkout, so the lock is the repository's
`.github/catenahq.lock` at each judged commit, read through the contents API:
each commit's key names the commits its own lock pins, the same ones a job
checked out at that commit gets. A 404 means the commit has no lock and the
branch tips key the siblings; any other failure of that read fails the step.
The `lock` input, or a lock file under the workspace, is read instead; `tip`
reads no lock.
A run that does its checks records the key as an artifact named
`same-tree.<name>.<first 40 hex of sha256(key)>`, kept 30 days.

Only a push or a pull_request run reuses: on any other event `github.sha` is
not the code the run judges. It lists the artifacts of the record name, newest
first, and takes the first whose run:
- is not expired, is of this repository (never a fork's), and is not this run;
- ran `workflow`, from an event in `source-events`;
- has a head commit with the key's tree and, with `judge-change`, a first
  parent with the key's base tree. Any run of the repository can upload an
  artifact of any name, so the record alone proves nothing. A pull_request
  run's head is the pull request's head, so it counts only when that head has
  the merge commit's tree, which is when the pull request is up to date with
  its base;
- completed with `success` (a failure, cancelled, skipped or timed out run is
  not a result, so a failure is never reused). A success carries between a push
  and a pull request.

A found success sets `run` to `false`, prints
`::notice::same tree as <url> (<state>): nothing ran` and writes the job
summary. A source still going is waited for, polled every 30 seconds, up to
`wait-minutes`; with no record yet, so is a push run of the checked commit and,
on a pull request, of its head when that head has the merge commit's tree. A
waited push run that fails leaves a pull request to run its own checks. Any
API error means no result: the checks run, with a warning. A failed record
upload does not fail the job.

| Input | Meaning |
| --- | --- |
| `name` | Record name. Default the stem of the calling workflow file (the caller's in a reusable workflow). |
| `workflow` | The file the source must have run. Default the caller's. |
| `commits` | Lines of `<sha> [<base sha>]`. Default `github.sha` (the merge commit on a pull request). With several, `results` lists those with a result, the step never fails and nothing is recorded. |
| `judge-change` | `true` adds the base tree to the key: the line's base, else the first parent. |
| `siblings` | owner/name list: every repository the workflow checks out with checkout-sibling; the commit each checkout gets joins the key. |
| `branch` | Passed to the sibling resolution in place of the run's branch (a tag push has none). |
| `lock` | Passed to the sibling resolution as checkout-sibling's `lock` input. Empty: the lock file under the workspace when it exists, else the lock at each judged commit, read through the API. |
| `tip` | Passed to the sibling resolution as checkout-sibling's `tip` input. |
| `source-events` | Events a source run may have. Default `push pull_request schedule`. |
| `wait-minutes` | Default 30 on a `pull_request`, 0 on other events, so a push never waits. |
| `record` | Default `true`: a single commit that runs on a push, pull request or schedule is recorded. |
| `token` | Reads this repository's runs, artifacts, commits and lock. Default `github.token`; the job grants `contents: read` and `actions: read`. |
| `sibling-token` | Reads the siblings' branches. Default `github.token`; a private sibling needs the token the workflow's checkout-sibling steps pass. |

| Output | Meaning |
| --- | --- |
| `run` | `true` when the checks run, `false` when a result is reused. |
| `state` | `success` when reused, else empty. |
| `source` | The URL of the reused run. |
| `results` | Lines of `<sha> <state> <url>`, one per commit with a result. |

```yaml
  same-tree:
    name: same tree (ci)
    runs-on: ubuntu-26.04
    permissions:
      contents: read
      actions: read
    outputs:
      run: ${{ steps.tree.outputs.run }}
    steps:
      - id: tree
        uses: catenahq/contracts/.github/actions/same-tree@main
        with:
          siblings: catenahq/contracts
  test:
    needs: same-tree
    if: needs.same-tree.outputs.run != 'false'
```

The runner needs `gh`, `git` and `sha256sum`. `scripts/same-tree.test.mjs`
drives `same-tree.sh` and `resolve.sh` with stubs for `gh`, `git`, `date` and
`sleep`. The `gh` stub serves API payloads and applies the script's `--jq`
projections with a small evaluator of the jq they use, which the test checks
against payloads and outputs recorded from `gh api`.

## Shared PR workflow

`.github/workflows/pr.yml` is the reusable workflow a repository's CI calls. The
caller's `ci.yml` holds the triggers and the permissions, and pins a contracts
commit:

```yaml
name: ci
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  schedule:
    - cron: '17 6 * * *'
permissions: {}
concurrency:
  group: ci-${{ github.event_name }}-${{ github.ref }}
  cancel-in-progress: true
jobs:
  ci:
    uses: catenahq/contracts/.github/workflows/pr.yml@<40-hex sha> # <branch>
    permissions:
      contents: read
      actions: read
      security-events: write
      pull-requests: write
      issues: write
      statuses: write
    with: {runner: catena-ci}
```

GitHub refuses to start a run whose called jobs ask for a permission the caller
does not grant, so the caller grants every permission a job of `pr.yml` asks
for, a scan job's included, whether or not the scan runs.

The input `runner` is the label of `plan`, `gate`, the scan jobs and every
check that names no `runs-on`. These jobs run:

- `plan` checks the caller out under `ws/<repo>` (two commits deep) and
  contracts at `job.workflow_sha` (the commit the caller pins) under
  `.catena-ci/`, turns the caller's `.github/checks.yml` into a matrix with
  `scripts/ci/checks-matrix.mjs`, adds an entry per app the change touches
  when checks.yml has `apps` (see "App checks"), and drops each entry, and the
  scan, that an earlier run passed with the same key (see "Per-check reuse"). Its output
  `matrix` holds the entries left, `run` is `false` when none is left, `scan`
  is the scan settings (JSON) and `scan-run` is `true` when checks.yml has a
  `scan` key and the scan is not reused. It also bundles each private sibling
  an entry left names (see "Private siblings").
- `check (<name>)`, one per matrix entry, when `run` is `true`: the caller (two
  commits deep) and `.catena-ci/` again, each sibling the entry names through
  checkout-sibling at the caller's lock, or from its bundle, the entry's tools
  (Node 26 when it names no Node), the reuse record, then what the entry's
  `kind` runs in `ws/<repo>`: `bash ci/run <name>` for a `check`; the contracts
  gates of the locked contracts checkout for `gates`: unicode, repo rules and
  whole-tree prose always, the core-app-name gate with its arguments, jscpd
  4.3.0 with `duplication`; `scripts/ci/app-check.sh` for `apps-repo` and `app`.
  An entry with `go-cache: true` restores the Go build and module caches
  after setting up Go: key `go-<hash of go.sum>-<run id>-<run attempt>`,
  restored by the prefixes `go-<hash>-` and `go-`, where the `go.sum` is the
  one beside the go file (`ws/<repo>/go.sum`, or `ws/<sibling>/go.sum` for
  `go: <sibling>/go.mod`, and `ws/<repo>/go.sum` for an exact version). A
  build cache over 3 GiB is emptied before the check runs. Only a `schedule`
  run saves the caches, after the check, whether it passed or not; a
  `schedule` run never reuses a result, so the daily run runs every check and
  refreshes the cache, and a pull request or push run only restores. A check
  that passed uploads its reuse record.
- `scan`, when `scan-run` is `true` on any event but `schedule`, and
  `scan-daily`, when it is `true` on `schedule`, run scanctl (see "Scan"). A
  `scan` that passed uploads its reuse record; `scan-daily` records nothing.
- `gate` is the status a branch rule requires. It runs unless the run is
  cancelled and fails on a draft pull request, on a `plan` that did not
  succeed, or on a `check`, `scan` or `scan-daily` result other than success
  or skipped. On a pull request of this repository that passed, it then posts
  the commit status `ci / gate` (see "Gate status"); on one from a fork, whose
  token is read-only, it prints a notice and posts nothing.

`.github/checks.yml` is data; the parser fails on any key it does not know and
names it:

```yaml
gates:                       # the contracts gates, as the check named gates
  core-app-names: [--exclude, central/, .]   # the script's arguments
  duplication: true
checks:
  go:                        # bash ci/run go
    runs-on: catena-ci       # default: the runner input
    timeout-minutes: 40      # default 20
    tools: {go: go.mod}      # node, uv: exact; go: go.mod, <sibling>/go.mod or exact; staticcheck: {version, sha256}
    siblings: {catena-ce: {fetch-depth: 0}, contracts: {}}   # or {token: CATENA_EE_READ_TOKEN}
    inputs: [.]              # git pathspecs the check reads
    go-cache: true           # restore the Go caches; the scheduled run saves them
scan:                        # absent: no scan
  profile: full              # full (default) or sellable, passed to scanctl run --profile
  own-images: [catena-admin:ci]   # built by bash ci/run image; needs image-inputs
  image-inputs: [Dockerfile, go.mod, go.sum, scanctl.yml, .scanctl/]   # git pathspecs
  siblings: {catena-ce: {fetch-depth: 0}}   # what ci/run image reads
  tools: {go: go.mod}        # go only
apps:                        # absent: no app checks
  catalog: true              # tools from this tree; false: from catena-templates at the lock
  own-images: [ghcr.io/catenahq/repertoire]   # image repositories this repository builds
```

A sibling is one of `catena-admin`, `catena-ce`, `catena-templates`,
`contracts`, `docs` and `ops`, and needs a line in the caller's lock; `gates`
needs the contracts line. A check sibling's `token` must name a secret `pr.yml`
declares in `on.workflow_call.secrets`: `CATENA_EE_READ_TOKEN`. A scan sibling
takes no `token`. A check's `go: <sibling>/go.mod` needs that sibling in the
check's `siblings`. A check with `go-cache: true` needs `tools.go`. No check may
be named `gates`, and with `apps` none `apps-repo` or `app-<anything>`.
`apps.catalog` is required; `false` needs the catena-templates line, and
`own-images` names repositories without a tag.

The parser prints one line of JSON: `include`, the matrix, `scan` and `apps`.
Each entry carries its `kind` (`gates`, `check`, `apps-repo`, `app`), `inputs`
(`["."]` when the check names none, and for `gates`)
and every tool, sibling and gate key; a sibling's value is its fetch
depth, `bundle` for one with a `token`, or empty when the check does not use
it. `go-file` is the go.mod setup-go reads, `ws/<repo>/go.mod` for `go.mod`
and `ws/<sibling>/go.mod` for `<sibling>/go.mod`, empty for an exact version.
`scan` carries every key too, with `enabled` false when checks.yml has none,
and `own-images` joined by spaces. `apps` holds `enabled`, `catalog`,
`own-images` joined by spaces, `repo`, the `apps-repo` entry (in `include`
when `enabled`), and `app`, the entry of a changed app without its name and
its `blueprints/<id>/` input:

```json
{"include":[{"name":"go","kind":"check","runs-on":"catena-ci","timeout":40,"go-cache":true,"inputs":["."],
  "tools":{"node":"","uv":"","go":"go.mod","go-file":"ws/catena-admin/go.mod","staticcheck":"","staticcheck-sha256":""},
  "sib":{"catena-admin":"","catena-ce":"0","catena-templates":"","contracts":"1","docs":"","ops":""},
  "gates":{"core-app-names":[],"duplication":false}}],
 "scan":{"enabled":true,"profile":"full","own-images":"catena-admin:ci","image-inputs":["Dockerfile"],
  "sib":{"catena-admin":"","catena-ce":"0","catena-templates":"","contracts":"","docs":"","ops":""},
  "tools":{"go":"go.mod"}},
 "apps":{"enabled":false,"catalog":false,"own-images":"","repo":{"name":"apps-repo","kind":"apps-repo",...},"app":{"kind":"app",...}}}
```

Run the parser from a caller's checkout to see its plan; `--repo` is the
caller's repository name:

    node ../contracts/scripts/ci/checks-matrix.mjs --repo catena-admin --runner catena-ci

It needs `npm ci --prefix scripts/ci` once (npm `yaml`, locked in
`scripts/ci/`, outside the package consumers link).
`scripts/ci/checks-matrix.test.mjs` runs it over the checks of ci-runner,
catena-admin and ops, their scan settings, the app checks, and each key it
refuses.

### Per-check reuse

`scripts/ci/reuse.mjs` lets a run skip each check, and the scan, that an
earlier run passed on the same inputs. The key of an entry is the sha256 of
these lines:

- `entry=<the matrix entry as JSON, keys sorted>` (the scan settings for the
  scan);
- `tree=<git diff-tree -r <empty tree> HEAD -- <inputs> .github/checks.yml
  .github/catenahq.lock ci/run>`: every file the check reads, with its mode
  and blob, at the merge commit; the scan's inputs are `.`. `diff-tree` reads
  git pathspecs, globs included;
- `sib:<repo>=<commit>` for each sibling the entry names, sorted;
- `workflow=<job.workflow_sha>`;
- `provenance-age=<true|false>` for an entry of kind `app`: `PROVENANCE_CHECK_AGE`,
  `true` on a pull request from a fork, whose provenance check asks a year of
  age;
- `date=<UTC yyyy-mm-dd>` for the scan and an entry of kind `app`, whose
  findings follow the vulnerability feed.

The record of a key is an artifact named `ci-check.<name>.<first 40 hex of the
key's sha256>` holding the key, kept 30 days.

`node reuse.mjs plan --matrix <parser output> --repo <owner/name>` runs in
`plan`. It resolves each sibling's commit as checkout-sibling does
(`resolve.sh`: the branch of the run's name, else the lock's commit) and lists
the artifacts of each record name, newest first. A record counts when it is
not expired; its run is of this repository and not a fork's, is not this run,
ran `.github/workflows/ci.yml` on `pull_request` or `schedule`, and names
`pr.yml` at this commit in its `referenced_workflows`; its job `ci / check
(<name>)` (`ci / scan` for the scan) concluded success; and the inputs at the
run's head commit, fetched by sha when the checkout lacks it, equal ours. Any
run of the repository can upload an artifact of any name, so the record alone
proves nothing. A counted record drops the entry, prints `reused <name> from
<url>` and writes it to the job summary. The outputs are `matrix` (the entries
left), `run` (`false` when none is left), `bundles` (the bundle siblings of the
entries left) and `scan-reused`. A `schedule` run looks nothing up and runs
every entry. A GitHub API or git error fails the step: a failed lookup is
never read as "no record".

`node reuse.mjs record --entry <entry>` runs in `check` before any code of the
caller, and `record --scan <scan settings>` in `scan` after the scan action. It
computes the key from the checkouts, the caller's and each sibling's beside
it, and writes it to a file. On a pull request it sets `record` only when the
merge commit's inputs equal those of the pull request head (`HEAD^2`), the
commit a later lookup compares; other events always record. Once the check
or the scan passed, an `upload-artifact` step uploads the file under the
record name; a `run:` step holds no runtime token, so only that step uploads.

A pull request whose base moved runs again only the checks whose inputs the
base change touched. `scripts/ci/reuse.test.mjs` drives the script over
scratch repositories with a `gh` stub on `PATH` and a `git` stub that answers
`ls-remote` and runs git for the rest.

### Private siblings

A check reads a private sibling without holding a token. Its checks.yml names
the sibling with `token: CATENA_EE_READ_TOKEN`, and the caller passes the
secret:

```yaml
jobs:
  ci:
    uses: catenahq/contracts/.github/workflows/pr.yml@<40-hex sha> # <branch>
    secrets:
      CATENA_EE_READ_TOKEN: ${{ secrets.CATENA_EE_READ_TOKEN }}
```

`plan` is the one job that receives the secret, and it runs none of the
caller's code: with `apps.catalog: true`, where it runs the caller's app tools,
the secret fails it. For each such sibling an entry left after reuse names, it checks
the sibling out through checkout-sibling with the token at the caller's lock
(`fetch-depth: 0`), writes `git bundle create <repo>.bundle HEAD`, and uploads
the bundles as the artifact `sibling-bundles`, kept 1 day. Its output
`bundle-shas` maps each bundled sibling to its commit
(`{"catena-admin":"<sha>"}`). Reuse reads the siblings' branches with the same
token. A check that names a
bundle sibling downloads the artifact, runs `git clone --no-checkout` of the
sibling's bundle into `ws/<repo>`, and checks the recorded commit out detached.

`plan` fails when a check names a bundle sibling and the caller passes no
secret, or the caller is a public repository: anyone who can read a public
repository can download its artifacts.

### Gate status

`ci / gate` is the required context. Two things report under that name: the
check run of the job `gate` (called from the caller's job `ci`), and the commit
status `scripts/ci/gate-status.mjs` posts from that job's last steps and from
`control.yml`. A failed or cancelled need, or a draft, fails the check run and
the status step never runs, so a failed result posts no success. When a check
and a commit status have the same name, both must pass: a merge waits until the
`ci / gate` check run and the `ci / gate` status are both success.

    node gate-status.mjs --repo <owner/name> --pr <n> --sha <head sha>
                         [--app-tests | --apps-from <sha> --expect-apps <true|false>] [--gate-job]

`GH_TOKEN` authenticates `gh`. The script reads the pull request body for
lines of exactly `Depends-on: catenahq/<repo>#<n>`, and the newest `ci / gate`
check run that GitHub Actions made on the sha (a check run of another App is
ignored). It posts the whole state on every call, so the newest post is right:

- with app-tests, `failure` (`app-tests failed`) when the newest `app-tests`
  status of the sha is a failure or error;
- `failure` (`ci / gate check run <conclusion>`) when the check run completed
  with anything but success;
- `pending`, `waiting for catenahq/<repo>#<n>` for the first named pull request
  that is open, or `catenahq/<repo>#<n> closed without merging` for one closed
  unmerged (it can reopen); a pull request counts once its `merged_at` is set;
- `pending` (`waiting for checks`) while the check run is missing, queued or in
  progress;
- with app-tests, `pending` (`waiting for app-tests`) when the `app-tests`
  status is missing or pending;
- `success`, `no open dependency`, otherwise.

So the status turns success only after the checks passed, whichever job posts
it. `--gate-job` skips the check run: the `gate` job is the run being judged.
App-tests are waited for with `--app-tests`, or with `--apps-from <sha>` when
`.github/checks.yml` at that commit, read through the contents API as data,
declares `apps` (`checks-matrix.mjs` answers, as it does for `plan`; a 404 is
no checks.yml). `--expect-apps` is the caller's `apps` input: when it differs
from that answer, the script posts `failure` naming both and exits 1.

A line that starts with `Depends-on:` and does not match the pattern is ignored
with a warning on stderr. The dependencies are read with `GH_READ_TOKEN` when it
is set, the read-only token of the repositories the pull request names (see
"Control workflow"), else with `GH_TOKEN`. The description is cut at 140
characters, and `target_url` is the run's URL when `GITHUB_SERVER_URL`,
`GITHUB_REPOSITORY` and `GITHUB_RUN_ID` are set. The script exits 1 on a GitHub
API error, an unreadable dependency included, and 2 on bad arguments; with
`--gate-job` a dependency it cannot read posts `pending` (`waiting for the
control run`), never success or failure, and the control run posts the state.

The `gate` job runs it on a pull request of this repository with
`--gate-job`, and with `--app-tests` when the plan's `apps.enabled` is true,
with `contents: read`, `statuses: write` and `pull-requests: read`; its token
reads only this repository and public ones. The `depends` job of
`control.yml` runs it on each `pull_request_target` event with `--apps-from`
the base commit and the read-only token, and `checks: read` besides (see
"Control workflow"). `scripts/ci/gate-status.test.mjs` drives it with a `gh` stub on
`PATH`.

### Scan

`scan` and `scan-daily` check contracts out under `.catena-ci/` at
`job.workflow_sha` and run `.github/actions/scan` with the plan's `scan`
output. The action:

- checks the caller out under `ws/<repo>` with its whole history, and each
  sibling of `scan.siblings` at the caller's lock;
- builds scanctl with `.github/actions/scanctl` at the commit of the
  `catenahq/scanctl` line of this repository's `.github/catenahq.lock`, read
  from `.catena-ci/`; in catenahq/scanctl it builds the caller's own checkout;
- sets up uv 0.13.9 for the Python scanners, and Go when `scan.tools` names it;
- with `own-images`, runs `bash ci/run image` in `ws/<repo>` on a scheduled
  run, or when `git diff --name-only HEAD^1 HEAD -- <image-inputs>` is not
  empty; GitHub's cache service is exposed for that build, and later steps
  blank its token;
- runs `scanctl run --profile <profile> --baseline .scanctl/baseline.sarif
  --dismiss-baseline`, with `--own-image <ref>` for each own image it built;
- uploads the SARIF to code scanning on a public repository, the SARIF and
  SBOM as the artifact `scanctl-results`, and on a pull request writes the
  summary into one comment it updates in place.

`scan` grants `contents: read`, `security-events: write` and
`pull-requests: write`. `scan-daily` adds `issues: write` and runs in the
caller's environment `ci` (`deployment: false`): with `DOCKERHUB_USERNAME`
and `DOCKERHUB_TOKEN` there, image pulls log in to Docker Hub. A failed
`scan-daily` opens an issue labelled `scan`, or comments on the open one.
No scan job receives `CATENA_EE_READ_TOKEN`.

`.github/actions/scanctl` builds scanctl into `$RUNNER_TEMP/bin/scanctl` with
`go build`: `sha`, else the commit of the `catenahq/scanctl` line of
`.catena-ci/.github/catenahq.lock`, checks catenahq/scanctl out under
`.scanctl-src`; `self: 'true'` builds `ws/scanctl`. Go comes from the go.mod
of the tree it builds.

### App checks

A repository of apps under `blueprints/<id>/` (catena-templates, which holds
the catalog and its tools, and ops-templates) gets its app checks from the
`apps` key of its checks.yml. `apps.catalog: true` runs the tools of the tree
itself; `false` runs those of catena-templates, checked out under
`ws/catena-templates` at the caller's lock, on the caller's tree
(`TEMPLATES_ROOT`).

In `plan`, after the parser, `scripts/ci/app-plan.sh` reads the change, `HEAD`
against its first parent, and fails `plan` when it touches more than one app
(`build/versions.py scope`), so one change is one app's tag. Each app it
touches (`build/app_check.py changed`) that still has its
`docker-compose.yml`, and whose id matches `^[a-z0-9][a-z0-9-]*$`, gets the
entry `app-<id>`: kind `app`, timeout 60 minutes, uv 0.13.9, inputs
`blueprints/<id>/`, the tools (`build/`, `lib/`, `pyproject.toml`, `uv.lock`,
the two schemas), `.clamav-allow.sfp` and `.scanctl/`. The entry `apps-repo`
runs on every change, with inputs `blueprints/` and the tools. Since `plan`
then runs the caller's tools, a caller with `apps.catalog: true` passes no
`CATENA_EE_READ_TOKEN` (see "Private siblings").

`check` runs `scripts/ci/app-check.sh` in `ws/<repo>`, with `contents: read`:

- `app-check.sh repo` (`apps-repo`): the swarm lint
  (`build/lint_swarm.py`), then the app checker of each app. The app checker
  is catena-applint in the catena-admin image `build/app_check.py checker
  <id>` names, the release the app requires; it reads all of `blueprints/`
  (`--catalog --nodes 2` for the catalog, `--nodes 2` otherwise) and an app
  fails on an error of its own compose file. Each image runs once for the apps
  that name it.
- `app-check.sh app <id>` (`app-<id>`): the swarm loader reads the stack file;
  the app checker; the app's images are pulled; the plain export check
  (`build/pack.py plain-check`) for an app whose card sets `bench.plain`;
  provenance (`build/app_check.py provenance`), with `own-images` and, for the
  catalog, `ghcr.io/<owner>/<folder>` for each folder of `images/`; scanctl,
  built by `.github/actions/scanctl`, runs trivy over the images the compose
  pins, judged against the first parent (`-baseline-ref`) and
  `.scanctl/baseline.sarif`, its summary in the job summary; ClamAV
  (`clamav/clamav:1.5`, with `.clamav-allow.sfp` of the tools) over each
  image's exported files, where tar's failure to make a device node is the one
  extraction error allowed.

An app entry's key holds its inputs and the date (see "Per-check reuse"), so
a run whose change leaves an app's folder and the tools alone reuses that
app's pass of the same day. `scripts/ci/app-check.test.mjs` drives both scripts with
stubs for `uv`, `docker`, `git` and scanctl on `PATH`.

### Control workflow

`.github/workflows/control.yml` is the reusable workflow of the jobs that run
from a repository's protected branch. A repository has two caller files:
`ci.yml` calls `pr.yml` for the pull request checks, and `ci-control.yml`
calls `control.yml`:

```yaml
name: ci-control
on:
  pull_request_target:
    types: [opened, synchronize, reopened, edited, ready_for_review, auto_merge_enabled]
  workflow_run:
    workflows: [ci]
    types: [completed]
  push:
    branches: [main, release]
  schedule:
    - cron: '7 * * * *'
  workflow_dispatch:        # release repositories only
    inputs:
      step: {type: choice, options: [cut, tag, merge-back], required: true}
      version: {type: string, required: false}   # tag and merge-back
permissions: {}
jobs:
  control:
    uses: catenahq/contracts/.github/workflows/control.yml@<40-hex sha> # <branch>
    permissions:
      contents: read
      actions: read
      checks: read
      statuses: write
      pull-requests: read
    with:
      runner: catena-ci
      apps: false
      release: false
      step: ${{ inputs.step }}
      version: ${{ inputs.version }}
```

`pull_request_target` and `workflow_run` run the file of the base branch, never
the pull request's code: every job loads the CI code from contracts at
`job.workflow_sha` under `.catena-ci/`, and only `dispatch` checks the pull
request out, as data its tools read (see "App dispatch"). The workflow declares
no secret: the CI App's are those of the caller's environment `ci`, the
policy App's those of its environment `workflow-policy`.

Every App token that writes covers the caller's repository alone (`dispatch`'s
covers ops alone). A read of another repository (a Depends-on pull request, a
first-party commit the policy compares) takes a second token,
`.github/actions/read-token`: contents and pull requests read, for the
repositories `scripts/ci/read-scope.mjs` lists. Those are the caller's and every
catenahq repository that the lock files at the pull request's base and head
commits and its body's Depends-on lines name, each once, or for the updater
those the Depends-on lines of every open pull request name; more than 15 fail
the job. The scripts read with it as `GH_READ_TOKEN` and write with `GH_TOKEN`.
`scripts/ci/read-scope.test.mjs` drives the list with a `gh` stub on `PATH`.

| Input | Meaning |
| --- | --- |
| `runner` | Required. The runner label of every job. |
| `apps` | `true`: the `ci / gate` status and the updater also wait for the `app-tests` status, and `dispatch` and `tag` run. It must match whether the caller's `.github/checks.yml` declares `apps`. Default `false`. |
| `release` | `true` for a repository released from its `release` branch: `release` runs. Default `false`. |
| `step`, `version` | The release step (`cut`, `tag`, `merge-back`) and version (`vX.Y.Z`) of a `workflow_dispatch` run. Default empty. |

- `depends` runs on `pull_request_target` and posts the commit status `ci /
  gate` of the pull request head with `gate-status.mjs`, waiting for app-tests
  when the base commit's `.github/checks.yml` declares `apps`, with the input
  `apps` as the cross-check (`--apps-from`, `--expect-apps`), with `contents:
  read`, `statuses: write`, `pull-requests: read` and `checks: read`, and the
  read-only token of the CI App, minted in the caller's environment `ci`. An
  edited body changes the status at once, without a new check run. Statuses
  are per commit: a second pull request from the same head into another base
  can overwrite the status; the gate and the required check judge each
  branch's own pull request.
- `update` runs on `push`, `workflow_run`, `schedule` and on
  `pull_request_target` of type `auto_merge_enabled`, in the caller's
  environment `ci` (`deployment: false`). It mints a token of the CI App from
  the environment's `RENOVATE_APP_CLIENT_ID` and `RENOVATE_APP_PRIVATE_KEY` for
  this repository alone, with contents, pull requests, statuses and workflows
  write (updating a branch writes a ref whose new
  history can hold the base's workflow changes) and checks read, and the
  read-only token, and runs `scripts/ci/update.mjs` with them; the job holds
  `contents: read` and `pull-requests: read`. Its concurrency group is
  `update-<owner/name>` without `cancel-in-progress`: one updater runs per
  repository, and a newer run replaces the one waiting.
- `dispatch`, with `apps`, runs on the `workflow_run` of a `ci` run of a pull
  request of this repository that was not cancelled, and sends its app to the
  app tests (see "App dispatch").
- `tag`, with `apps`, runs on a `push` to the default branch and tags the apps
  of the pull request merged as the pushed commit (see "App tag").
- `release`, with `release`, runs on a `workflow_dispatch` on `main` and runs
  the step it names (see "Release").
- `policy` runs on `pull_request_target` of type `opened`, `synchronize` and
  `reopened`, and of type `edited` when the base changed, and posts the commit
  status `workflow policy` of the head (see "Workflow policy").

`update` runs the updater with the token as `GH_TOKEN`, and `--sha` on
`workflow_run` the head the `ci` run judged:

    node update.mjs --repo <owner/name> --event <name> [--sha <run head>] [--apps]

On every event, for each of the bases `main` and `release`, the candidates are
its open pull requests with auto-merge on, oldest first:

- When a candidate that is not `BEHIND` or `DIRTY` has its `ci / gate` check
  run queued or in progress, nothing is updated: that one merges next, and
  another updated now would fall behind again at its merge.
- Otherwise the oldest candidate that is not a draft, is `BEHIND`, has a `ci /
  gate` check run of GitHub Actions that succeeded on its head, with `--apps`
  has a newest `app-tests` status of `success`, and has no open Depends-on
  pull request, is updated with `PUT repos/<r>/pulls/<n>/update-branch` and
  `expected_head_sha` set to the head it read. The update pushes a commit, so
  `ci` runs again on it and its `workflow_run` runs the updater again. A failed
  update is printed as an error and added to the job summary, the next
  candidate is tried, and the run fails once every base is done.
- Every other candidate is skipped with its reason printed: `DIRTY`, any other
  merge state (`not behind its base (<state>)`), draft, no gate check run, a
  gate check run going or not successful, app-tests not passed, the first open
  Depends-on.

The updater trusts the `ci / gate` check run of GitHub Actions, the result of
the checks. The commit status of the same name, which `gate-status.mjs` posts,
carries the Depends-on and app-tests verdicts, and the updater reads those
from their sources itself. A check run of another App is ignored: any App
with checks write can create a check run of any name.

The updater writes to its own repository only. On `workflow_run` without
`--apps`, each open pull request of this repository whose head is the one the
`ci` run judged gets its `ci / gate` status recomputed and posted, as
`gate-status.mjs` does: the `gate` job of a pull request from a fork posts
none, and `depends` ran before its checks ended. With `--apps`, `dispatch`
posts it after the same run. On `schedule`, every open pull request of this
repository gets its status recomputed, waiting for app-tests with `--apps`.
That is how a merged Depends-on pull request reaches its dependents, in any
repository: each repository's hourly run recomputes its own, so a merge
reaches them within the hour, and a newer updater run that replaced a waiting
one is caught up the same way.

A GitHub API error exits 1 and nothing after it runs: a failed query never
reads as "no candidate". Bad arguments exit 2. `scripts/ci/update.test.mjs`
drives the script with a `gh` stub on `PATH` and payloads shaped as GitHub
returns them, under `scripts/ci/fixtures/update/`.

### App dispatch

The `dispatch` job of `control.yml` asks the app tests of catenahq/ops to run
the app a pull request changes, once its `ci` run completed. `workflow_run`
lists no pull request of a fork, so the job runs for a pull request of the
caller's own repository only. It runs in the caller's environment `ci`, where
it mints a CI App token that writes to ops alone, and holds `contents: read`,
`statuses: write`, `pull-requests: read` and `checks: read`. A newer head of the same pull
request cancels the send still running for an older one.

The tools are the base's: the caller is checked out at the default branch, the
`apps` key of its `.github/checks.yml` is read with `checks-matrix.mjs`, and the
tools are that tree with `apps.catalog: true`, else catena-templates at its
lock under `.tools`. The pull request head is checked out under `pr/` with its
history and tags, and is data only: the tools read it with git through
`TEMPLATES_ROOT`, uv runs in the tools' own project with `UV_NO_CONFIG=1`, and
nothing of it runs. `scripts/ci/app-dispatch.sh` then:

- reads the pull request, and stops when it is closed or its head is no longer
  the commit the `ci` run judged: the run of the newer head sends it;
- judges the change from where the head left its base branch, fails on a
  change of more than one app (`build/versions.py scope`), and lists the apps it
  touches and still has (`build/app_check.py changed`), each id matching
  `^[a-z0-9][a-z0-9-]*$`;
- with no app, posts the `app-tests` status `success`, `no app changed`, and
  sends nothing;
- for one app, carries the verdict of the first of these that holds the same
  change: the head, the pull request's earlier commits (`pulls/<n>/commits`)
  newest first, and with `success` the run that made the app's newest tag
  (`build/versions.py tested-run`). A verdict counts when it is the newest
  `app-tests` status of the commit, posted by the CI App with the address of an
  ops run, its description names exactly the app (`passed 1 app(s): <id>` or
  `failed: <id>`, each with an optional note), and `build/versions.py same`
  finds the app's files differ in presentation alone;
- reads `catenahq/ops` and `catenahq/contracts` from the head's
  `.github/catenahq.lock` (a missing line fails the step), and sends the
  `repository_dispatch` event `app-test` to ops with the payload `{sha, base,
  ids, ref, repo, carry, carry_state, own_images, ops_sha, contracts_sha, pr}`:
  the head, the commit it is judged from, the app, the head branch, the
  repository's name, the carried run and its state (both empty when the app
  runs), `apps.own-images` joined by commas, the two locked commits and the
  pull request number.

The job then posts the `ci / gate` status with `gate-status.mjs --app-tests`,
reading the dependencies with the read-only token.
A GitHub API or git error fails the step: a failed read is never "no verdict".

### App tag

The `tag` job of `control.yml` runs on a push to the default branch, in the
caller's environment `ci`, with `contents: read`, `statuses: read` and
`pull-requests: read`. It checks the pushed commit out with its history and
tags, takes the tools as `dispatch` does, and mints a CI App token for the
caller with `contents: write` and `workflows: write` (writing a ref takes the
workflows permission when the tagged history holds workflow changes): the App
is the one actor the tag ruleset lets create or move a `*/*` tag.
`scripts/ci/app-tag.sh`:

- finds the pull request merged as the pushed commit
  (`repos/<r>/commits/<sha>/pulls`, `merge_commit_sha` equal to it; asked again
  after 10 seconds, since the list can lag the merge); none tags nothing;
- reads the newest `app-tests` status of its head: `no app changed` tags
  nothing; anything else than a `success` of the CI App, with the address of an
  ops run and a description that names its apps (`passed <n> app(s): <id>, ...`),
  fails the job;
- fetches the head by its id when the merge left it out of the history, and
  for each app checks with `build/versions.py same` that the app's files at the
  pushed commit, judged from its first parent, are the change that passed at
  the head, in presentation alone; a difference fails the job;
- plans each app's tag with `build/versions.py plan --ref <sha>` and writes it
  through the API: `create TAG` an annotated tag on the pushed commit,
  `create TAG FROM` the same whose annotation adds that the runtime and tests
  are FROM's, `mark TAG` annotates a tag made by hand where it stands, `skip`
  writes nothing. The annotation opens with `app-tests passed at <head>:
  <run>`. A tag another run created first makes the job read the tags again and
  plan the app once more, up to three times.

Every merge passed `ci / gate`, which waits for `app-tests`, so a tag needs no
other check. `scripts/ci/app-dispatch-tag.test.mjs` drives both scripts over
scratch git repositories with stubs for `gh`, `uv` and `sleep` on `PATH`.

### Release

A repository released from its `release` branch passes `release: true` and
starts each step by hand with its `ci-control.yml` `workflow_dispatch` on
`main`, with the inputs `step` and `version`. A push to `release` runs the
caller's release checks (its `ci.yml` lists `push: [release]`), fixes land on
`release` by pull request, and the publish workflows run on the tag.

The `release` job runs in the caller's environment `ci` (`deployment: false`),
which holds the CI App's key for every job that mints its token, with
`contents: read`. It mints a CI App token for the caller with contents, pull
requests and workflows write (writing a ref takes the workflows permission
when the history it adds holds workflow changes), so no step needs an
administrator. One step runs per repository at a time and none is cancelled.
`scripts/ci/release.sh` writes everything through the API, with no checkout of
the caller:

- `cut` moves `release` to the head of `main`: `PATCH
  repos/<r>/git/refs/heads/release` with that commit and `force=false`, a
  fast-forward only. It refuses while a pull request with a `merge-back/` head
  is open, or while `release` holds commits `main` lacks (the comparison of
  `release` with `main` is `behind` or `diverged`): the last release is not
  merged back yet. A `release` identical to `main` writes nothing. It takes no
  version and ignores one given.
- `tag` refuses an empty `version` (the caller's input is optional, since
  `cut` takes none) and one outside `^v[0-9]+\.[0-9]+\.[0-9]+$`, then writes
  the annotated tag `<version>` on the head of `release`: `POST git/tags`, then
  `POST git/refs` with the tag object. A tag of that name elsewhere refuses;
  one already on the head of `release` writes nothing.
- `merge-back` refuses an empty or bad version and a missing tag. When the tag's commit
  holds commits `main` lacks, it makes the branch `merge-back/<version>` at
  that commit, opens the pull request into `main`, waits up to a minute for
  GitHub to compute whether it merges, and turns its auto-merge on with a
  merge commit (`gh pr merge --auto --merge`). A conflict, which comes only
  from a `main` that changed since the cut, fails the step with the branch
  and the pull request left open: a person resolves it on the branch, and the
  step run again takes the branch when it holds the tag's commit, and the open
  pull request. Nothing is force-pushed.

The next `cut` refuses until the merge-back has merged. A failed GitHub API
call fails the step: a
failed read never counts as "no pull request open" or "no tag". Every value is
validated before use; inputs reach the script through `env:` only.
`scripts/ci/release.test.mjs` drives the script with stubs for `gh` and
`sleep` on `PATH`.

### Workflow policy

The `policy` job of `control.yml` judges what a pull request makes CI run. It
runs in the caller's environment `workflow-policy` (`deployment: false`),
whose branch rule admits `main` and `release`, the bases a pull request
targets, and which holds the policy App's `POLICY_APP_CLIENT_ID` and
`POLICY_APP_PRIVATE_KEY`, with `contents: read` and `pull-requests: read`. When
`POLICY_APP_CLIENT_ID` is empty it prints a notice and posts nothing. Otherwise
it mints a policy App token for this repository alone (contents and pull
requests read, statuses write) and a read-only policy App token of the
repositories the pull request names (see "Control workflow"), for the
comparisons of the rule `merged`, loads `scripts/ci/workflow-policy.mjs` from
contracts at `job.workflow_sha`, and:

- `fetch` writes every file under `.github/` and every file the pull request
  changes, as they are at its head, into `$RUNNER_TEMP/policy/pr/`, the
  workflows of the event's base commit into `$RUNNER_TEMP/policy/base/`, and the
  changed paths into `changed.json`, through `gh api
  repos/<r>/contents/<path>?ref=<sha>`: the pull request is never checked out
  and nothing of it runs. A symbolic link under `.github/` is left out;
  a pull request of 3000 files or more fails, past what the API lists. In the
  copies of the workflows and actions every inline `# zizmor:` directive is
  dropped, so the pull request suppresses no finding, and a `ci-control.yml`
  of the caller shape (rule `ci-control`) gets `# zizmor:
  ignore[dangerous-triggers]` on its `pull_request_target:` and
  `workflow_run:` lines, each of which zizmor reports: the caller runs on
  those triggers by design;
- scanctl, built by `.github/actions/scanctl`, runs zizmor alone over
  `$RUNNER_TEMP/policy/pr/` (`scripts/ci/workflow-policy-scanctl.yml`), its
  summary in the job summary;
- `check` runs the rules below, writes the job summary and posts the commit
  status `workflow policy` on the head with the App token: `success`, or
  `failure` with the rules that failed. A step that fails before the verdict
  is posted posts `error`.

The rules, each named in the summary:

- `yaml`: every workflow and action parses.
- `pinned`: every `uses:` other than a `./` path is pinned by a 40-hex commit
  with a version comment on its line (`# v7`, `# main`); a `docker://` image by
  its digest.
- `merged`: every first-party commit a `uses:` pins and every line of
  `.github/catenahq.lock` is an ancestor of the repository's `main`: the
  compare API reads `ahead` or `identical` for `compare/<sha>...main`. A
  first-party pin in a workflow is also the base's pin of the same workflow
  file and referenced path, or a descendant of it (`compare/<base
  pin>...<pin>` is `ahead` or `identical`), so no pin moves back; a pin the
  base file does not have passes that test. A `uses:` is first-party when its
  owner is the repository's in any case: GitHub resolves owner and repository
  names without regard to case. The comparisons use the read-only token
  (`GH_READ_TOKEN`), and a failed comparison fails the rule.
- `secrets-inherit`: no job passes `secrets: inherit`.
- `permissions`: every job gets its permissions from its own `permissions:`
  block, else from the workflow's; they name each scope, and ask for no scope
  wider than the job's ceiling in `scripts/ci/workflow-policy.json` under
  `<repository>:<workflow file>:<job>`. A job with neither block fails. A job
  that asks for nothing needs no ceiling.
- `pull-request-target`: no job of a workflow run on `pull_request_target`, or
  of a workflow of the tree it calls, checks out the pull request's head or
  fetches it with git.
- `secrets`: every `secrets.<NAME>` and every secret a job passes is in the
  `secrets` of `scripts/ci/workflow-policy.json`, or is `GITHUB_TOKEN`; no secret
  is named by an index expression.
- `gate-needs`: in each base workflow with a `gate` job, `gate` and every job it
  needs stay, stay in its `needs`, get no new `continue-on-error`, and keep
  their `if:`.
- `ci-gate`: only the job `ci` of `ci.yml`, calling contracts' `pr.yml`, can
  yield the check name `ci / gate`; a job name with an expression can be
  anything.
- `ci-control`: a `.github/workflows/ci-control.yml` is the caller shape: one
  job, calling `<owner>/contracts/.github/workflows/control.yml` at a 40-hex
  commit, with no key but `uses`, `permissions` and `with` (no steps).
- `zizmor`: scanctl passed.

The summary also lists each changed path that runs in CI or decides what
runs: under `.github/actions/`, `scripts/`, `ci/`, `build/` or `.scanctl/`,
`.github/checks.yml`, `scanctl.yml`, and the lock files.

`scripts/ci/workflow-policy.json` is read at the contracts commit the caller
pins, so a pull request cannot widen its own ceilings. It holds `secrets`, the
secret names, and `permissions`, the ceiling of each job. A missing ceiling
fails with the key to add. When a caller's job needs more, add or widen its key
in contracts first, then pin the caller at that commit.

    node scripts/ci/workflow-policy.mjs --seed [--local <repo>=<checkout>]... [--out <file>]

writes the file (default `scripts/ci/workflow-policy.json`) from every
workflow of every repository that calls these workflows: contracts from this
tree, a repository named with `--local` from that checkout's working tree,
each other one from its default branch through the contents API, read as
data. Each job's permissions, its own block or the workflow's, are its
ceiling; every `secrets.<NAME>` and every secret a job passes is an allowed
name. The `ci.yml` and `ci-control.yml` templates above add their ceilings for
each repository, the wider level of a scope winning. A failed read or a
workflow that does not parse writes nothing and exits 1.

Every repository has a `.github/CODEOWNERS` covering the paths whose code runs
in CI; it asks for the owner's review, and no review is required. Every
repository:

```
/.github/ @ma-lalonde
/ci/ @ma-lalonde
```

contracts adds `/scripts/ @ma-lalonde`, and catena-templates adds
`/build/ @ma-lalonde` and `/lib/ @ma-lalonde`. `/.github/` covers
`.github/actions/` and `.github/catenahq.lock`.

`scripts/ci/workflow-policy.test.mjs` drives the script with a `gh` stub on
`PATH` over the tree under `scripts/ci/fixtures/workflow-policy/`, which passes
every rule, over copies of it edited so that one rule fails, and runs `--seed`
over stubbed repositories.

## How to change a contract

1. Update the artifact (e.g. `pricing/tiers.json`) and run this repo's
   gates: `npm test`, `npm run check:unicode`, `npm run check:prose`.
   A change to `core-app-names.json` moves the consumers' app-name debt:
   run their `check-core-app-names.mjs --update` after it, then add by
   hand each new name an accepted file holds.
2. Run each consumer's own gates against the change: they read this
   checkout, so the change reaches them on their next build.
3. Put a change that consumers must follow on a branch of the same name
   in each repo. CI checks each sibling out at the consumer's branch, so
   the change and its consumer migrations are tested together and land
   together.

## What does NOT live here

- App-specific copy or layout. Per-app strings stay in each app's
  own `src/i18n/`.
- Secrets, env vars, deployment configuration. Those live in
  catenahq/ops.
- Stripe / Keycloak / Cloudflare API keys. Same as above.
- Backlog, runbooks, or any prose that is documentation rather
  than data.

## LICENSE

CC BY-SA 4.0 -- see [LICENSE](LICENSE). This repo is public: the legal
texts, pricing metadata and brand tokens rendered on catena.run are
verifiable here at their exact accepted versions (see `legal/msa.json`
for the commit-SHA pin).
