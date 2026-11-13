# pricing/

The billing facts that are not an edition price: the a-la-carte hourly
rate, for support during business hours, and the billing increment it
rounds to (`tiers.json`), and the Polar checkout link of each paid
edition (`checkout.json`).

The edition prices (Catena Pro, Catena Business) live on their Polar
products, where they are sold; catenahq/website reads them from Polar at
build time (`src/lib/polar-prices.ts`). Community is free.

No code reads `tiers.json` today; `scripts/validate-json.mjs` checks the
shape of both files.

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

`checkout.json`, one Polar checkout link per paid edition, keyed by the
edition's id:

```json
{
  "pro": "https://buy.polar.sh/<checkout link id>",
  "business": "https://buy.polar.sh/<checkout link id>"
}
```

- Exactly the keys `pro` (Catena Pro) and `business` (Catena Business).
- Each value is the link itself, as Polar's Checkout Links page gives
  it, never the address of a checkout session. A consumer may append
  Polar's query parameters, such as `locale`.
- Consumers: catenahq/website (the pricing matrix's Subscribe buttons)
  and catenahq/catena-admin (the Subscription section of Settings, which
  holds a copy that its unit test compares with this file).

## Bump

- Rate change (`alacarteHourlyCents`, `supportIncrementMinutes`) or a
  replaced checkout link: cut a **patch** release.
- New optional top-level field or file: cut a **minor** release.
- Shape change (renamed field, removed field): cut a **major** release
  and land the consumers' migration in the same push.
