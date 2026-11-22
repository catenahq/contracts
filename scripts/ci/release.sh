#!/usr/bin/env bash
# The release job of the shared control workflow (README.md, "Release"): one
# step of a release from the release branch, written through the GitHub API.
#
# Input (environment):
#   REPO      owner/name of the caller
#   STEP      cut, tag or merge-back
#   VERSION   vX.Y.Z, the version tag and merge-back write; cut ignores it
#   GH_TOKEN  the CI App token: writes the release branch, the tag, the
#             merge-back branch and its pull request
# A failed GitHub API call fails the script: a failed read never counts as
# "no pull request open" or "no tag".
set -euo pipefail
shopt -s inherit_errexit

COMMIT='^[0-9a-f]{40}$'
VERSION_FORM='^v[0-9]+\.[0-9]+\.[0-9]+$'
MAIN=main
RELEASE=release

fail() {
  echo "::error::release: $1" >&2
  exit 1
}

[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "REPO is not owner/name"

# The commit branch $1 points at.
branch_commit() {
  local sha
  sha="$(gh api "repos/$REPO/git/ref/heads/$1" | jq -r .object.sha)"
  [[ "$sha" =~ $COMMIT ]] || fail "the branch $1 points at no commit: '$sha'"
  echo "$sha"
}

# "<type> <sha>" of the object ref $1 (refs/...) points at, empty when the ref
# does not exist. matching-refs answers a list, empty for no match, and also
# lists the refs $1 is a prefix of.
ref_object() {
  gh api "repos/$REPO/git/matching-refs/${1#refs/}" \
    | jq -r --arg ref "$1" '.[] | select(.ref == $ref) | "\(.object.type) \(.object.sha)"'
}

# The commit of tag object "<type> <sha>" ($1 $2): an annotated tag is read
# through git/tags.
tag_commit() {
  local sha="$2" object type
  if [ "$1" = tag ]; then
    object="$(gh api "repos/$REPO/git/tags/$2" | jq -r '"\(.object.type) \(.object.sha)"')"
    read -r type sha <<< "$object"
    [ "$type" = commit ] || fail "the tag $VERSION points at a $type, not a commit"
  fi
  [[ "$sha" =~ $COMMIT ]] || fail "the tag $VERSION points at no commit: '$sha'"
  echo "$sha"
}

# The status of commit $2 compared with $1: identical, ahead (only $2 has
# commits), behind (only $1 has) or diverged.
compare() {
  gh api "repos/$REPO/compare/$1...$2" | jq -r .status
}

check_version() {
  [ -n "$VERSION" ] || fail "the step $STEP needs a version: run it again with the input version set to vX.Y.Z"
  [[ "$VERSION" =~ $VERSION_FORM ]] || fail "the version '$VERSION' is not vX.Y.Z"
}

# Moves the release branch to the head of main, by fast-forward only, once the
# last release is merged back.
step_cut() {
  local main_sha status open
  main_sha="$(branch_commit "$MAIN")"
  open="$(gh api "repos/$REPO/pulls?state=open&per_page=100" --paginate \
    | jq -r '.[] | select(.head.ref | startswith("merge-back/")) | "#\(.number) \(.head.ref)"')"
  [ -z "$open" ] || fail "a merge-back pull request is open, merge it first: ${open//$'\n'/, }"
  status="$(compare "$RELEASE" "$main_sha")"
  case "$status" in
    identical)
      echo "$RELEASE is at $MAIN ($main_sha): nothing to cut"
      return
      ;;
    ahead) ;;
    behind | diverged) fail "$RELEASE holds commits $MAIN lacks ($status): merge the last release back into $MAIN first" ;;
    *) fail "the comparison of $RELEASE with $MAIN answered '$status'" ;;
  esac
  gh api -X PATCH "repos/$REPO/git/refs/heads/$RELEASE" -f "sha=$main_sha" -F force=false > /dev/null
  echo "$RELEASE: cut at $MAIN $main_sha"
}

# Tags the head of the release branch with an annotated tag $VERSION.
step_tag() {
  local release_sha found type sha tagged object
  check_version
  release_sha="$(branch_commit "$RELEASE")"
  found="$(ref_object "refs/tags/$VERSION")"
  read -r type sha <<< "$found"
  if [ -n "$sha" ]; then
    # A run that tagged before: the tag stands on the release head.
    tagged="$(tag_commit "$type" "$sha")"
    [ "$tagged" = "$release_sha" ] || fail "the tag $VERSION exists on $tagged, not on the head of $RELEASE ($release_sha)"
    echo "$VERSION: already tags $RELEASE at $release_sha"
    return
  fi
  object="$(gh api -X POST "repos/$REPO/git/tags" -f "tag=$VERSION" -f "message=$VERSION" \
    -f "object=$release_sha" -f type=commit | jq -r .sha)"
  [[ "$object" =~ $COMMIT ]] || fail "the tag object of $VERSION has no id: '$object'"
  gh api -X POST "repos/$REPO/git/refs" -f "ref=refs/tags/$VERSION" -f "sha=$object" > /dev/null
  echo "$VERSION: tagged $RELEASE at $release_sha"
}

# Opens the pull request that merges the commit of tag $VERSION into main from
# the branch merge-back/$VERSION, and turns its auto-merge on with a merge commit.
step_merge_back() {
  local found type sha commit ahead branch at holds number mergeable
  check_version
  found="$(ref_object "refs/tags/$VERSION")"
  read -r type sha <<< "$found"
  [ -n "$sha" ] || fail "the tag $VERSION does not exist: run the step tag first"
  commit="$(tag_commit "$type" "$sha")"
  ahead="$(gh api "repos/$REPO/compare/$MAIN...$commit" | jq -r .ahead_by)"
  [[ "$ahead" =~ ^[0-9]+$ ]] || fail "the comparison of $VERSION with $MAIN answered no count: '$ahead'"
  if [ "$ahead" -eq 0 ]; then
    echo "$MAIN holds $VERSION ($commit): nothing to merge back"
    return
  fi

  # The branch and its pull request are read before either is written.
  branch="merge-back/$VERSION"
  found="$(ref_object "refs/heads/$branch")"
  read -r _ at <<< "$found"
  if [ -n "$at" ]; then
    # A run that created it before, or a conflict a person resolved on it.
    holds="$(compare "$commit" "$at")"
    case "$holds" in
      identical | ahead) echo "$branch: exists at $at" ;;
      *) fail "$branch exists at $at, which does not hold $VERSION ($commit)" ;;
    esac
  fi
  number="$(gh api "repos/$REPO/pulls?state=open&head=${REPO%%/*}:$branch&per_page=100" | jq -r '.[0].number // empty')"

  if [ -z "$at" ]; then
    gh api -X POST "repos/$REPO/git/refs" -f "ref=refs/heads/$branch" -f "sha=$commit" > /dev/null
    echo "$branch: created at $commit"
  fi
  if [ -z "$number" ]; then
    number="$(gh api -X POST "repos/$REPO/pulls" -f "title=Merge back $VERSION" -f "head=$branch" -f "base=$MAIN" \
      -f "body=Merges the release $VERSION back into $MAIN." | jq -r .number)"
  fi
  [[ "$number" =~ ^[1-9][0-9]*$ ]] || fail "the merge-back pull request has no number: '$number'"

  # GitHub computes mergeable after the pull request opens: null until then.
  for try in 1 2 3 4 5 6 7 8 9 10 11 12; do
    mergeable="$(gh api "repos/$REPO/pulls/$number" | jq -r 'if .mergeable == null then "unknown" else .mergeable end')"
    [ "$mergeable" = unknown ] || break
    [ "$try" -eq 12 ] || sleep 5
  done
  case "$mergeable" in
    true) ;;
    false) fail "#$number: $branch conflicts with $MAIN, which changed since the cut: resolve the conflict on $branch, then run merge-back again" ;;
    *) fail "#$number: GitHub has not computed whether $branch merges into $MAIN: run merge-back again" ;;
  esac
  gh pr merge "$number" --repo "$REPO" --auto --merge
  echo "#$number: merges $branch into $MAIN once its checks pass"
}

case "$STEP" in
  cut) step_cut ;;
  tag) step_tag ;;
  merge-back) step_merge_back ;;
  *) fail "the step '$STEP' is not cut, tag or merge-back" ;;
esac
