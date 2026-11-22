#!/usr/bin/env bash
# The app checks of the shared PR workflow (README.md, "App checks"), run by
# its check job in the caller's checkout (ws/<repo>):
#
#   app-check.sh repo      the swarm lint and the app checker over blueprints/
#   app-check.sh app <id>  one app: its stack file, the released app checker,
#                          its images' pulls, the plain export, provenance,
#                          scanctl over its images and ClamAV over their files
#
# The app checker of an app is catena-applint in the catena-admin image that
# `build/app_check.py checker <id>` names: the release the app requires. It
# reads the whole of blueprints/ (with --catalog in the catalog repository)
# and the app is judged by the errors of its own compose file.
#
# Input (environment):
#   CATALOG     true: the catalog repository, with its own tools; false: another
#               repository's blueprints, the tools those of ../catena-templates
#   OWN_IMAGES  space-separated image repositories the caller builds itself
#   OWNER       the repository owner: the catalog builds ghcr.io/<owner>/<folder>
#               for each folder of images/
#   PROVENANCE_CHECK_AGE, GITHUB_TOKEN  read by the provenance check
#   RUNNER_TEMP, GITHUB_STEP_SUMMARY
# scanctl is $RUNNER_TEMP/bin/scanctl (.github/actions/scanctl). The change is
# HEAD against its first parent.
set -euo pipefail
shopt -s inherit_errexit

# The feature tag carries the databases the image shipped with.
CLAMAV_IMAGE=clamav/clamav:1.5
SLUG='^[a-z0-9][a-z0-9-]*$'

if [ "${CATALOG:?CATALOG is true or false}" = true ]; then
  TOOLS=.
  TEMPLATES_ROOT=""
  APPLINT_FLAGS=(--catalog --nodes 2)
else
  TOOLS="$(cd ../catena-templates && pwd)"
  TEMPLATES_ROOT="$PWD"
  APPLINT_FLAGS=(--nodes 2)
fi
export TOOLS TEMPLATES_ROOT

step() {
  printf '\n## %s\n' "$*"
}

# Pulls the checker image $1 and runs its catena-applint over blueprints/,
# then prints the errors of the compose file of each app id after it. Fails
# when the pull fails, the checker ends with a status above 1, its report
# lacks one of the files, or a file has an error.
applint() {
  local image="$1" report="$RUNNER_TEMP/applint.json" status=0 missing errors
  shift
  if ! docker pull "$image" > "$RUNNER_TEMP/checker-pull.txt" 2>&1; then
    cat "$RUNNER_TEMP/checker-pull.txt"
    echo "::error::The pull of $image failed. When the release is not published, a block field waits for the release that reads it."
    return 1
  fi
  docker run --rm -v "$PWD:/work:ro" \
    --entrypoint /usr/local/share/catena-ee/bin/catena-applint \
    "$image" "${APPLINT_FLAGS[@]}" --json /work/blueprints > "$report" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "::error::catena-applint of $image ended with status $status"
    return 1
  fi
  # shellcheck disable=SC2016 # a jq program: $ARGS is jq's
  local files='[$ARGS.positional[] | "/work/blueprints/\(.)/docker-compose.yml"]'
  if ! missing="$(jq -r "$files"' - [.[].file] | .[]' --args "$@" < "$report")"; then
    echo "::error::catena-applint of $image printed no JSON report"
    return 1
  fi
  if [ -n "$missing" ]; then
    echo "::error::catena-applint of $image did not read ${missing//$'\n'/ }"
    return 1
  fi
  if ! errors="$(jq -r "$files"' as $f | .[] | select(.file | IN($f[])) | .file as $file
      | .findings[] | select(.severity == "error") | "\($file): error \(.rule): \(.message)"' --args "$@" < "$report")"; then
    echo "::error::catena-applint of $image printed a report of another shape"
    return 1
  fi
  if [ -n "$errors" ]; then
    echo "$errors"
    return 1
  fi
  echo "catena-applint of $image: no error in $*"
}

repo_checks() {
  step "Swarm lint"
  uv run "$TOOLS/build/lint_swarm.py"
  step "The released app checker of each app"
  local dir id image status=0
  declare -A ids_of=()
  for dir in blueprints/*/; do
    id="$(basename "$dir")"
    [ -f "$dir/docker-compose.yml" ] || continue
    image="$(uv run "$TOOLS/build/app_check.py" checker "$id")"
    ids_of[$image]+=" $id"
  done
  for image in $(printf '%s\n' "${!ids_of[@]}" | sort); do
    # shellcheck disable=SC2086 # the ids are slugs, split on purpose
    applint "$image" ${ids_of[$image]} || status=1
  done
  return "$status"
}

# Only trivy runs, over the app's compose file's images. The change is judged
# from its base (-baseline-ref): a vulnerability at or above high with a fix,
# or a secret in an image, fails only when the change adds it; the ones already
# there are counted among the summary's advisory findings. A finding accepted in
# .scanctl/baseline.sarif (-baseline) does not fail it either.
scan_images() {
  local app="$1" base status=0
  base="$(git rev-parse HEAD^1)"
  cat > "$RUNNER_TEMP/scanctl-app.yml" <<EOF
profile: sellable
gate:
  floor: high
tools:
  osv-scanner: {enabled: false}
  govulncheck: {enabled: false}
  gosec: {enabled: false}
  gitleaks: {enabled: false}
  semgrep: {enabled: false}
  zizmor: {enabled: false}
  guarddog: {enabled: false}
  trivy-license: {enabled: false}
image_pins:
  - file: blueprints/$app/docker-compose.yml
    pattern: '(?m)^\s*image:\s*["'']?([^"''\s#]+)'
EOF
  "$RUNNER_TEMP/bin/scanctl" run \
    -config "$RUNNER_TEMP/scanctl-app.yml" \
    -baseline-ref "$base" \
    -baseline .scanctl/baseline.sarif \
    -out "$RUNNER_TEMP/scanctl.sarif" \
    -summary "$RUNNER_TEMP/scanctl-summary.md" . || status=$?
  if [ -f "$RUNNER_TEMP/scanctl-summary.md" ]; then cat "$RUNNER_TEMP/scanctl-summary.md" >> "$GITHUB_STEP_SUMMARY"; fi
  return "$status"
}

# .clamav-allow.sfp joins the image's databases: the files it lists by exact
# content pass. The regular files of an image, one name per inode (hardlinked
# names hold the same content), are dealt round robin to one clamscan per
# processor, each loading its own databases, so at most one per 2 GB of
# available memory; each prints its summary. A device node (dev/null in some
# images) holds nothing to scan and needs root to be made: tar may fail on
# those alone.
clamav() {
  local allow lists list mem_kb scanners image work cid failed pid pids pipe
  allow="$(realpath "$TOOLS/.clamav-allow.sfp")"
  lists="$RUNNER_TEMP/clamav-lists"
  mem_kb="$(free -k | awk '/^Mem:/ {print $7}')"
  scanners="$(nproc)"
  if [ "$(( mem_kb / 2097152 ))" -lt "$scanners" ]; then scanners="$(( mem_kb / 2097152 ))"; fi
  if [ "$scanners" -lt 1 ]; then scanners=1; fi
  while read -r image; do
    echo "== $image"
    work="$(mktemp -d)"
    cid="$(docker create "$image")"
    set +e
    docker export "$cid" | tar -x --no-same-owner -C "$work" 2> "$RUNNER_TEMP/tar.err"
    pipe=("${PIPESTATUS[@]}")
    set -e
    cat "$RUNNER_TEMP/tar.err" >&2
    [ "${pipe[0]}" = 0 ]
    if [ "${pipe[1]}" != 0 ]; then
      grep -q ': Cannot mknod: Operation not permitted$' "$RUNNER_TEMP/tar.err"
      if grep -v -e ': Cannot mknod: Operation not permitted$' \
          -e '^tar: Exiting with failure status due to previous errors$' "$RUNNER_TEMP/tar.err"; then
        return 1
      fi
    fi
    docker rm "$cid" > /dev/null
    chmod -R u+rwX,a+rX "$work"
    rm -rf "$lists"
    mkdir "$lists"
    (cd "$work" && find . -type f -printf '%i /scan/%P\n') > "$RUNNER_TEMP/clamav-names"
    sort -u -k1,1 "$RUNNER_TEMP/clamav-names" | cut -d' ' -f2- > "$RUNNER_TEMP/clamav-files"
    echo "$(wc -l < "$RUNNER_TEMP/clamav-names") names, $(wc -l < "$RUNNER_TEMP/clamav-files") files," \
      "$(du -sh --apparent-size "$work" | cut -f1), $scanners scanners"
    split -e -n "r/$scanners" "$RUNNER_TEMP/clamav-files" "$lists/part."
    pids=()
    for list in "$lists"/part.*; do
      docker run --rm --user 0 -v "$work:/scan:ro" -v "$lists:/lists:ro" \
        -v "$allow:/var/lib/clamav/catena-allow.sfp:ro" --entrypoint clamscan \
        "$CLAMAV_IMAGE" --infected "--file-list=/lists/${list##*/}" < /dev/null &
      pids+=("$!")
    done
    failed=0
    for pid in "${pids[@]}"; do wait "$pid" || failed=1; done
    [ "$failed" = 0 ]
    rm -rf "$work"
  done < "$RUNNER_TEMP/images.txt"
}

app_checks() {
  local app="$1" image images own dir
  if [[ ! "$app" =~ $SLUG ]]; then
    echo "::error::app-check: '$app' is not a plain app id (lowercase letters, digits, hyphens)"
    return 1
  fi

  step "Swarm loader reads the stack file"
  docker stack config --skip-interpolation -c "blueprints/$app/docker-compose.yml" > /dev/null

  # The panel release the app names in requires_catena (the newest release
  # when it names none) reads the app's block as a server running that
  # release does. The app's own file is judged as it is, so an error inherited
  # from its parent fails too.
  step "The released app checker reads the app"
  image="$(uv run "$TOOLS/build/app_check.py" checker "$app")"
  applint "$image" "$app"

  step "Pull the app's images"
  uv run "$TOOLS/build/app_check.py" images "$app" > "$RUNNER_TEMP/images.txt"
  while read -r image; do docker pull "$image"; done < "$RUNNER_TEMP/images.txt"

  # An app whose card sets bench.plain starts as plain Docker Compose files
  # from its export; the check fails when it gives no HTTP answer.
  step "The plain export answers"
  if [ "$(uv run "$TOOLS/build/app_check.py" plain "$app")" = true ]; then
    uv run "$TOOLS/build/pack.py" plain-check "$app"
  else
    echo "$app does not opt in to the plain export check"
  fi

  # The catalog builds an image for each folder of images/ and publishes it as
  # ghcr.io/<owner>/<folder>.
  step "Provenance (project age and releases)"
  read -ra images <<< "${OWN_IMAGES:-}"
  own="$(IFS=,; echo "${images[*]}")"
  if [ "$CATALOG" = true ]; then
    for dir in images/*/; do
      [ -d "$dir" ] || continue
      own="$own${own:+,}ghcr.io/${OWNER,,}/$(basename "$dir")"
    done
  fi
  PROVENANCE_OWN_IMAGES="$own" uv run "$TOOLS/build/app_check.py" provenance "$app"

  step "scanctl on the app's images"
  scan_images "$app"

  step "ClamAV over each image's files"
  clamav
}

case "${1:-}" in
  repo) repo_checks ;;
  app) app_checks "${2:?app-check.sh app <id>}" ;;
  *)
    echo "usage: app-check.sh repo | app <id>" >&2
    exit 2
    ;;
esac
