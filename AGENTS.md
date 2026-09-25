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

## Workspace hygiene gates (this repo owns them)

Every catena repo runs these, and they exist ONLY here. A consumer holds
no copy: its CI checks this repo out alongside it and runs the script
from there.

    node ../contracts/scripts/check-unicode.mjs   # unicode + banned words
    node ../contracts/scripts/check-prose.mjs     # comment prose
    python3 contracts/scripts/trivy_gate.py ...   # image CVE verdict (CI jobs)

Both take the CURRENT DIRECTORY as their scan scope, because they
enumerate with `git ls-files`. That is how the ops sales job scopes
itself to one subtree by running from it.

| Path | What it is |
| --- | --- |
| `scripts/check-unicode.mjs` | No em dashes, smart quotes or decorative Unicode, in any tracked file. Plus the banned-word scan. |
| `scripts/check-prose.mjs` | Runs Vale over code comments. Batches, because Vale leaks a tree-sitter query per file and dies on a large tree. |
| `scripts/trivy_gate.py` | The verdict on a Trivy image report: with `--baseline`, fail only on findings the change adds; without one, fail on any. Used by catena-admin and catena-templates image-scan jobs. Tested by `scripts/trivy_gate_test.py`. |
| `scripts/lib/yaml-comments.mjs` | Reduces a YAML file to a comment skeleton so Vale can read it. Vale ships no YAML grammar. |
| `scripts/lib/shell-comments.mjs` | The same for shell, suppressing heredocs and the shebang. |
| `vale/Catena/*.yml` | The rules. Comments only: prose files record history on purpose. |
| `.vale-version` | The pinned binary. `check-prose.mjs` refuses to run against a different one, because the grammars decide which comments are visible. |
| `banned-words.json` | Tokens and stem flags, RENDERED from `ops/automation/audit/banned-words.yml` by a generator in ops. Do not hand-edit. |

Editing rules: change `vale/Catena/`, re-run the gate in a consumer to
see the blast radius, and expect debt files to move. **Never use a Vale
`raw` key.** It replaces a rule's `tokens` list, and its own entries
concatenate rather than alternate, so a multi-entry `raw` rule matches
nothing and reports nothing.

Each consumer owns two files and nothing else: `banned-words-debt.txt`
and `prose-debt.txt`, one `path -- reason` per line. A listed file that
is already clean FAILS the gate, so a drained entry has to be deleted.

Both scripts look for them in `.ci/`, then `.github/`, then the top of
the scan scope, and take the first that exists. Consumer repos keep them
under `.github/`; a scope that is a subtree rather than a repo, such as
`ops/internal_docs/sales`, keeps them at its top.

`banned-words.json` carries tokens and stem flags only. This repo is
public, and the manifest's replacement prose is operator-facing: it names
on-box paths and states what protects the panel binary. Keep it out.

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

## Security invariants (machine-enforced -- do not weaken silently)

- This repo is PUBLIC and canonical for legal/pricing/brand: no
  secrets, no operator config, no client data, ever (gitleaks on every
  change; full-history scan was clean at publication).
- Every merge is a deliberate semver bump + tag; legal text changes
  only through that flow (msa.json SHA pin is what clients accepted).
