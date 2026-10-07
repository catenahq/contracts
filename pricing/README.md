# pricing/

The billing knobs that are not an edition price: the a-la-carte hourly
rate, for support during business hours, and the billing increment it
rounds to.

The edition prices (Catena Pro, Catena Business) live on their Polar
products, where they are sold; catenahq/website reads them from Polar at
build time (`src/lib/polar-prices.ts`). Community is free.

No code reads `tiers.json` today; `scripts/validate-json.mjs` checks its
shape.

## Schema

`tiers.json` (filename retained; the import path is public):

```json
{
  "currency": "CAD",
  "supportIncrementMinutes": <int>,
  "alacarteHourlyCents": <int, > 0>
}
```

- All amounts are integer CAD cents. No floats.

## Bump

- Rate change (`alacarteHourlyCents`, `supportIncrementMinutes`): cut a
  **patch** release.
- New optional top-level field: cut a **minor** release.
- Shape change (renamed field, removed field): cut a **major** release
  and land the consumers' migration in the same push.
