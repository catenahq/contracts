# legal/

Pin for the canonical Master Service Agreement. The source-of-truth
prose lives in catenahq/ops at
`internal_docs/legal/master-agreement.md`. This file captures the
**commit SHA** that consumers should treat as the current accepted
version.

Consumers:

- **catenahq/portal**: writes `installations.terms_version` =
  `msa.version` at order submit, so each installation row pins to
  the exact MSA text the client accepted.
- **catenahq/website**: renders the MSA at `/legal/master-agreement`
  (FR + EN) by fetching the file from catenahq/ops at the pinned
  commit + displaying `version` + `effectiveDate` in the footer.
- **catenahq/ops**: the legal-update workflow (when an MSA revision
  lands) opens a PR here bumping `version` to the new commit SHA.

## Schema

`msa.json`:

```json
{
  "version": "<40-char commit SHA of master-agreement.md in catenahq/ops>",
  "sourceUrl": "https://github.com/catenahq/ops/blob/<sha>/internal_docs/legal/master-agreement.md",
  "effectiveDate": "<ISO date when this version became live>",
  "publishedUrl": "<URL on catena.run where the rendered MSA lives>" | null
}
```

- `version` MUST be a 40-character hex commit SHA (full SHA, not
  abbreviated). The literal string `PLACEHOLDER` is accepted by CI
  only on the initial seed commit.
- `effectiveDate` is the date the client-acceptance flow started
  presenting this version. It is NOT necessarily the commit date.
- `publishedUrl` becomes non-null once `catenahq/website/src/pages/
  legal/master-agreement.astro` is wired (Area C5 in the broader
  plan).

## Bump

The MSA changes -> update workflow:

1. Author the revision in catenahq/ops at
   `internal_docs/legal/master-agreement.md`.
2. Commit + merge.
3. Note the resulting commit SHA.
4. Open a PR in this repo (catenahq/contracts) updating `version`
   to that SHA + bumping `effectiveDate`.
5. Merge + tag a patch release (e.g. 0.1.1 -> 0.1.2).
6. Renovate opens consumer PRs. The portal's PR includes a Drizzle
   migration backfill if the legacy `installations.terms_version`
   rows need it; the website's PR re-renders /legal at the new SHA.
