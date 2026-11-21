#!/usr/bin/env bash
# Prints the ref of a sibling repo this run checks out: a branch, a commit, or
# an empty line for the sibling's default branch. Exits non-zero when the
# sibling cannot be read or the lock file is wrong.
#
# Without a lock file the first candidate branch the sibling has wins: the
# BRANCH input; else on a pull request the head then the base branch; else the
# branch the run is on. A candidate from the run's own context that is the
# run's default branch ends the search with the sibling's default branch, so a
# run on a default branch pairs with each neighbour's default branch. The
# BRANCH input is taken as given.
#
# With a lock file (the consumer's .github/catenahq.lock, one line per sibling:
# "<owner/name> <40-hex sha> # <branch>"; blank lines and lines starting with
# "#" are ignored) the same-named branch of the run's own context wins when the
# sibling has it, else the lock's commit; the base branch and the default
# branch do not apply. A lock without a line for the sibling, or with a
# malformed line, fails. TIP=true ignores the lock and gives the sibling's
# default branch.
#
# Input (environment):
#   REPOSITORY  owner/name of the sibling
#   TOKEN       token that can read it (optional)
#   BRANCH      the branch to look for, in place of the run's own
#   LOCK        the lock file; default .github/catenahq.lock under GITHUB_WORKSPACE
#   TIP         true: the sibling's default branch, no lock
#   EVENT HEAD_REF BASE_REF REF_NAME REF_TYPE  the run's github context
#   DEFAULT_BRANCH  the default branch of the run's repository (optional)
set -euo pipefail

lock="${LOCK:-${GITHUB_WORKSPACE:-.}/.github/catenahq.lock}"
lock_sha=""
use_lock=0
if [ "${TIP:-false}" != true ] && [ -f "$lock" ]; then
  use_lock=1
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
fi

candidates=()
own_context=1
if [ "${TIP:-false}" = true ]; then
  :
elif [ -n "${BRANCH:-}" ]; then
  candidates+=("$BRANCH")
  own_context=0
elif [ "${EVENT:-}" = pull_request ] || [ "${EVENT:-}" = pull_request_target ]; then
  candidates+=("${HEAD_REF:-}")
  [ "$use_lock" -eq 1 ] || candidates+=("${BASE_REF:-}")
elif [ "${REF_TYPE:-}" = branch ]; then
  candidates+=("${REF_NAME:-}")
fi
# The token travels in the environment, never on a command line.
if [ -n "${TOKEN:-}" ]; then
  auth="$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)"
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
  export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
fi
ref=""
for c in "${candidates[@]}"; do
  [ -n "$c" ] || continue
  [ "$own_context" -eq 1 ] && [ "$c" = "${DEFAULT_BRANCH:-}" ] && break
  # Renovate, engine-bump, scanctl and merge-back name branches per repo, so a
  # sibling's branch of the same name holds an unrelated change.
  case "$c" in renovate/* | engine-bump/* | scanctl/* | merge-back/*) continue ;; esac
  found="$(git ls-remote --heads "https://github.com/$REPOSITORY.git" "refs/heads/$c")"
  if [ -n "$found" ]; then
    ref="$c"
    break
  fi
done
if [ -z "$ref" ] && [ "$use_lock" -eq 1 ]; then
  ref="$lock_sha"
  echo "$REPOSITORY: $ref (lock)" >&2
else
  echo "$REPOSITORY: ${ref:-default branch}" >&2
fi
printf '%s\n' "$ref"
