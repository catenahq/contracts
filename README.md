# catenahq/contracts

Single source of truth for everything that more than one catena repo
depends on. Consumers read this repo as a sibling checkout, so one copy
of each fact serves every repo.

## What lives here

| Directory | Contract | Primary consumers |
|-----------|----------|-------------------|
| `brand/`  | Design tokens (CSS variables) + Conthrax wordmark binary + catena logo SVG | catenahq/website, catenahq/docs |
| `pricing/`| Pricing metadata: one flat plan (monthly price per server) plus the a-la-carte hourly rates and their billing increment | catenahq/website (renders the plan price in its pricing matrix) |
| `legal/`  | Canonical MSA markdown + version pin (commit SHA) + effective date + published URL | catenahq/website (renders `/legal/master-agreement`) |

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
else at the default branch.
The scripts under `scripts/` (unicode, prose, repo-rule and core-app-name
gates, and the brand-asset sync each site runs on install) run from that
checkout the same way. The core-app-name gate takes the roots to scan as
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
