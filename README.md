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
alongside itself with `.github/actions/checkout-sibling`, at the branch
the consumer runs on when this repo has it and a bot did not name it,
else at the default branch. A run on its own repository's default branch
takes the default branch here too.
The scripts under `scripts/` (unicode, prose, repo-rule and core-app-name
gates, and the brand-asset sync each site runs on install) run from that
checkout the same way. The repo-rule gate refuses a tracked env file, a
tracked `.agent` path (on every branch the repo's CI runs on, so an agent
branch that holds `.agent/` fails it until a later run removes it) and a branch
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
one `<owner/name>=<branch>` line per sibling, sorted, naming the branch
`checkout-sibling/resolve.sh` picks (the default branch by name when it picks
none). Trees and parents come from the commits API, so no checkout is needed.
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
- completed with `success`, or with `failure` from the same event as this run
  (cancelled, skipped or timed out is not a result). A push judges the
  absolute gate and a pull request only new failures, so a failure never
  crosses between them; a success carries both ways.

A found success sets `run` to `false`. A found failure does too, and fails the
step, so the gate job turns red. Either prints
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
| `siblings` | owner/name list: every repository the workflow checks out with checkout-sibling. |
| `branch` | Passed to the sibling resolution in place of the run's branch (a tag push has none). |
| `source-events` | Events a source run may have. Default `push pull_request schedule`. |
| `wait-minutes` | Default 30 on a `pull_request`, 0 on other events, so a push never waits. |
| `record` | Default `true`: a single commit that runs on a push, pull request or schedule is recorded. |
| `token` | Reads this repository's runs, artifacts and commits. Default `github.token`; the job grants `contents: read` and `actions: read`. |
| `sibling-token` | Reads the siblings' branches. Default `github.token`; a private sibling needs the token the workflow's checkout-sibling steps pass. |

| Output | Meaning |
| --- | --- |
| `run` | `true` when the checks run, `false` when a result is reused. |
| `state` | `success` or `failure` when reused, else empty. |
| `source` | The URL of the reused run. |
| `results` | Lines of `<sha> <state> <url>`, one per commit with a result. |

```yaml
  same-tree:
    name: same tree (ci)
    runs-on: ubuntu-latest
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
