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
  `scripts/ci/checks-matrix.mjs`, and drops each entry, and the scan, that an
  earlier run passed with the same key (see "Per-check reuse"). Its output
  `matrix` holds the entries left, `run` is `false` when none is left, `scan`
  is the scan settings (JSON) and `scan-run` is `true` when checks.yml has a
  `scan` key and the scan is not reused. It also bundles each private sibling
  an entry left names (see "Private siblings").
- `check (<name>)`, one per matrix entry, when `run` is `true`: the caller (two
  commits deep) and `.catena-ci/` again, each sibling the entry names through
  checkout-sibling at the caller's lock, or from its bundle, the entry's tools
  (Node 26 when it names no Node), the reuse record, then `bash ci/run <name>` in
  `ws/<repo>`. The entry `gates` runs the contracts gates of the locked
  contracts checkout instead: unicode, repo rules and whole-tree prose always,
  the core-app-name gate with its arguments, jscpd 4.3.0 with `duplication`.
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
  or skipped.

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
```

A sibling is one of `catena-admin`, `catena-ce`, `catena-templates`,
`contracts`, `docs` and `ops`, and needs a line in the caller's lock; `gates`
needs the contracts line. A check sibling's `token` must name a secret `pr.yml`
declares in `on.workflow_call.secrets`: `CATENA_EE_READ_TOKEN`. A scan sibling
takes no `token`. A check's `go: <sibling>/go.mod` needs that sibling in the
check's `siblings`. A check with `go-cache: true` needs `tools.go`. No check may
be named `gates`.

The parser prints one line of JSON: `include`, the matrix, and `scan`. Each
entry carries `inputs` (`["."]` when the check names none, and for `gates`)
and every tool, sibling and gate key; a sibling's value is its fetch
depth, `bundle` for one with a `token`, or empty when the check does not use
it. `go-file` is the go.mod setup-go reads, `ws/<repo>/go.mod` for `go.mod`
and `ws/<sibling>/go.mod` for `<sibling>/go.mod`, empty for an exact version.
`scan` carries every key too, with `enabled` false when checks.yml has none,
and `own-images` joined by spaces:

```json
{"include":[{"name":"go","runs-on":"catena-ci","timeout":40,"go-cache":true,"inputs":["."],
  "tools":{"node":"","uv":"","go":"go.mod","go-file":"ws/catena-admin/go.mod","staticcheck":"","staticcheck-sha256":""},
  "sib":{"catena-admin":"","catena-ce":"0","catena-templates":"","contracts":"1","docs":"","ops":""},
  "gates":{"core-app-names":[],"duplication":false}}],
 "scan":{"enabled":true,"profile":"full","own-images":"catena-admin:ci","image-inputs":["Dockerfile"],
  "sib":{"catena-admin":"","catena-ce":"0","catena-templates":"","contracts":"","docs":"","ops":""},
  "tools":{"go":"go.mod"}}}
```

Run the parser from a caller's checkout to see its plan; `--repo` is the
caller's repository name:

    node ../contracts/scripts/ci/checks-matrix.mjs --repo catena-admin --runner catena-ci

It needs `npm ci --prefix scripts/ci` once (npm `yaml`, locked in
`scripts/ci/`, outside the package consumers link).
`scripts/ci/checks-matrix.test.mjs` runs it over the checks of ci-runner,
catena-admin and ops, their scan settings, and each key it refuses.

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
- `date=<UTC yyyy-mm-dd>` for the scan, whose findings follow the
  vulnerability feed.

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
caller's code. For each such sibling an entry left after reuse names, it checks
the sibling out through checkout-sibling with the token at the caller's lock
(`fetch-depth: 0`), writes `git bundle create <repo>.bundle HEAD`, and uploads
the bundles as the artifact `sibling-bundles`, kept 1 day. Its output
`bundle-shas` maps each bundled sibling to its commit
(`{"catena-admin":"<sha>"}`). Reuse reads the siblings' branches with the same
token. A check that names a bundle sibling downloads the artifact, runs
`git clone --no-checkout` of the sibling's bundle into `ws/<repo>`, and checks
the recorded commit out detached.

`plan` fails when a check names a bundle sibling and the caller passes no
secret, or the caller is a public repository: anyone who can read a public
repository can download its artifacts.

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
`go build`: `sha` checks catenahq/scanctl out under `.scanctl-src`, `self:
'true'` builds `ws/scanctl`. Go comes from the go.mod of the tree it builds.

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
