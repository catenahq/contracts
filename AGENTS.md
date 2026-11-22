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
- Legal and privacy text states the custody list: the operator holds the client's
  contact information and helpdesk tickets, nothing else.
- No edition price is written in a file: prices live on the Polar products
  (`pricing/README.md`). A pricing or legal edit names the three editions:
  Community, Catena Pro, Catena Business.

## Workspace hygiene gates (this repo owns them)

Every catena repo runs these, and they exist ONLY here. A consumer holds
no copy: its CI checks this repo out alongside it and runs the script
from there.

    node ../contracts/scripts/check-unicode.mjs     # unicode + banned words
    node ../contracts/scripts/check-prose.mjs       # comment prose
    node ../contracts/scripts/check-repo-rules.mjs  # repo rules (env files, .agent/ files, aidevops runtime state, branch names)
    node ../contracts/scripts/check-core-app-names.mjs [--exclude <path>]... <root>...  # no app names in core code

The node scripts take the CURRENT DIRECTORY as their scope, because they
enumerate with `git ls-files`. That is how the ops sales job scopes
itself to one subtree by running from it.

CI checks this repo out with `.github/actions/checkout-sibling`, which
every workflow uses for every cross-repo checkout: no workflow resolves
a sibling's branch on its own. A `uses:` line is read before expressions
are evaluated, so first-party actions and reusable workflows are named
`@main`, except `pr.yml`, which a caller pins by commit; that is the only
branch name a workflow holds outside its `on:` triggers and run conditions,
unless it is a release channel listed in `BRANCH_ALLOW`
(`scripts/check-repo-rules.mjs`).

| Path | What it is |
| --- | --- |
| `scripts/check-unicode.mjs` | No em dashes, smart quotes or decorative Unicode, in any tracked file outside a `vendor/` folder (third-party copies). Plus the banned-word scan. |
| `scripts/check-prose.mjs` | Runs Vale over code comments, skipping `vendor/` folders. Batches, because Vale leaks a tree-sitter query per file and dies on a large tree. |
| `scripts/check-repo-rules.mjs` | Rules every repo keeps: the root `.gitignore` carries the env-file rule and no real env file is tracked; no `.agent` path is tracked, on any branch its CI runs on, and none of the aidevops runtime state `.agents/loop-state/`, `.agents/tmp/`, `.agents/memory/` and `.agents/.full-loop-cleanup-deferred`; no workflow or script names a branch where something is checked out, installed or compared, and no catenahq link names one. |
| `scripts/check-core-app-names.mjs` | Counts the app names of `core-app-names.json` (whole words, any case) per file under the roots it is given, and compares with the consumer's `core-app-names-debt.json` (path -> count). A rise or a new path fails; a fall fails until `--update` lowers the debt. `--update` refuses a rise. The consumer's `core-app-names-exceptions.json` lists accepted uses (path -> names, reason); a stale entry fails and `--update` drops it, but never adds one. A `bench:` gate pointer is not counted. A root of `.` scans the repository; `--exclude <path>` drops a prefix. |
| `core-app-names.json` | `apps`: the names the gate finds. `structural`: the services core may name; no name is in both. |
| `.github/actions/checkout-sibling/` | Checks out a sibling repo. With the consumer's `.github/catenahq.lock`: the sibling's branch of the run's branch name (not a bot's, not the run's own default branch), else the commit the lock pins; a lock with no line for the sibling or a malformed line fails; `tip: 'true'` takes the default branch and ignores the lock. With no lock file: the same-named branch, else a pull request's base, else the default branch. `resolve.sh` picks the ref, for same-tree too (README.md, "How consumers depend on it"). |
| `.github/actions/new-failures-only/` | Runs a gate command: with no base commit it keeps the absolute gate; with one (the `base` input, else a pull request's merge commit first parent, else the event's base) it fails only on failure lines that commit lacks (README.md, "Changes fail only on new failures"). |
| `.github/actions/same-tree/` | On a push or pull request, reuses the success of an earlier run of the same workflow that judged the same tree and sibling commits, and records the key when the checks run (README.md, "Runs once per tree"). |
| `.github/actions/image-pin-pr/` | Moves the pin of an app's own image to a version in the named files of a templates repository, pushes the branch `image-pin/<app>`, and opens the pull request or updates the open one; a repository that already pins the version gets none. |
| `.github/workflows/pr.yml` | The shared PR workflow a caller's `ci.yml` calls: `plan` turns the caller's `.github/checks.yml` into a matrix and the scan settings and runs same-tree, `check (<name>)` runs `bash ci/run <name>` or the contracts gates, `scan` and `scan-daily` run scanctl, `gate` is the required status. It loads its own code at `job.workflow_sha`, never `@main` or a `./` path into the caller (README.md, "Shared PR workflow"). |
| `.github/actions/scan/` | The steps of the `scan` and `scan-daily` jobs: the caller and its scan siblings, scanctl, the own-image build when an image input changed or on a schedule, `scanctl run`, the SARIF upload, the artifact and the pull request comment (README.md, "Scan"). |
| `.github/actions/scanctl/` | Builds scanctl with `go build` at a commit, or from `ws/scanctl` in catenahq/scanctl. |
| `.github/catenahq.lock` | The scanctl commit the scan builds, `catenahq/scanctl <sha> # main`. |
| `scripts/ci/checks-matrix.mjs` | The parser `plan` runs: the matrix and the scan settings. A key it does not know fails, named. npm `yaml` is locked in `scripts/ci/package-lock.json`; a sibling or tool `pr.yml` gains is added to both, and a sibling to the scan action too. |
| `scripts/ci/gate-status.mjs` | Computes and posts the commit status `ci / gate` of a pull request head: pending while a `Depends-on: catenahq/<repo>#<n>` pull request of its body is not merged, with `--app-tests` also while the `app-tests` status is not success (README.md, "Gate status"). The `gate` job of `pr.yml` runs it on a pull request. |
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

Each consumer owns four files and nothing else: `banned-words-debt.txt`
and `prose-debt.txt`, one `path -- reason` per line, and
`core-app-names-debt.json` and `core-app-names-exceptions.json` for the
app-name gate (only repos that run it). The exceptions file holds the
accepted uses and their reasons. A listed file that is already clean FAILS
the gate, so a drained entry has to be deleted.

Each script looks for its files in `.ci/`, then `.github/`, then the top of
the scan scope, and takes the first that exists. Consumer repos keep them
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
