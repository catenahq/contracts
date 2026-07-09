# catenahq/contracts

Single source of truth for everything that more than one catena repo
depends on. Each artifact here is a versioned contract; consumers
pin a tag (or a git SHA) and bump it deliberately. Drift between
repos is now a code review concern, not an invisible regression.

## What lives here

| Directory | Contract | Primary consumers |
|-----------|----------|-------------------|
| `brand/`  | Design tokens (CSS variables + JS exports) + Conthrax wordmark binary + catena logo SVG | catenahq/website, catenahq/docs, catenahq/portal |
| `pricing/`| Composable pricing metadata (server + per-app monthly components, installers, a-la-carte hourly rates, ETF multiplier, minimum commitment -- no tier ladder since v1.0.0) | catenahq/ops (sizing-doc generator; today's only code consumer), catenahq/website (hand-synced pricing matrix -- the site is the offer master), catenahq/portal (intended, not yet wired) |
| `legal/`  | Canonical MSA markdown + version pin (commit SHA) + effective date + published URL | catenahq/portal (terms_version column + checkbox), catenahq/website (renders `/legal/master-agreement`) |

Add a new directory whenever a fact lives in more than one repo. Do
NOT add app-specific copy, operator-only configuration, or anything
under active iteration that doesn't have a stable shape yet -- those
belong in the consuming repo until they stabilize.

## How consumers depend on it

Each web consumer (website, docs, portal) declares a sibling-directory
read in its `package.json`:

```json
{
  "dependencies": {
    "@catenahq/contracts": "file:../contracts"
  }
}
```

npm symlinks `node_modules/@catenahq/contracts` to the sibling
checkout, so an edit here is visible on the consumer's next dev/build.
CI mirrors the layout: each consumer's workflow checks out this repo
alongside itself using a read-only `CONTRACTS_READ_TOKEN`. There is no
vendored tarball and no freshness gate; to roll out a change, push
here, then push (or re-run CI on) whichever consumer needs the new
value. Tags still mark deliberate versions for humans (see Bump).
catenahq/ops consumes `pricing/tiers.json` the same sibling-path way
from `generate-sizing-doc.py`.

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
7. Consumers pick the change up automatically on their next build
   (sibling read; CI re-clones this repo fresh on every run). Re-run
   or push each consumer whose rendered output should change, and
   verify it consumed the new value (e.g. the ops sizing docs match
   the new `tiers.json`).

Why sibling-read, not vendoring: one read-only token per consumer
(scoped to this repo) and zero copy-sync machinery. The trade-off is
that consumers always build against latest main -- a breaking shape
change must land together with its consumer migrations.

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
docs, portal). The split executed on 2026-05-13. Broader context
lives in the catenahq/ops repo under
`internal_docs/archive/repo-split-runbook.md` (operator-only,
archived after execution).
