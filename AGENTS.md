# catenahq/contracts -- shared contracts for catena repos

This repo holds versioned contracts that more than one catena repo
depends on. See README.md for the layout + consumer model.

## Edit rules

- Consumers read this repo as a sibling checkout at their own branch, so
  a change reaches every consumer on its next build: run the consumers'
  gates before committing (README.md, "How to change a contract").
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

    node ../contracts/scripts/check-unicode.mjs     # unicode + banned words
    node ../contracts/scripts/check-prose.mjs       # comment prose
    node ../contracts/scripts/check-repo-rules.mjs  # repo rules (env files, branch names)

The node scripts take the CURRENT DIRECTORY as their scope, because they
enumerate with `git ls-files`. That is how the ops sales job scopes
itself to one subtree by running from it.

CI checks this repo out with `.github/actions/checkout-sibling`, which
every workflow uses for every cross-repo checkout: no workflow resolves
a sibling's branch on its own. A `uses:` line is read before expressions
are evaluated, so first-party actions and reusable workflows are named
`@main`; that is the only branch name a workflow holds outside its
`on:` triggers and run conditions.

| Path | What it is |
| --- | --- |
| `scripts/check-unicode.mjs` | No em dashes, smart quotes or decorative Unicode, in any tracked file. Plus the banned-word scan. |
| `scripts/check-prose.mjs` | Runs Vale over code comments. Batches, because Vale leaks a tree-sitter query per file and dies on a large tree. |
| `scripts/check-repo-rules.mjs` | Rules every repo keeps: the root `.gitignore` carries the env-file rule and no real env file is tracked; no workflow or script names a branch where something is checked out, installed or compared, and no catenahq link names one. |
| `.github/actions/checkout-sibling/` | Checks out a sibling repo at the branch the run is on (same name, else a pull request's base, else the default branch). |
| `scripts/sync-brand-assets.mjs` | Copies the logo into the consuming site's `public/favicon.svg`. Each site's `postinstall`. |
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

A rule change re-seeds every consumer's `prose-debt.txt`: regenerate it
from a fresh `check-prose.mjs --all` run rather than editing it by hand.
A rule whose count will not fall is describing the language, not a
defect.

## The standard the comment gate stands for

A comment describes the code as it stands. What the code did before, and
why that changed, belongs in the commit message. The rules match tokens,
so they find the tense and miss the subject: a comment can pass them and
still document a system that is gone.

- Restate a design's reasoning as the rule the code holds now. Deleting
  a comment because it is phrased as a story loses the reasoning.
- Do not launder the chronology into a counterfactual. "X rather than
  Y" and "doing Y would cause Z" pass the rules and keep the ghost: the
  reader still has to reconstruct an absent design. The test is whether
  the comment stands alone for someone who never saw the old shape.
- A "would" aimed at an edit the reader might make (re-adding a probe,
  reversing a merge order) is fine.
- Keep the evidence: the error string or failure a guard exists for is
  what makes it trustworthy. Test docstrings state the invariant guarded,
  with the regression as evidence.
- Delete prose about a thing that does not exist; do not rewrite it to
  say the thing is absent. Search a file for the names of retired systems
  when working in it, since the rules do not see them.

About a third of findings are the rule catching another sense of the same
words. Debt these with the reason rather than rewriting them:

- "used to" meaning "in order to" in the active voice;
- runtime state ("fails if the live findings no longer match");
- live data, such as a date identifying rows in a database;
- upstream version facts ("the Synapse default from 1.0 onward").

## Add a new contract directory

Checklist before merging:

1. Two or more consumers genuinely need the same shape today.
2. README at `<dir>/README.md` describes: purpose, schema, consumers,
   how to bump.
3. Schema file or `.d.ts` carries the type contract.
4. Top-level README.md table gets a new row.
5. Initial values + at least one consumer wired up in the same PR
   (proves the contract is actually consumed).

## Security invariants (machine-enforced -- do not weaken silently)

- This repo is PUBLIC and canonical for legal/pricing/brand: no
  secrets, no operator config, no client data, ever (gitleaks scans
  the whole history on every change).
- Legal text changes only together with its pin in `legal/msa.json`:
  the pinned version is what clients accepted.
