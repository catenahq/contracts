#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# ///
"""Decide whether a Trivy report should fail the build, and say why.

Two jobs, one JSON parse:

  REPORT     print what Trivy found -- a table on stdout, a markdown block in
             the job summary, and deduped ::error:: annotations. The Trivy
             steps run with `format: json` and `output:` pointing at a FILE, so
             without this the step exits having printed nothing and the ids are
             only reachable by downloading and unzipping an artifact.

  GATE       exit 1 when the findings are the change's fault, 0 when they are
             not.

Why a gate here rather than Trivy's own `exit-code: 1`:

    A bump PR is blocked by CVEs the CURRENTLY PINNED image already has: the
    scheduled full-matrix scan carries the same ids the bump PR fails on,
    because consecutive tags of these images usually share a finding set.
    Refusing the bump keeps the OLDER image -- same CVEs, minus whatever else
    the new version fixes. alloy is the clearest shape: a baseline vendoring
    grpc v1.80.0 against a bump to v1.81.1, still short of the 1.82.1 fix but
    nearer it, rejected for being nearer it.

    Trivy's exit code answers "how many CVEs does this image have". A pull
    request can only answer "does this change make that worse". Those are
    different questions, and the first already has an owner: the weekly
    scheduled run, which is absolute, currently red, and meant to be -- it is
    the signal to rebuild or to file a time-boxed .trivyignore.yaml entry.

So: with --baseline, fail only on findings absent from the baseline. Without
one, fail on any finding -- the absolute mode push and schedule keep.

Identity for comparison is (id, package), deliberately NOT including the
installed version: a bump moves the version while inheriting the same CVE, and
keying on version would call every inherited finding new, which is the whole
bug this exists to fix.

REFUSING TO GUESS: if a baseline was expected but could not be read, this
falls back to blocking and says so. "Nothing new" and "could not work out what
was already there" must not produce the same answer.

Stdlib only, so CI calls it as plain `python3` with no setup step. The PEP 723
header is kept so `uv run` works too.

Consumers (catena-admin, catena-templates) check this repo out beside their
own and run it from there:

Run: python3 contracts/scripts/trivy_gate.py REPORT.json [--baseline BASE.json]
                                             [--label NAME] [--require-baseline]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# GitHub folds a run's annotations at 10 per step, so past that they stop being
# a summary and start hiding each other. The full table always prints to stdout.
MAX_ANNOTATIONS = 10

_SEVERITY_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "UNKNOWN": 4}


def _key(finding: tuple[str, ...]) -> tuple[str, str]:
    """(id, package) -- see the module docstring on why the version is out."""
    return (finding[1], finding[2])


def _read(path: Path) -> dict | None:
    if not path.exists() or path.stat().st_size == 0:
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def _findings(report: dict) -> list[tuple[str, ...]]:
    """Every finding as (severity, id, pkg, installed, fixed).

    Secrets and misconfigurations are included, and not only for completeness:
    catena-admin's own image job deliberately omits `scanners: vuln` to keep
    secret detection on that image, so it can exit with an empty
    Vulnerabilities array and still be something we must not ship. A CVE-only
    reading would call that clean.
    """
    out: set[tuple[str, ...]] = set()
    for result in report.get("Results") or []:
        target = result.get("Target") or "?"
        for v in result.get("Vulnerabilities") or []:
            out.add((
                str(v.get("Severity") or "UNKNOWN"),
                str(v.get("VulnerabilityID") or "?"),
                str(v.get("PkgName") or "?"),
                str(v.get("InstalledVersion") or "?"),
                str(v.get("FixedVersion") or "-"),
            ))
        for s in result.get("Secrets") or []:
            out.add(("HIGH", f"SECRET:{s.get('RuleID', '?')}",
                     target, str(s.get("Title") or ""), "-"))
        for m in result.get("Misconfigurations") or []:
            out.add((str(m.get("Severity") or "UNKNOWN"),
                     f"MISCONFIG:{m.get('ID', '?')}",
                     target, str(m.get("Title") or ""), "-"))
    return sorted(out, key=lambda f: (_SEVERITY_ORDER.get(f[0], 9), f[1], f[2]))


def _summary(lines: list[str]) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("report")
    ap.add_argument("--baseline", default="",
                    help="report for the pre-change image; enables diff mode")
    ap.add_argument("--label", default="")
    ap.add_argument("--require-baseline", action="store_true",
                    help="a baseline was expected; block if it is unreadable")
    args = ap.parse_args()

    label = args.label or args.report

    report = _read(Path(args.report))
    if report is None:
        # Not "clean": Trivy never got far enough to write a parseable report.
        print(f"::warning::no usable Trivy report at {args.report} for {label} "
              "-- the scan failed before writing one; read the step log above.")
        return 0

    found = _findings(report)

    inherited: set[tuple[str, str]] = set()
    diff_mode = False
    if args.baseline:
        base = _read(Path(args.baseline))
        if base is None:
            if args.require_baseline:
                print(f"::error::{label}: expected a baseline scan at "
                      f"{args.baseline} and could not read one. Blocking on "
                      "every finding instead: 'nothing new' and 'could not "
                      "tell what was already there' are not the same answer.")
            else:
                print(f"::warning::{label}: no baseline at {args.baseline}; "
                      "grading against zero.")
        else:
            inherited = {_key(f) for f in _findings(base)}
            diff_mode = True

    if not found:
        print(f"Trivy: no findings for {label}.")
        return 0

    new = [f for f in found if _key(f) not in inherited]
    old = [f for f in found if _key(f) in inherited]

    width = max(len(f[2]) for f in found)
    mode = "new vs baseline" if diff_mode else "absolute"
    print(f"\nTrivy findings for {label} ({mode}):\n")
    for tag, group in (("NEW", new), ("inherited", old)):
        for f in group:
            print(f"  {tag:<9} {f[0]:<8} {f[1]:<24} {f[2]:<{width}}  "
                  f"{f[3]} -> fixed in {f[4]}")

    md = [f"### Trivy: {label}", "",
          f"Mode: **{mode}**. {len(new)} new, {len(old)} inherited.", "",
          "| | Severity | ID | Package | Installed | Fixed in |",
          "| --- | --- | --- | --- | --- | --- |"]
    md += [f"| {tag} | {f[0]} | {f[1]} | `{f[2]}` | `{f[3]}` | `{f[4]}` |"
           for tag, group in (("**NEW**", new), ("inherited", old))
           for f in group]
    _summary(md)

    if not new:
        print(f"\nNothing new: all {len(old)} finding(s) are already in the "
              "pre-change image, so they are not this change's doing. The "
              "absolute level is the weekly scheduled scan's to report.")
        return 0

    # Deduped: one CVE affecting three vendored copies of a module is three
    # rows but one thing to go fix, and repeating it would spend the annotation
    # budget on an id already on screen.
    ids: list[str] = []
    for f in new:
        if f[1] not in ids:
            ids.append(f[1])
    for one in ids[:MAX_ANNOTATIONS]:
        print(f"::error::{label}: {one}")
    if len(ids) > MAX_ANNOTATIONS:
        print(f"::error::{label}: and {len(ids) - MAX_ANNOTATIONS} more distinct "
              f"({len(ids)} in total) -- full list in the step log.")
    if diff_mode:
        print(f"\n{len(new)} finding(s) not present before this change.")
    else:
        print(f"\n{len(new)} finding(s) at or above the severity floor "
              "(absolute mode: no pre-change image to compare against).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
