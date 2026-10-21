#!/usr/bin/env bash
# Runs a gate command. A pull request fails only on failures its base commit
# does not have; any other event keeps the absolute gate.
#
# Input (environment):
#   NFO_RUN            gate command (bash -eo pipefail)
#   NFO_WORKDIR        directory the command runs in (default ".")
#   NFO_REPO_PATH      checkout that moves to the base commit for the comparison
#   NFO_FAILURE_LINES  extended regex; each matched part of an output line is
#                      one failure's identity. Empty: the exit status alone.
#   NFO_TOKEN          token for the base fetch
#   NFO_BASE_SHA       pull request base commit
#   NFO_REMOTE         where the base commit is fetched from
#                      (default https://github.com/$GITHUB_REPOSITORY.git)
#   GITHUB_EVENT_NAME  "pull_request" selects the comparison
set -uo pipefail
export LC_ALL=C

WORKDIR="$(cd "${NFO_WORKDIR:-.}" && pwd)"
REPO="$(cd "${NFO_REPO_PATH:?NFO_REPO_PATH is required}" && pwd)"
LINES_RE="${NFO_FAILURE_LINES:-}"
logs="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/new-failures-only.XXXXXX")"

# Runs the gate with output shown live and kept in $1; returns its status. The
# gate is the pull request's own code, so the token stays out of its environment.
run_gate() {
  (cd "$WORKDIR" && env -u NFO_TOKEN bash -eo pipefail -c "${NFO_RUN:?NFO_RUN is required}") 2>&1 | tee "$1"
  return "${PIPESTATUS[0]}"
}

# The failure identities in log $1, one per line, sorted and unique.
failures_of() {
  grep -oE -- "$LINES_RE" "$1" | sort -u || true
}

# Escapes a line for a workflow command message.
annotate() {
  local level="$1" text="$2"
  text="${text//'%'/%25}"
  text="${text//$'\r'/%0D}"
  echo "::$level::$text"
}

run_gate "$logs/head.log"
head_status=$?

if [ "${GITHUB_EVENT_NAME:-}" != pull_request ] || [ "$head_status" -eq 0 ]; then
  exit "$head_status"
fi

base_sha="${NFO_BASE_SHA:?NFO_BASE_SHA is required on a pull request}"
head_sha="$(git -C "$REPO" rev-parse HEAD)"
remote="${NFO_REMOTE:-https://github.com/${GITHUB_REPOSITORY:-}.git}"

echo "Gate failed at the head; running it at the base commit $base_sha"

# The token travels in the environment of the one fetch, never on a command line.
if ! (
  if [ -n "${NFO_TOKEN:-}" ]; then
    auth="$(printf 'x-access-token:%s' "$NFO_TOKEN" | base64 -w0)"
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
    export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
  fi
  git -C "$REPO" fetch --quiet --depth 1 --no-tags "$remote" "$base_sha"
); then
  annotate error "new-failures-only: cannot fetch the base commit $base_sha; the head failure stands"
  exit 1
fi

# Untracked files the head run left would block the base checkout. Nested
# repositories (sibling checkouts) and ignored files stay.
git -C "$REPO" clean -fdq
git -C "$REPO" checkout --quiet --force --detach "$base_sha" || {
  annotate error "new-failures-only: cannot check out the base commit $base_sha"
  exit 1
}

run_gate "$logs/base.log" > /dev/null
base_status=$?

git -C "$REPO" clean -fdq
git -C "$REPO" checkout --quiet --force --detach "$head_sha" || {
  annotate error "new-failures-only: cannot check the head $head_sha back out"
  exit 1
}

head_lines=""
[ -n "$LINES_RE" ] && head_lines="$(failures_of "$logs/head.log")"

# Without identifiable failure lines the exit status alone decides.
if [ -z "$head_lines" ]; then
  if [ "$base_status" -ne 0 ]; then
    annotate warning "new-failures-only: the base commit fails too (exit $base_status); passing"
    exit 0
  fi
  annotate error "new-failures-only: the base commit passes and the head fails"
  exit 1
fi

base_lines="$(failures_of "$logs/base.log")"
new_lines="$(comm -23 <(printf '%s\n' "$head_lines") <(printf '%s\n' "$base_lines"))"
carried_lines="$(comm -12 <(printf '%s\n' "$head_lines") <(printf '%s\n' "$base_lines"))"

while IFS= read -r line; do
  [ -n "$line" ] && annotate warning "carried from the base: $line"
done <<< "$carried_lines"
while IFS= read -r line; do
  [ -n "$line" ] && annotate error "new failure: $line"
done <<< "$new_lines"

new_count=0
carried_count=0
[ -n "$new_lines" ] && new_count="$(printf '%s\n' "$new_lines" | wc -l)"
[ -n "$carried_lines" ] && carried_count="$(printf '%s\n' "$carried_lines" | wc -l)"
echo "new-failures-only: $new_count new, $carried_count carried from the base"

[ "$new_count" -eq 0 ]
