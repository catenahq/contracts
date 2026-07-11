# pricing/

Composable pricing metadata: per-server + per-app recurring components,
optional monthly support packs, one-time installer fees, and the
operator-wide pricing knobs (a-la-carte hourly rates by time-of-day,
custom-template setup, ETF multiplier, minimum commitment, support
billing increment).

Consumers:

- **catenahq/ops**: `operator-tools/generate-sizing-doc.py` imports
  `pricing/tiers.json` to render monthly-cost columns in the sizing
  docs (client docs + sales discovery sheet). Today this is the only
  code consumer.
- **catenahq/website**: the pricing matrix and FAQ copy in
  `src/i18n/*/common.json` are hand-synced to these values (the site
  does not import the JSON). The website is the master for what the
  offer SAYS; this file must be kept numerically in line with it.
- **catenahq/portal**: intended consumer for the order form's
  composition picker + Stripe wiring; not wired up yet (its pricing.ts
  predates the composable model).

## Schema

`tiers.json` (filename retained for backward-compatible imports):

```json
{
  "currency": "CAD",
  "supportIncrementMinutes": <int>,
  "customTemplateSetupCents": <int>,
  "earlyTerminationFeeMultiplier": <float, 0..1>,
  "managedMinimumCommitmentMonths": <int>,
  "alacarteHourlyCents": {
    "day": <int>,
    "evening": <int>,
    "night": <int>
  },
  "components": {
    "server": {
      "id": "server",
      "displayName": { "en": "...", "fr": "..." },
      "tagline":     { "en": "...", "fr": "..." },
      "monthlyPriceCents": <int, > 0>,
      "stripePriceId": "<Stripe price id>" | null
    },
    "app": {
      "id": "app",
      "displayName": { "en": "...", "fr": "..." },
      "tagline":     { "en": "...", "fr": "..." },
      "monthlyPriceCents": <int, > 0>,
      "stripePriceId": "<Stripe price id>" | null
    }
  },
  "supportPacks": [
    {
      "id": "pack_5h" | "pack_10h" | "pack_20h" | ...,
      "displayName": { "en": "...", "fr": "..." },
      "hours": <int, > 0>,
      "monthlyPriceCents": <int, > 0>,
      "stripePriceId": "<Stripe price id>" | null
    }
  ],
  "installers": [
    {
      "id": "base" | "assisted" | ...,
      "displayName": { "en": "...", "fr": "..." },
      "tagline":     { "en": "...", "fr": "..." },
      "oneTimePriceCents": <int, > 0>,
      "stripePriceId": "<Stripe price id>" | null
    }
  ]
}
```

- `id` is the stable key. Never rename in place -- add a new id and
  flag the old one deprecated for one release cycle, then drop.
- The model is composable: a Client buys an installer once + the
  server component monthly + N app components monthly + optionally
  one support pack monthly. There is no tier ladder.
- All prices are integer CAD cents. No floats, no currency string.
- `stripePriceId` is `null` until the operator creates the Stripe
  Product + Price for that component / pack / installer. The portal
  fails closed (refuses to authorize / create a Subscription) when
  null AND the relevant price > 0.
- `supportPacks` may be `[]` (a-la-carte-only); the portal would
  bill all support hours at the `alacarteHourlyCents` rates in that
  case.

## Bump

- Price change (server, app, pack, installer, a-la-carte rate): bump
  `monthlyPriceCents` / `oneTimePriceCents` / `alacarteHourlyCents.*`
  + cut a **patch** release. Consumers re-pull on next cron.
- New support pack, new installer, new top-level optional field: cut
  a **minor** release. Consumers add UI rendering in their next PR.
- Shape change (renamed field, removed field, removed component): cut
  a **major** release. Coordinate consumer migrations in the PR
  description.

## History

- v2.0.0 (2026-07-11): repo slim at first public release. Dropped the
  never-consumed `tiers.d.ts` (portal kept a local interface; portal is
  being retired) and the unused `brand/src/` JS entry (`./brand`
  export). Major because an export was removed, even though no consumer
  imported it.
- v1.0.2 (2026-07-09): server component $200 -> $100/month, matching
  the website pricing matrix (Pro "$100 / month" per server; the
  website is the offer master). Patch release.
- v1.0.1 (2026-06-12): support packs delisted. `supportPacks` is now
  `[]` (a-la-carte-only): all support time bills at
  `alacarteHourlyCents`. The field + `SupportPack` type are retained
  for backward compatibility, so this is a value change (patch), not a
  shape change. The portal dropped the pack picker; the marketing site
  removed the pack cards.
- v1.0.0 (2026-05-21): composable model. Replaces the v0.3.x
  named-tier ladder (Base / Assisted / Small / Medium / Large).
  Consumer migration required for portal and any operator tooling
  that imported `TierKey`.
