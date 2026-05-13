# pricing/

Managed-tier metadata: per-tier id, bilingual display name + tagline,
prices (one-time + monthly), Stripe price id, support hours included,
employee cap, minimum commitment. Plus operator-wide pricing knobs
(hourly support rate, per-extra-app, custom-template setup, ETF
multiplier).

Consumers:

- **catenahq/portal**: renders the order form's tier picker, drives
  Stripe authorize-at-submit (one-time tiers) + Subscription
  creation on install success (recurring tiers), enforces the
  minimum commitment via ETF on cancel-before-month-N.
- **catenahq/website**: renders `/pricing` (FR + EN) and the
  SaaS-cost calculator widget when M7 ships.
- **catenahq/ops**: the installer prompts read tier id to scope
  sizing + backup retention.

## Schema

`tiers.json`:

```json
{
  "currency": "CAD",
  "supportHourlyRateCents": <int>,
  "supportIncrementMinutes": <int>,
  "perExtraAppMonthlyCents": <int>,
  "customTemplateSetupCents": <int>,
  "earlyTerminationFeeMultiplier": <float, 0..1>,
  "tiers": [
    {
      "id": "<kebab-case-stable-id>",
      "kind": "one_time" | "recurring",
      "displayName": { "en": "...", "fr": "..." },
      "tagline":     { "en": "...", "fr": "..." },
      "oneTimePriceCents": <int; 0 for recurring>,
      "monthlyPriceCents": <int; 0 for one-time>,
      "supportHoursIncluded": <int>,
      "stripePriceId": "<Stripe price id>" | null,
      // recurring tiers only:
      "employeeCap": <int>,
      "minimumCommitmentMonths": <int>
    }
  ]
}
```

- `id` is the stable key. Never rename in place -- add a new id and
  flag the old one deprecated for one release cycle, then drop.
- `kind` discriminates billing cadence:
  - `one_time`: charge `oneTimePriceCents` at order acceptance via
    a manual-capture PaymentIntent.
  - `recurring`: create a Stripe Subscription at `monthlyPriceCents`
    on install success; enforce `minimumCommitmentMonths` via an
    early-termination-fee invoice item on cancel-before-month-N.
- All prices are integer CAD cents. No floats, no currency string.
- `stripePriceId` is `null` until the operator creates the Stripe
  Product + Price. The portal fails closed (refuses to authorize /
  create a Subscription) when null AND the relevant price > 0.

TypeScript consumers import the typed view via `tiers.d.ts`.

## Bump

- Price change: bump `monthlyPriceCents` / `oneTimePriceCents` +
  cut a **patch** release. Consumers re-pull on next cron.
- New tier, new top-level field, or new optional per-tier field:
  cut a **minor** release. Consumers add UI rendering in their next
  PR.
- Shape change (renamed field, removed field, kind enum change):
  cut a **major** release. Coordinate consumer migrations in the
  PR description.
