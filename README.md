# catenahq/contracts

Single source of truth for everything that more than one catena repo
depends on. Each artifact here is a versioned contract; consumers
pin a tag (or a git SHA) and bump it deliberately. Drift between
repos is now a code review concern, not an invisible regression.

## What lives here

| Directory | Contract | Primary consumers |
|-----------|----------|-------------------|
| `brand/`  | Design tokens (CSS variables + JS exports) + Conthrax helper | catenahq/website, catenahq/docs, catenahq/portal |
| `pricing/`| Per-tier metadata (5 tiers, kind discriminator, support hours, employee cap, minimum commitment) + operator-wide knobs (hourly rate, per-extra-app, ETF multiplier) | catenahq/portal (UI + billing), catenahq/website (pricing page), catenahq/ops (installer prompts) |
| `legal/`  | Canonical MSA markdown + version pin (commit SHA) + effective date + published URL | catenahq/portal (terms_version column + checkbox), catenahq/website (renders `/legal/master-agreement`) |

Add a new directory whenever a fact lives in more than one repo. Do
NOT add app-specific copy, operator-only configuration, or anything
under active iteration that doesn't have a stable shape yet -- those
belong in the consuming repo until they stabilize.

## How consumers depend on it

Each consumer adds the dep to its `package.json`:

```json
{
  "dependencies": {
    "@catenahq/contracts": "github:catenahq/contracts#v0.1.0"
  }
}
```

Tagged releases are the unit of bump. Renovate (or Dependabot) opens
PRs against each consumer when a new tag lands. For local
development against an unreleased change, override via npm overrides
or by symlinking.

Direct file imports:

```js
import tiers from "@catenahq/contracts/pricing/tiers.json";
import { breakpoints, minWidth, accent } from "@catenahq/contracts/brand";
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

## How to bump a contract

1. Open a PR against this repo.
2. Update the relevant artifact (e.g. `pricing/tiers.json`).
3. Bump `version` in `package.json` to the next semver:
   - major if any shape changes (breaking)
   - minor for new keys / new files
   - patch for value-only bumps
4. CI validates JSON parses and `brand/test.js` still passes.
5. Merge to main.
6. Tag the merge commit: `git tag -a vX.Y.Z -m "..." && git push --tags`.
7. Each consumer's `.github/workflows/contracts-update.yml` polls
   this repo (weekly schedule + on-demand via workflow_dispatch).
   When it sees a new tag or a content drift, it re-packs the
   tarball, replaces the vendored copy, and opens a "contracts:
   bump to vX.Y.Z" PR against itself.
8. Review + merge each consumer PR. Verify the new contract is
   consumed correctly (e.g. portal's tier rendering matches the new
   `tiers.json`).

To force a bump immediately (e.g. urgent fix): go to each consumer's
`Actions -> Check for contracts updates -> Run workflow`.

Why pull-from-consumers, not push-from-contracts: a single read-only
token (per consumer, scoped only to this repo) is a much smaller
blast radius than a write-many token on every consumer. Consumers
also stay in control of their own cadence -- a contracts bump that
needs careful review of pricing/tier renaming can sit in PR review
without blocking the contracts repo.

## What does NOT live here

- App-specific copy or layout. Per-app strings stay in each app's
  own `src/i18n/`.
- Secrets, env vars, deployment configuration. Those live in
  catenahq/ops.
- Stripe / Keycloak / Cloudflare API keys. Same as above.
- Backlog, runbooks, or any prose that is documentation rather
  than data.

## LICENSE

Pick a license before the first public push. Recommended: CC BY 4.0
(matches the existing license precedent on catenahq/docs +
catenahq/website for brand-adjacent material). AGPL or MIT also
defensible.

## Repo split status

This is the 5th repo in the catenahq split (alongside ops, website,
docs, portal). Origin commit lands once `package.json` + initial
content is reviewed. See catenahq/ops
`internal_docs/operator/repo-split-runbook.md` for the broader
context.
