#!/usr/bin/env bash
# The tag job of the shared control workflow (README.md, "App tag"): on a push
# to the default branch, tags the apps the app tests passed on the head of the
# pull request merged as the pushed commit.
#
# Input (environment):
#   REPO            owner/name of the caller
#   SHA             the pushed commit
#   TEMPLATES_ROOT  the caller checked out at SHA with its history and tags
#   TOOLS           the tools tree (build/versions.py)
#   APP_SLUG        the CI App's slug: only its app-tests status counts
#   GH_TOKEN        reads the commit's pull requests, the head's statuses and commits
#   TAG_TOKEN       writes the tags
# A failed GitHub API call or git command fails the script.
set -euo pipefail
shopt -s inherit_errexit

SLUG='^[a-z0-9][a-z0-9-]*$'
COMMIT='^[0-9a-f]{40}$'
# passed <n> app(s): <id>[, <id>...][ (<note>)], as the app tests describe a pass.
PASSED='^passed [0-9]+ app\(s\): ([a-z0-9, -]+)( \(.*\))?$'

fail() {
  echo "::error::app-tag: $1" >&2
  exit 1
}

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "REPO is not owner/name"
[[ "$SHA" =~ $COMMIT ]] || fail "SHA is not a full commit id"
[ -n "$APP_SLUG" ] || fail "APP_SLUG is empty"
run_url="^https://github\\.com/${REPO%%/*}/ops/actions/runs/[0-9]+\$"
root="$TEMPLATES_ROOT"
cd "$TOOLS"

# git fetch from origin with the read token, which a private caller needs.
fetch() {
  local auth
  auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
  echo "::add-mask::$auth"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraheader GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth" \
    git -C "$root" fetch -q "$@"
}

# The head of the pull request merged as SHA; the list can lag the merge.
merged_head() {
  gh api "repos/$REPO/commits/$SHA/pulls" \
    | jq -r --arg sha "$SHA" '[.[] | select(.merged_at != null and .merge_commit_sha == $sha)][0].head.sha // empty'
}
head="$(merged_head)"
if [ -z "$head" ]; then
  sleep 10
  head="$(merged_head)"
fi
if [ -z "$head" ]; then
  echo "$SHA: no pull request was merged as this commit, nothing is tagged"
  exit 0
fi
[[ "$head" =~ $COMMIT ]] || fail "the merged head '$head' is not a full commit id"

verdict="$(gh api "repos/$REPO/commits/$head/statuses?per_page=100" \
  | jq -r '[.[] | select(.context == "app-tests")][0] // empty
    | [.state, .creator.login, .target_url, .description] | map(. // "") | join("\u001f")')"
IFS=$'\x1f' read -r state creator run description <<< "$verdict" || true
if [ "$state" = success ] && [ "$description" = "no app changed" ]; then
  echo "$SHA: the merged head $head changed no app, nothing is tagged"
  exit 0
fi
[ "$state" = success ] || fail "the merged head $head has no app-tests success (${state:-none}): nothing is tagged"
[ "$creator" = "${APP_SLUG}[bot]" ] || fail "the app-tests success of $head is $creator's, not ${APP_SLUG}[bot]'s"
[[ "$run" =~ $run_url ]] || fail "the app-tests success of $head names no ops run: '$run'"
[[ "$description" =~ $PASSED ]] || fail "the app-tests success of $head names no apps: '$description'"
IFS=', ' read -ra apps <<< "${BASH_REMATCH[1]}"

# The pull request's head is fetched by its id when the merge left it out of the history.
git -C "$root" cat-file -e "$head^{commit}" 2>/dev/null || fetch --no-tags origin "$head"
parent="$(git -C "$root" rev-parse "$SHA^1")"
plans=()
for app in "${apps[@]}"; do
  [[ "$app" =~ $SLUG ]] || fail "'$app' is not a plain app id"
  git -C "$root" cat-file -e "$SHA:blueprints/$app/docker-compose.yml" 2>/dev/null || fail "$SHA holds no app $app"
  # The tag goes on the commit the app tests ran when the merge holds the same
  # change: the app's files differ in presentation alone.
  uv run build/versions.py same "$app" --ref "$SHA" --base "$parent" --from "$head" \
    || fail "$app at $SHA is not the change the app tests passed at $head: nothing is tagged"
  plan="$(uv run build/versions.py plan "$app" --ref "$SHA")"
  plans+=("$app $plan")
  echo "$app $plan"
done

# The annotation opens with `app-tests passed` and names the tested commit and
# the run; a tag FROM another adds that the runtime and tests are FROM's.
passed="app-tests passed at $head: $run"
for line in "${plans[@]}"; do
  read -r app action tag from <<< "$line"
  for try in 1 2 3; do
    message="$passed"
    if [ "$action" = create ] && [ -n "$from" ]; then
      message+=$'\n\n'"Runtime and tests as $from; this revision changes the presentation alone."
    fi
    case "$action" in
      skip)
        echo "$app: keeps $tag"
        break
        ;;
      mark)
        commit="$(git -C "$root" rev-parse "$tag^{commit}")"
        object="$(GH_TOKEN="$TAG_TOKEN" gh api -X POST "repos/$REPO/git/tags" -f "tag=$tag" -f "message=$message" \
          -f "object=$commit" -f type=commit | jq -r .sha)"
        GH_TOKEN="$TAG_TOKEN" gh api -X PATCH "repos/$REPO/git/refs/tags/$tag" -f "sha=$object" -F force=true > /dev/null
        echo "$app: marked $tag"
        break
        ;;
      create)
        object="$(GH_TOKEN="$TAG_TOKEN" gh api -X POST "repos/$REPO/git/tags" -f "tag=$tag" -f "message=$message" \
          -f "object=$SHA" -f type=commit | jq -r .sha)"
        if GH_TOKEN="$TAG_TOKEN" gh api -X POST "repos/$REPO/git/refs" -f "ref=refs/tags/$tag" -f "sha=$object" > /dev/null; then
          echo "$app: tagged $tag"
          break
        fi
        # Another run made the tag first: read the tags again and plan once more.
        [ "$try" -lt 3 ] || fail "$app: $tag could not be created"
        fetch --force origin '+refs/tags/*:refs/tags/*'
        plan="$(uv run build/versions.py plan "$app" --ref "$SHA")"
        read -r action tag from <<< "$plan"
        ;;
      *) fail "$app: the plan '$action $tag' is not create, mark or skip" ;;
    esac
  done
done
