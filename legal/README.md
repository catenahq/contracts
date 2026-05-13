# legal/

Canonical Master Services Agreement: the binding text itself plus
the version pin that ties each client acceptance row to a specific
revision.

- `master-agreement.md` -- the canonical English MSA text. Single
  source of truth; rendered verbatim on the website and referenced
  from the portal's terms-acceptance checkbox.
- `msa.json` -- version pin (commit SHA), effective date, source +
  published URLs. The portal writes `msa.version` into
  `installations.terms_version` at order submit so each row pins to
  the exact text the client accepted.

Consumers:

- **catenahq/portal**: writes `installations.terms_version` =
  `msa.version` at order submit; the OrderForm checkbox links to
  the published URL.
- **catenahq/website**: renders `master-agreement.md` at
  `/legal/master-agreement` (FR + EN) with `version` +
  `effectiveDate` in the footer.
- **catenahq/ops**: when a revision lands here, opens follow-up
  PRs against the consumers.

## Schema

`msa.json`:

```json
{
  "version": "<40-char commit SHA of master-agreement.md in this repo>",
  "sourceUrl": "https://github.com/catenahq/contracts/blob/<sha>/legal/master-agreement.md",
  "effectiveDate": "<ISO date when this version became live>",
  "publishedUrl": "<URL on catena.run where the rendered MSA lives>" | null
}
```

- `version` MUST be a 40-character hex commit SHA. The literal
  string `PLACEHOLDER` is accepted by CI only on the initial seed
  commit (the case for the first vX.Y.Z tag before
  master-agreement.md was added).
- `effectiveDate` is the date the client-acceptance flow started
  presenting this version. It is NOT necessarily the commit date.
- `publishedUrl` is `https://catena.run/legal/master-agreement` (FR
  default) once the website page lands.

## Bump

1. Edit `master-agreement.md` in this repo.
2. Commit + merge to main. Note the resulting commit SHA.
3. Open a follow-up PR updating `msa.json.version` to that SHA and
   bumping `effectiveDate`.
4. Tag a patch release (e.g. 0.2.0 -> 0.2.1).
5. The daily contracts-update workflow opens consumer PRs.
