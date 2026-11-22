#!/usr/bin/env bash
# The app entries of the shared PR workflow's plan (README.md, "App checks"):
# runs in the caller's checkout (ws/<repo>), refuses a change that touches more
# than one app, and adds to the plan one entry app-<id> per app the change
# touches and still has, from the plan's apps.app.
#
# Input (environment):
#   PLAN     the output of checks-matrix.mjs, with apps.enabled true
#   CATALOG  true: the tools are this tree's; false: those of catena-templates,
#            checked out beside it (../catena-templates)
#   GITHUB_OUTPUT, RUNNER_TEMP
# Output: plan=<the plan with the app entries> on GITHUB_OUTPUT.
# The change is HEAD against its first parent: on a pull request, the merge
# commit against its base.
set -euo pipefail

SLUG='^[a-z0-9][a-z0-9-]*$'

if [ "${CATALOG:?CATALOG is true or false}" = true ]; then
  TOOLS=.
else
  TOOLS=../catena-templates
fi

paths="$RUNNER_TEMP/app-plan-paths.txt"
git diff --name-only HEAD^1 HEAD > "$paths"

# A change touches one app, so one change is one tag.
uv run "$TOOLS/build/versions.py" scope < "$paths"

changed="$(uv run "$TOOLS/build/app_check.py" changed < "$paths")"
apps=()
for id in $changed; do
  if [[ ! "$id" =~ $SLUG ]]; then
    echo "::error::app-plan: '$id' is not a plain app id (lowercase letters, digits, hyphens)"
    exit 1
  fi
  # An app the change deletes has nothing left to check.
  if [ -f "blueprints/$id/docker-compose.yml" ]; then
    apps+=("$id")
  else
    echo "$id: deleted, nothing to check"
  fi
done

ids="$(printf '%s\n' "${apps[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
echo "apps the change touches: $ids"
with_apps="$(jq -c --argjson ids "$ids" \
  '.apps.app as $t | .include += [$ids[] as $id | {name: "app-\($id)"} + $t | .inputs = ["blueprints/\($id)/"] + $t.inputs]' \
  <<< "$PLAN")"
echo "plan=$with_apps" >> "$GITHUB_OUTPUT"
