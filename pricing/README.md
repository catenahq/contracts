# pricing/

Managed-tier metadata: tier id, bilingual display name, monthly
price (in CAD cents), and the Stripe price id that materializes the
subscription item. One row per tier.

Consumers:

- **catenahq/portal**: renders the order form's tier picker
  (`OrderForm.tsx`), creates the Stripe Subscription on install
  success (`stripe_charges.ts`).
- **catenahq/website**: renders `/pricing` (FR + EN) and the
  SaaS-cost calculator widget when M7 ships.
- **catenahq/ops**: the installer prompts (`automation/menu/flows.py`)
  read tier id to scope sizing + backup retention.

## Schema

`tiers.json`:

```json
{
  "tiers": [
    {
      "id": "<kebab-case-stable-id>",
      "displayName": { "en": "<EN display name>", "fr": "<FR display name>" },
      "monthlyPriceCents": <integer; CAD cents>,
      "stripePriceId": "<Stripe price id, e.g. price_...>" | null
    }
  ]
}
```

- `id` is the stable key. Never rename in place -- add a new id and
  flag the old one deprecated for one release cycle, then drop.
- `monthlyPriceCents` is integer CAD cents. No floats, no currency
  string.
- `stripePriceId` is `null` until the operator creates the Stripe
  Product + Price. The portal fails closed (refuses to create a
  Subscription) when `null`.

TypeScript consumers import the typed view via `tiers.d.ts`.

## Bump

- Price change: bump only `monthlyPriceCents` + cut a **patch** release
  (e.g. 0.1.0 -> 0.1.1). Consumers re-pull.
- New tier: add a row + cut a **minor** release. Consumers add UI
  rendering in their next PR.
- Removing a tier: deprecate first (add `deprecatedSince` field in a
  minor release), then remove in a **major** release.
