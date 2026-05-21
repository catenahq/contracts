# pricing/

Composable pricing metadata: per-server + per-app recurring components,
optional monthly support packs, one-time installer fees, and the
operator-wide pricing knobs (a-la-carte hourly rates by time-of-day,
custom-template setup, ETF multiplier, minimum commitment, support
billing increment).

Consumers:

- **catenahq/portal**: renders the order form's composition picker
  (installer + apps + support pack), drives Stripe authorize-at-submit
  (installer fee) + multi-item Subscription creation on install
  success (server + N apps + optional pack), enforces the minimum
  commitment via ETF on cancel-before-month-N.
- **catenahq/website**: renders `/pricing` (FR + EN) and the example
  configurations on the marketing site.
- **catenahq/ops**: the installer prompts read the composition to
  scope sizing + backup retention.

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

TypeScript consumers import the typed view via `tiers.d.ts`.

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

- v1.0.0 (2026-05-21): composable model. Replaces the v0.3.x
  named-tier ladder (Base / Assisted / Small / Medium / Large).
  Consumer migration required for portal and any operator tooling
  that imported `TierKey`.
