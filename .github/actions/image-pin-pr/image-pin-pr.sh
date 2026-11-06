#!/usr/bin/env bash
# Moves the pin of an image to a version in the named files of a templates
# repository, pushes the branch image-pin/<app> and opens the pull request, or
# updates the open one. A repository that already pins the version is left alone.
#
# Input (environment):
#   GH_TOKEN         token for the clone, the push and the pull request calls
#   IPP_REPOSITORY   owner/name of the templates repository
#   IPP_APP          app name
#   IPP_IMAGE        image without a tag
#   IPP_VERSION      version as the pin spells it
#   IPP_FILES        repository-relative paths, one per line
#   IPP_BODY         pull request body
#   IMAGE_PIN_PR_REMOTE_BASE  clone URL base, default https://github.com; only
#                    the test sets it, to a directory of local bare repositories
#   RUNNER_TEMP      parent of the clone, default /tmp
set -euo pipefail

repo="$IPP_REPOSITORY"
auth="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)"
echo "::add-mask::$auth"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"

dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/image-pin-pr.XXXXXX")"
git clone --depth 1 "${IMAGE_PIN_PR_REMOTE_BASE:-https://github.com}/$repo.git" "$dir"
cd "$dir"

files=()
while IFS= read -r line; do
  [ -n "$line" ] && files+=("$line")
done <<< "$IPP_FILES"

# The image holds dots and slashes: escape them for the sed pattern.
image_re="$(printf '%s' "$IPP_IMAGE" | sed 's@[.*^$/\\[]@\\&@g')"
version_re="$(printf '%s' "$IPP_VERSION" | sed 's@[&\\#]@\\&@g')"
sed -i -E "s#${image_re}:v?[0-9]+\.[0-9]+\.[0-9]+#${IPP_IMAGE}:${version_re}#g" "${files[@]}"

if git diff --quiet; then
  echo "$repo already pins $IPP_IMAGE:$IPP_VERSION"
  exit 0
fi

branch="image-pin/$IPP_APP"
title="chore($IPP_APP): pin $IPP_VERSION"
git config user.name "catena image pin"
git config user.email "image-pin@users.noreply.github.com"
git checkout -B "$branch"
git commit -qam "$title"
git push --force origin "$branch"

number="$(gh pr list --repo "$repo" --head "$branch" --state open --json number --jq '.[0].number // empty')"
if [ -n "$number" ]; then
  gh api -X PATCH "repos/$repo/pulls/$number" -f "title=$title" -f "body=$IPP_BODY" > /dev/null
  echo "updated https://github.com/$repo/pull/$number"
else
  base="$(gh api "repos/$repo" --jq .default_branch)"
  gh pr create --repo "$repo" --base "$base" --head "$branch" --title "$title" --body "$IPP_BODY"
fi
