#!/usr/bin/env bash
# Looks for an earlier run of the same workflow that judged the same key: the
# commit's tree, the base tree with ST_JUDGE_CHANGE, and the branch of each
# sibling repo the run checks out. A run that recorded the key, of this
# repository and the same workflow file, with an event in ST_SOURCE_EVENTS,
# whose head commit has the key's tree (and with ST_JUDGE_CHANGE a first parent
# with the key's base tree), and that concluded success or failure, is the
# source; its conclusion is reused. Only push and pull_request runs reuse. Any
# API error means no result: the checks run.
#
# Input (environment):
#   ST_NAME           record name; default the calling workflow file's stem
#   ST_WORKFLOW       workflow file the source ran; default the caller's
#   ST_COMMITS        lines of "<sha> [<base sha>]"; default GITHUB_SHA
#   ST_JUDGE_CHANGE   true: the base tree joins the key (base: the line's
#                     second field, else the first parent)
#   ST_SIBLINGS       owner/name list; each one's branch joins the key
#   ST_BRANCH         passed to checkout-sibling/resolve.sh
#   ST_DEFAULT_BRANCH the run's default branch, passed to resolve.sh
#   ST_SOURCE_EVENTS  events a source run may have
#   ST_WAIT_MINUTES   how long to wait for a source still going; default 30
#                     on a pull_request, 0 otherwise
#   ST_RECORD         true: a single commit that runs is recorded
#   ST_PR_HEAD_SHA    a pull request's head commit
#   GH_TOKEN          token for the API calls on this repository
#   ST_SIBLING_TOKEN  token for the sibling branch lookups
#   GITHUB_*          the run's context
# Output (GITHUB_OUTPUT): run, state, source, results, and for the upload step
# upload-name and upload-path.
set -uo pipefail
export LC_ALL=C

POLL=30
RESOLVE="$(dirname "${BASH_SOURCE[0]}")/../checkout-sibling/resolve.sh"
REPO="${GITHUB_REPOSITORY:-}"
REPO_ID="${GITHUB_REPOSITORY_ID:-}"
RUN_ID="${GITHUB_RUN_ID:-}"
EVENT="${GITHUB_EVENT_NAME:-}"

fail() {
  echo "::error::same-tree: $*"
  exit 1
}

warn() {
  echo "::warning::same-tree: $*"
}

# Appends output $1 with value $2 (multi-line safe).
out() {
  local delim
  delim="ST_$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  printf '%s<<%s\n%s\n%s\n' "$1" "$delim" "$2" "$delim" >> "${GITHUB_OUTPUT:-/dev/null}"
}

in_list() {
  local want="$1" x
  shift
  for x in "$@"; do [ "$x" = "$want" ] && return 0; done
  return 1
}

gh_api() {
  gh api "$1" --jq "$2" < /dev/null
}

JQ_COMMIT='[.tree.sha, (.parents[0].sha // "none")] | @tsv'
JQ_ARTIFACTS='.artifacts | sort_by(.created_at) | reverse | .[] | [.workflow_run.id, .workflow_run.repository_id, .workflow_run.head_repository_id, (.expired | tostring)] | @tsv'
JQ_RUN='[.path, .event, .status, (.conclusion // "none"), .html_url, .head_sha] | @tsv'
JQ_SHA_RUNS='.workflow_runs[] | [.id, .event, .status] | @tsv'

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "GITHUB_REPOSITORY is not owner/name"
[[ "$REPO_ID" =~ ^[0-9]+$ ]] || fail "GITHUB_REPOSITORY_ID is not a number"
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || fail "GITHUB_RUN_ID is not a number"

WORKFLOW="${ST_WORKFLOW:-}"
if [ -z "$WORKFLOW" ]; then
  WORKFLOW="${GITHUB_WORKFLOW_REF:-}"
  WORKFLOW="${WORKFLOW%%@*}"
  WORKFLOW="${WORKFLOW#"$REPO"/}"
fi
[[ "$WORKFLOW" =~ ^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$ ]] || fail "workflow '$WORKFLOW' is not a file under .github/workflows"
WF_FILE="${WORKFLOW##*/}"
NAME="${ST_NAME:-${WF_FILE%.*}}"
[[ "$NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || fail "name '$NAME' holds a character an artifact name cannot"

WAIT="${ST_WAIT_MINUTES:-}"
if [ -z "$WAIT" ]; then
  WAIT=0
  [ "$EVENT" = pull_request ] && WAIT=30
fi
[[ "$WAIT" =~ ^[0-9]+$ ]] || fail "wait-minutes '$WAIT' is not a whole number"

read -r -a SOURCE_EVENTS <<< "${ST_SOURCE_EVENTS:-push pull_request schedule}"
mapfile -t SIBLINGS < <(tr -s '[:space:]' '\n' <<< "${ST_SIBLINGS:-}" | sed '/^$/d' | sort -u)
for s in "${SIBLINGS[@]}"; do
  [[ "$s" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "sibling '$s' is not owner/name"
done

COMMITS="${ST_COMMITS:-${GITHUB_SHA:-}}"
SHAS=()
BASES=()
while read -r sha base _; do
  [ -n "$sha" ] || continue
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "commit '$sha' is not a full sha"
  [ -z "$base" ] || [[ "$base" =~ ^[0-9a-f]{40}$ ]] || fail "base '$base' is not a full sha"
  SHAS+=("$sha")
  BASES+=("$base")
done <<< "$COMMITS"
[ "${#SHAS[@]}" -gt 0 ] || fail "no commit to judge"

declare -A TREE_OF PARENT_OF

# Sets TREE and PARENT ("none" for a root commit) of commit $1.
commit_info() {
  local info tree parent
  if [ -z "${TREE_OF[$1]:-}" ]; then
    info="$(gh_api "repos/$REPO/git/commits/$1" "$JQ_COMMIT")" || return 1
    IFS=$'\t' read -r tree parent <<< "$info"
    [ -n "$tree" ] || return 1
    TREE_OF[$1]="$tree"
    PARENT_OF[$1]="${parent:-none}"
  fi
  TREE="${TREE_OF[$1]}"
  PARENT="${PARENT_OF[$1]}"
}

# Prints the default branch of sibling $1.
default_branch() {
  (
    if [ -n "${ST_SIBLING_TOKEN:-}" ]; then
      auth="$(printf 'x-access-token:%s' "$ST_SIBLING_TOKEN" | base64 -w0)"
      export GIT_CONFIG_COUNT=1
      export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
      export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
    fi
    git ls-remote --symref "https://github.com/$1.git" HEAD
  ) | sed -n 's|^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$|\1|p'
}

# The sibling lines of the key, the same for every commit. The default branch
# is named, so a run that falls back to it and a run that asks for it by name
# share the key.
sibling_lines() {
  local s ref
  for s in "${SIBLINGS[@]}"; do
    ref="$(REPOSITORY="$s" TOKEN="${ST_SIBLING_TOKEN:-}" BRANCH="${ST_BRANCH:-}" EVENT="$EVENT" \
      HEAD_REF="${GITHUB_HEAD_REF:-}" BASE_REF="${GITHUB_BASE_REF:-}" \
      REF_NAME="${GITHUB_REF_NAME:-}" REF_TYPE="${GITHUB_REF_TYPE:-}" DEFAULT_BRANCH="${ST_DEFAULT_BRANCH:-}" bash "$RESOLVE")" || return 1
    [ -n "$ref" ] || ref="$(default_branch "$s")"
    [ -n "$ref" ] || return 1
    printf '%s=%s\n' "$s" "$ref"
  done
}

# Sets KEY, RECORD, KEY_TREE and KEY_BASE_TREE for commit $1 judged from base
# $2; KEY and RECORD stay empty on an error.
key_of() {
  local base="$2" key
  KEY=""
  RECORD=""
  KEY_BASE_TREE=""
  commit_info "$1" || return 1
  KEY_TREE="$TREE"
  key="tree=$TREE"$'\n'
  if [ "${ST_JUDGE_CHANGE:-false}" = true ]; then
    base="${base:-$PARENT}"
    [ "$base" != none ] || return 1
    commit_info "$base" || return 1
    KEY_BASE_TREE="$TREE"
    key+="base=$TREE"$'\n'
  fi
  key+="$SIB_LINES"
  KEY="$key"
  RECORD="same-tree.$NAME.$(printf '%s' "$KEY" | sha256sum | cut -c1-40)"
}

# Newest first, the first record entry whose run qualifies and concluded
# success or failure sets FOUND_STATE and FOUND_URL. PENDING=1 when a
# qualifying run is still going. Any run of this repository can upload an
# artifact of any name, so a record counts only when the run's own head commit
# has the key's tree (and first-parent tree with ST_JUDGE_CHANGE): a
# pull_request run counts when its head holds the merge commit's tree, which
# is when the pull request is up to date with its base.
lookup() {
  local rec="$1" lines info id rid hrid expired path ev status concl url hsha
  FOUND_STATE=""
  FOUND_URL=""
  PENDING=0
  lines="$(gh_api "repos/$REPO/actions/artifacts?name=$rec&per_page=100" "$JQ_ARTIFACTS")" || return 1
  while IFS=$'\t' read -r id rid hrid expired; do
    [ -n "$id" ] || continue
    [ "$expired" = false ] || continue
    # A fork's run never counts.
    [ "$rid" = "$REPO_ID" ] && [ "$hrid" = "$REPO_ID" ] || continue
    [ "$id" != "$RUN_ID" ] || continue
    info="$(gh_api "repos/$REPO/actions/runs/$id" "$JQ_RUN")" || return 1
    IFS=$'\t' read -r path ev status concl url hsha <<< "$info"
    [ "$path" = "$WORKFLOW" ] || continue
    in_list "$ev" "${SOURCE_EVENTS[@]}" || continue
    [[ "$hsha" =~ ^[0-9a-f]{40}$ ]] || continue
    commit_info "$hsha" || return 1
    [ "$TREE" = "$KEY_TREE" ] || continue
    if [ -n "$KEY_BASE_TREE" ]; then
      [ "$PARENT" != none ] || continue
      commit_info "$PARENT" || return 1
      [ "$TREE" = "$KEY_BASE_TREE" ] || continue
    fi
    if [ "$status" != completed ]; then
      PENDING=1
      continue
    fi
    # A push judges the absolute gate and a pull request only new failures, so
    # a failure carries only to a run of its own event; a success to any.
    case "$concl" in
      success) ;;
      failure) [ "$ev" = "$EVENT" ] || continue ;;
      *) continue ;;
    esac
    FOUND_STATE="$concl"
    FOUND_URL="$url"
    return 0
  done <<< "$lines"
  return 0
}

# RUNNING=1 when a push run of the workflow is still going on commit $1 or, on
# a pull request, on its head when that head has the same tree.
push_running() {
  local shas=("$1") s lines id ev status tree
  RUNNING=0
  if [ "$EVENT" = pull_request ] && [ "$1" = "${GITHUB_SHA:-}" ] && [[ "${ST_PR_HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    commit_info "$1" || return 1
    tree="$TREE"
    commit_info "$ST_PR_HEAD_SHA" || return 1
    [ "$TREE" = "$tree" ] && shas+=("$ST_PR_HEAD_SHA")
  fi
  for s in "${shas[@]}"; do
    lines="$(gh_api "repos/$REPO/actions/workflows/$WF_FILE/runs?head_sha=$s&per_page=100" "$JQ_SHA_RUNS")" || return 1
    while IFS=$'\t' read -r id ev status; do
      if [ -n "$id" ] && [ "$id" != "$RUN_ID" ] && [ "$ev" = push ] && [ "$status" != completed ]; then
        RUNNING=1
        return 0
      fi
    done <<< "$lines"
  done
  return 0
}

# Looks up commit $1 (base $2), waiting up to WAIT minutes for a source still
# going. Returns 1 on an API error.
judge() {
  local deadline waited=0
  FOUND_STATE=""
  key_of "$1" "$2" || return 1
  deadline=$(($(date +%s) + WAIT * 60))
  while :; do
    lookup "$RECORD" || return 1
    [ -n "$FOUND_STATE" ] && return 0
    [ "$WAIT" -gt 0 ] || return 0
    RUNNING=0
    if [ "$PENDING" -eq 0 ]; then
      push_running "$1" || return 1
    fi
    [ "$PENDING" -eq 1 ] || [ "$RUNNING" -eq 1 ] || return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "same-tree: the run of the same code is still going after $WAIT min; running the checks"
      return 0
    fi
    [ "$waited" -eq 1 ] || echo "same-tree: waiting up to $WAIT min for a run of the same code"
    waited=1
    sleep "$POLL"
  done
}

reused() {
  echo "::notice::same tree as $2 ($1): nothing ran"
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf 'Same tree as [%s](%s) (%s): nothing ran.\n' "$2" "$2" "$1" >> "$GITHUB_STEP_SUMMARY"
}

SIB_LINES=""
sib_ok=1
if ! SIB_LINES="$(sibling_lines)"; then
  sib_ok=0
  warn "cannot resolve the sibling branches; the checks run"
fi
[ -z "$SIB_LINES" ] || SIB_LINES+=$'\n'

# Only on a push or a pull_request is GITHUB_SHA the code the run judges;
# every other event runs its checks.
reuse=0
case "$EVENT" in push | pull_request) reuse=1 ;; esac

if [ "${#SHAS[@]}" -gt 1 ]; then
  results=""
  run=false
  for i in "${!SHAS[@]}"; do
    sha="${SHAS[$i]}"
    FOUND_STATE=""
    if [ "$reuse" -eq 1 ] && [ "$sib_ok" -eq 1 ] && ! judge "$sha" "${BASES[$i]}"; then
      warn "a GitHub API call failed for $sha; it runs"
    fi
    if [ -n "$FOUND_STATE" ]; then
      results+="$sha $FOUND_STATE $FOUND_URL"$'\n'
      reused "$FOUND_STATE" "$FOUND_URL"
    else
      run=true
    fi
  done
  out run "$run"
  out state ""
  out source ""
  out results "${results%$'\n'}"
  exit 0
fi

sha="${SHAS[0]}"
KEY=""
looked=1
if [ "$reuse" -eq 1 ] && [ "$sib_ok" -eq 1 ]; then
  if ! judge "$sha" "${BASES[0]}"; then
    looked=0
    warn "a GitHub API call failed; the checks run"
  fi
fi

if [ "$looked" -eq 1 ] && [ -n "${FOUND_STATE:-}" ]; then
  out run false
  out state "$FOUND_STATE"
  out source "$FOUND_URL"
  out results "$sha $FOUND_STATE $FOUND_URL"
  reused "$FOUND_STATE" "$FOUND_URL"
  if [ "$FOUND_STATE" = failure ]; then
    echo "::error::same tree as $FOUND_URL, which failed: its failure is carried"
    exit 1
  fi
  exit 0
fi

out run true
out state ""
out source ""
out results ""
if [ "${ST_RECORD:-true}" = true ] && [ "$sib_ok" -eq 1 ] && in_list "$EVENT" push pull_request schedule; then
  if [ -z "$KEY" ] && ! key_of "$sha" "${BASES[0]}"; then
    warn "cannot compute the key; no record"
    exit 0
  fi
  dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/same-tree.XXXXXX")"
  printf '%s' "$KEY" > "$dir/key.txt"
  out upload-name "$RECORD"
  out upload-path "$dir/key.txt"
fi
exit 0
