#!/usr/bin/env bash
# Prints the ref of a sibling repo this run checks out: a branch, a commit, or
# an empty line for the sibling's default branch. Exits non-zero when the
# sibling cannot be read or the lock file is missing or wrong.
#
# The consumer's lock file (.github/catenahq.lock, one line per sibling:
# "<owner/name> <40-hex sha> # <branch>"; blank lines and lines starting with
# "#" are ignored) names the commit of each sibling. The same-named branch of
# the run's own context wins when the sibling has it and a bot did not name
# it, else the lock's commit: on a pull request the head branch, else the
# branch the run is on, and a run on its own default branch takes the lock's
# commit. The BRANCH input is taken as given, in place of the run's branch. A
# missing lock file, a lock without a line for the sibling or a malformed line
# fails. TIP=true ignores the lock and gives the sibling's default branch.
#
# Input (environment):
#   REPOSITORY  owner/name of the sibling
#   TOKEN       token that can read it (optional)
#   BRANCH      the branch to look for, in place of the run's own
#   LOCK        the lock file; default .github/catenahq.lock under GITHUB_WORKSPACE
#   TIP         true: the sibling's default branch, no lock
#   EVENT HEAD_REF REF_NAME REF_TYPE  the run's github context
#   DEFAULT_BRANCH  the default branch of the run's repository (optional)
set -euo pipefail

if [ "${TIP:-false}" = true ]; then
  echo "$REPOSITORY: default branch (tip)" >&2
  printf '\n'
  exit 0
fi

lock="${LOCK:-${GITHUB_WORKSPACE:-.}/.github/catenahq.lock}"
if [ ! -f "$lock" ]; then
  echo "$lock is missing: a repository pins each sibling it checks out in .github/catenahq.lock" >&2
  exit 1
fi
lock_sha=""
line_re='^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)[[:space:]]+([0-9a-f]{40})([[:space:]]+#.*)?$'
while IFS= read -r line || [ -n "$line" ]; do
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  case "$line" in '' | '#'*) continue ;; esac
  if [[ ! "$line" =~ $line_re ]]; then
    echo "$lock: malformed line '$line' (want '<owner/name> <40-hex sha> # <branch>')" >&2
    exit 1
  fi
  [ "${BASH_REMATCH[1]}" = "$REPOSITORY" ] && lock_sha="${BASH_REMATCH[2]}"
done < "$lock"
if [ -z "$lock_sha" ]; then
  echo "$lock has no line for $REPOSITORY" >&2
  exit 1
fi

candidate=""
own_context=1
if [ -n "${BRANCH:-}" ]; then
  candidate="$BRANCH"
  own_context=0
elif [ "${EVENT:-}" = pull_request ] || [ "${EVENT:-}" = pull_request_target ]; then
  candidate="${HEAD_REF:-}"
elif [ "${REF_TYPE:-}" = branch ]; then
  candidate="${REF_NAME:-}"
fi
# A run on its own default branch pairs with the lock's commit.
[ "$own_context" -eq 1 ] && [ "$candidate" = "${DEFAULT_BRANCH:-}" ] && candidate=""
# Renovate, engine-bump, scanctl and merge-back name branches per repo, so a
# sibling's branch of the same name holds an unrelated change.
case "$candidate" in renovate/* | engine-bump/* | scanctl/* | merge-back/*) candidate="" ;; esac

ref="$lock_sha"
if [ -n "$candidate" ]; then
  # The token travels in the environment, never on a command line.
  if [ -n "${TOKEN:-}" ]; then
    auth="$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
    export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
  fi
  found="$(git ls-remote --heads "https://github.com/$REPOSITORY.git" "refs/heads/$candidate")"
  [ -n "$found" ] && ref="$candidate"
fi
if [ "$ref" = "$lock_sha" ]; then
  echo "$REPOSITORY: $ref (lock)" >&2
else
  echo "$REPOSITORY: $ref" >&2
fi
printf '%s\n' "$ref"
