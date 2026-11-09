#!/usr/bin/env bash
# Prints the branch of a sibling repo this run checks out, or an empty line for
# the sibling's default branch. The first candidate the sibling has wins: the
# BRANCH input; else on a pull request the head then the base branch; else the
# branch the run is on. A candidate from the run's own context that is the
# run's default branch ends the search with the sibling's default branch, so a
# run on a default branch pairs with each neighbour's default branch. The
# BRANCH input is taken as given. Exits non-zero when the sibling cannot be
# read.
#
# Input (environment):
#   REPOSITORY  owner/name of the sibling
#   TOKEN       token that can read it (optional)
#   BRANCH      the branch to look for, in place of the run's own
#   EVENT HEAD_REF BASE_REF REF_NAME REF_TYPE  the run's github context
#   DEFAULT_BRANCH  the default branch of the run's repository (optional)
set -euo pipefail

candidates=()
own_context=1
if [ -n "${BRANCH:-}" ]; then
  candidates+=("$BRANCH")
  own_context=0
elif [ "${EVENT:-}" = pull_request ] || [ "${EVENT:-}" = pull_request_target ]; then
  candidates+=("${HEAD_REF:-}" "${BASE_REF:-}")
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
  # Renovate, engine-bump and scanctl name branches per repo, so a sibling's
  # branch of the same name holds an unrelated change.
  case "$c" in renovate/* | engine-bump/* | scanctl/*) continue ;; esac
  found="$(git ls-remote --heads "https://github.com/$REPOSITORY.git" "refs/heads/$c")"
  if [ -n "$found" ]; then
    ref="$c"
    break
  fi
done
echo "$REPOSITORY: ${ref:-default branch}" >&2
printf '%s\n' "$ref"
