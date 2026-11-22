#!/usr/bin/env bash
# The dispatch job of the shared control workflow (README.md, "App dispatch"):
# after the ci run of a pull request, sends the app its change touches to the
# app tests of catenahq/ops as the repository_dispatch event app-test, or posts
# the app-tests status success when it touches none.
#
# Input (environment):
#   REPO            owner/name of the caller
#   PR, SHA         the pull request and the head commit the ci run judged
#   TEMPLATES_ROOT  the pull request head with its history and tags, read as data
#   TOOLS           the base's tools tree (build/versions.py, build/app_check.py)
#   OWN_IMAGES      the image repositories the caller builds, space-separated
#   APP_SLUG        the CI App's slug: a carried verdict is the App's
#   GH_TOKEN        reads the pull request, its commits and statuses; posts app-tests
#   OPS_TOKEN       sends the event to ops
#   GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID  the run's address
# A failed GitHub API call or git command fails the script.
set -euo pipefail
shopt -s inherit_errexit

SLUG='^[a-z0-9][a-z0-9-]*$'
COMMIT='^[0-9a-f]{40}$'

fail() {
  echo "::error::app-dispatch: $1" >&2
  exit 1
}

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "REPO is not owner/name"
[[ "$PR" =~ ^[1-9][0-9]*$ ]] || fail "PR is not a pull request number"
[[ "$SHA" =~ $COMMIT ]] || fail "SHA is not a full commit id"
[ -n "$APP_SLUG" ] || fail "APP_SLUG is empty"
owner="${REPO%%/*}"
run_url="^https://github\\.com/$owner/ops/actions/runs/[0-9]+\$"
root="$TEMPLATES_ROOT"
# uv runs the base's tools in their own project, never in the pull request's tree.
cd "$TOOLS"

pull="$(gh api "repos/$REPO/pulls/$PR")"
IFS=$'\t' read -r state head base_ref branch head_repo \
  <<< "$(jq -r '[.state, .head.sha, .base.ref, .head.ref, (.head.repo.full_name // "-")] | @tsv' <<< "$pull")"
if [ "$state" != open ] || [ "$head" != "$SHA" ]; then
  echo "#$PR is $state at $head: $SHA is not sent, the run of the newer head sends it"
  exit 0
fi
[ "$head_repo" = "$REPO" ] || fail "#$PR comes from $head_repo, not $REPO"

# The change is the head against where it left the base branch.
base="$(git -C "$root" merge-base "$SHA" "origin/$base_ref")"
paths="$(git -C "$root" diff --name-only "$base" "$SHA")"
# A change touches one app, so one change is one tag.
uv run build/versions.py scope <<< "$paths"
changed="$(uv run build/app_check.py changed <<< "$paths")"
ids=()
for id in $changed; do
  [[ "$id" =~ $SLUG ]] || fail "'$id' is not a plain app id (lowercase letters, digits, hyphens)"
  # An app the change deletes has nothing to run.
  if git -C "$root" cat-file -e "$SHA:blueprints/$id/docker-compose.yml" 2>/dev/null; then ids+=("$id"); fi
done

if [ "${#ids[@]}" -eq 0 ]; then
  gh api -X POST "repos/$REPO/statuses/$SHA" -f context=app-tests -f state=success \
    -f "description=no app changed" \
    -f "target_url=$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" > /dev/null
  echo "$SHA: no app changed, app-tests success"
  exit 0
fi
ids_csv="$(IFS=,; echo "${ids[*]}")"

# The state, creator, url and description of the newest app-tests status of
# commit $1, separated by the unit separator, which keeps an empty field.
verdict() {
  gh api "repos/$REPO/commits/$1/statuses?per_page=100" \
    | jq -r '[.[] | select(.context == "app-tests")][0] // empty
      | [.state, .creator.login, .target_url, .description] | map(. // "") | join("\u001f")'
}
# Succeeds, and sets carry and carry_state, when verdict $3 of commit $1 is the
# App's for exactly app $2 and $1 holds the change $SHA holds, judged from $base:
# the app's files differ in presentation alone (build/versions.py same).
qualifies() {
  local state creator url description
  IFS=$'\x1f' read -r state creator url description <<< "$3" || true
  case "$state" in
    success) [[ "$description" == "passed 1 app(s): $2" || "$description" == "passed 1 app(s): $2 ("* ]] || return 1 ;;
    failure) [[ "$description" == "failed: $2" || "$description" == "failed: $2 "* ]] || return 1 ;;
    *) return 1 ;;
  esac
  [ "$creator" = "${APP_SLUG}[bot]" ] || return 1
  [[ "$url" =~ $run_url ]] || return 1
  uv run build/versions.py same "$2" --ref "$SHA" --base "$base" --from "$1" || return 1
  carry_state="$state"
  carry="$url"
}

# A change of one app carries the verdict of the first of these that holds the
# same change: the head, the pull request's earlier commits newest first, and,
# with success, the run that made the app's newest tag.
carry=""
carry_state=""
if [ "${#ids[@]}" -eq 1 ]; then
  commits="$(gh api "repos/$REPO/pulls/$PR/commits?per_page=100" --paginate | jq -r '.[].sha')"
  candidates=("$SHA")
  for cand in $(tac <<< "$commits"); do
    if [[ "$cand" =~ $COMMIT ]] && [ "$cand" != "$SHA" ]; then candidates+=("$cand"); fi
  done
  for cand in "${candidates[@]}"; do
    git -C "$root" cat-file -e "$cand^{commit}" 2>/dev/null || continue
    found="$(verdict "$cand")"
    if qualifies "$cand" "$ids_csv" "$found"; then
      echo "$SHA: carries the $carry_state of $cand ($carry)"
      break
    fi
  done
  if [ -z "$carry" ]; then
    tag_run="$(uv run build/versions.py tested-run "$ids_csv" --ref "$SHA")"
    if [[ "$tag_run" =~ $run_url ]]; then
      carry="$tag_run"
      carry_state=success
      echo "$SHA: carries the success of the newest tag of $ids_csv ($carry)"
    fi
  fi
fi
[ -n "$carry" ] || echo "$SHA: runs"

# The ops and contracts commits of the head's .github/catenahq.lock, which the
# app tests run with.
lock="$(git -C "$root" show "$SHA:.github/catenahq.lock")"
locked() {
  local name sha rest
  while read -r name sha rest; do
    [ "$name" = "catenahq/$1" ] || continue
    [[ "$sha" =~ $COMMIT ]] || fail ".github/catenahq.lock at $SHA: the line of catenahq/$1 holds no full commit id"
    echo "$sha"
    return
  done <<< "$lock"
  fail ".github/catenahq.lock at $SHA has no line for catenahq/$1"
}
ops_sha="$(locked ops)"
contracts_sha="$(locked contracts)"

read -ra images <<< "$OWN_IMAGES"
images_csv="$(IFS=,; echo "${images[*]}")"
GH_TOKEN="$OPS_TOKEN" gh api -X POST "repos/$owner/ops/dispatches" \
  -f event_type=app-test \
  -f "client_payload[sha]=$SHA" \
  -f "client_payload[base]=$base" \
  -f "client_payload[ids]=$ids_csv" \
  -f "client_payload[ref]=$branch" \
  -f "client_payload[repo]=${REPO#*/}" \
  -f "client_payload[carry]=$carry" \
  -f "client_payload[carry_state]=$carry_state" \
  -f "client_payload[own_images]=$images_csv" \
  -f "client_payload[ops_sha]=$ops_sha" \
  -f "client_payload[contracts_sha]=$contracts_sha" \
  -f "client_payload[pr]=$PR" > /dev/null
echo "$SHA: sent $ids_csv to the app tests (ops $ops_sha, contracts $contracts_sha)"
