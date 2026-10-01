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
the consumer runs on when this repo has it, else at the default branch.
The scripts under `scripts/` (unicode, prose and repo-rule gates) run
from that checkout the same way.

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

## How to change a contract

1. Update the artifact (e.g. `pricing/tiers.json`) and run this repo's
   gates: `npm test`, `npm run check:unicode`, `npm run check:prose`.
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
