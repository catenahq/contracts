# catenahq/contracts -- shared contracts for catena repos

This repo holds versioned contracts that more than one catena repo
depends on. See README.md for the layout + consumer model.

## Edit rules

- Every change is a deliberate version bump. Tag a `vX.Y.Z` release
  on every merge to main; consumers pull via that tag.
- Do not add app-specific copy, operator-only config, or anything
  with an unstable shape. Promote to a contract only once the same
  fact lives in two or more repos.
- JSON files MUST parse cleanly + match their documented shape. CI
  runs `node -e "JSON.parse(...)"` on every JSON file.
- Bilingual content: every key with a string value carries `{en, fr}`
  side by side. No EN-only or FR-only contracts.
- No emojis or em-dashes in any artifact. Plain hyphens + straight
  quotes only.

## Add a new contract directory

Checklist before merging:

1. Two or more consumers genuinely need the same shape today.
2. README at `<dir>/README.md` describes: purpose, schema, consumers,
   how to bump.
3. Schema file or `.d.ts` carries the type contract.
4. Top-level README.md table gets a new row.
5. Initial values + at least one consumer wired up in the same PR
   (proves the contract is actually consumed).

## Versioning

- Patch: value change only (e.g. update `legal/msa.json.version` to a
  new commit SHA).
- Minor: new key, new file, additive consumer-safe change.
- Major: breaking shape change. Coordinate consumer migrations in
  the PR description.

## Brand assets

`brand/` was historically vendored into each app via a `sync-brand.mjs`
script. Post-split, this repo is the source of truth; apps depend on
it via npm-style import. The `sync-brand.mjs` mechanism stays
documented for backward compatibility but is being phased out.
