# pricing/

The paid offer, as one flat plan: Catena Pro, a monthly retainer per
server with unlimited apps. Plus the two operator-wide knobs that are
not part of the plan price -- the a-la-carte hourly rates by time of day
and the billing increment they round to.

Consumers:

- **catenahq/website**: `src/components/PricingMatrix.astro` imports
  `pricing/tiers.json` and renders the Pro price cell from
  `plan.monthlyPriceCents`. The capability cells around it come from
  `ops/automation/audit/features.yml` through
  `generate-pricing-matrix.py`; the two must not contradict each other,
  and the matrix is what the offer SAYS.
- **catenahq/ops**: `operator-tools/generate-sizing-doc.py` points
  readers here in prose. It does not read the JSON.

There is no other code consumer. A shape change here breaks the website
build and nothing else.

## Schema

`tiers.json` (filename retained; the import path is public):

```json
{
  "currency": "CAD",
  "supportIncrementMinutes": <int>,
  "alacarteHourlyCents": {
    "day": <int>,
    "evening": <int>,
    "night": <int>
  },
  "plan": {
    "id": "pro",
    "displayName": { "en": "...", "fr": "..." },
    "tagline":     { "en": "...", "fr": "..." },
    "monthlyPriceCents": <int, > 0>,
    "stripePriceId": "<Stripe price id>" | null
  }
}
```

- One plan, one price. Community is free and Enterprise is bespoke, so
  neither carries a number here; the website renders those two cells
  from its own i18n strings.
- The price is per server. Apps are unlimited and are never a line
  item.
- All prices are integer CAD cents. No floats, no currency string.
- `stripePriceId` is `null` until the Stripe Product + Price exists.
  Any biller must fail closed when it is null and the price is > 0.
- `tagline` must stay consistent with the capability matrix. The matrix
  is generated from `features.yml`, so it moves when the product moves;
  this string does not, and is the likelier of the two to go stale.

## Bump

- Price change (`monthlyPriceCents`, any `alacarteHourlyCents.*`): cut a
  **patch** release.
- New optional top-level field: cut a **minor** release.
- Shape change (renamed field, removed field): cut a **major** release
  and land the website migration in the same push -- consumers build
  against latest main, so a breaking change with no consumer migration
  breaks the site.
