"""trivy_gate.py fails a change only on findings the change adds."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GATE = Path(__file__).with_name("trivy_gate.py")


def report(*vulns: tuple[str, str, str]) -> dict:
    """A Trivy JSON report holding (severity, id, package) findings."""
    return {"Results": [{"Target": "img", "Vulnerabilities": [
        {"Severity": s, "VulnerabilityID": i, "PkgName": p,
         "InstalledVersion": "1", "FixedVersion": "2"} for s, i, p in vulns]}]}


class TrivyGateTest(unittest.TestCase):
    def run_gate(self, head: dict | None, base: dict | None = None,
                 require: bool = False) -> int:
        with tempfile.TemporaryDirectory() as tmp:
            args = [sys.executable, str(GATE)]
            head_path = Path(tmp, "head.json")
            if head is not None:
                head_path.write_text(json.dumps(head))
            args.append(str(head_path))
            if base is not None or require:
                base_path = Path(tmp, "base.json")
                if base is not None:
                    base_path.write_text(json.dumps(base))
                args += ["--baseline", str(base_path)]
            if require:
                args.append("--require-baseline")
            return subprocess.run(args, capture_output=True, text=True).returncode

    def test_an_inherited_finding_does_not_fail_the_change(self):
        found = report(("HIGH", "CVE-1", "libssl"))
        self.assertEqual(self.run_gate(found, found), 0)

    def test_a_new_finding_fails_the_change(self):
        self.assertEqual(self.run_gate(report(("HIGH", "CVE-1", "libssl"),
                                              ("CRITICAL", "CVE-2", "zlib")),
                                       report(("HIGH", "CVE-1", "libssl"))), 1)

    def test_absolute_mode_fails_on_any_finding(self):
        self.assertEqual(self.run_gate(report(("HIGH", "CVE-1", "libssl"))), 1)

    def test_a_clean_report_passes(self):
        self.assertEqual(self.run_gate(report()), 0)

    def test_an_unreadable_expected_baseline_blocks(self):
        self.assertEqual(self.run_gate(report(("HIGH", "CVE-1", "libssl")),
                                       require=True), 1)

    def test_no_report_is_a_warning_not_a_verdict(self):
        self.assertEqual(self.run_gate(None), 0)


if __name__ == "__main__":
    unittest.main()
