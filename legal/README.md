# legal/

Canonical commercial-agreement texts. Every file here is referenced
by an executed Master Services Agreement and rendered verbatim on the
website / linked from the portal. Operator-private templates
(acceptance-tracking, breach-response, internal DPA template, loi25
reference material) live in the ops repo under
`ops/internal_docs/compliance/`, NOT here.

- `master-agreement.md` -- the canonical English MSA text. Single
  source of truth; rendered verbatim on the website and referenced
  from the portal's terms-acceptance checkbox.
- `sla.md` -- Schedule A. Service Level Agreement (uptime + response
  targets). Appended to every executed MSA.
- `subprocessors.md` -- Schedule D. Subprocessor list disclosing the
  third parties that may process client personal information on the
  operator's behalf (CC-BY-4.0 / Loi 25 art. 18.3 disclosure
  requirement).
- `data-export-and-termination.md` -- Schedule C. Data export
  procedure + termination effects, satisfying MSA section 6.2
  (portability) and 9.4 (post-termination).
- `msa.json` -- version pin (commit SHA), effective date, source +
  published URLs. The portal writes `msa.version` into
  `installations.terms_version` at order submit so each row pins to
  the exact text the client accepted.

Consumers:

- **catenahq/portal**: writes `installations.terms_version` =
  `msa.version` at order submit; the OrderForm checkbox links to
  the published URLs.
- **catenahq/website**: renders `master-agreement.md` at
  `/legal/master-agreement` (FR + EN) with `version` +
  `effectiveDate` in the footer, and the schedules (`sla.md`,
  `subprocessors.md`, `data-export-and-termination.md`) at
  `/legal/sla`, `/legal/subprocessors`,
  `/legal/data-export-and-termination` (FR + EN). The canonical
  text stays here; the pages render it verbatim with cross-schedule
  links rewritten to the site routes.

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
4. Tag a patch release (e.g. 0.2.0 -> 0.2.1). Consumers build against
   latest main via the sibling read; re-run/redeploy the website so
   the rendered version pin updates.
