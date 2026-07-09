#!/usr/bin/env node
// Unicode hygiene gate (per workspace CLAUDE.md hard rule: no em dashes,
// smart quotes, decorative Unicode). Fails the run if any forbidden
// character appears in a tracked source file. Natural-language
// characters (accented letters, CJK, etc.) are unaffected.
//
// Also scans for BANNED_WORDS: names of removed or never-adopted
// systems that mark stale copy (reference list + rationale:
// ops/internal_docs/operator/banned-words.md). Client-facing repos
// must never mention them.
//
// Wired as `npm run check:unicode` and a CI step in ci.yml.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FORBIDDEN = {
  "—": 'em dash (use "--")',
  "–": 'en dash (use "-")',
  "→": 'rightwards arrow (use "->")',
  "←": 'leftwards arrow (use "<-")',
  "…": 'ellipsis (use "...")',
  "“": "left curly double quote (use straight \")",
  "”": "right curly double quote (use straight \")",
  "‘": "left curly single quote (use straight ')",
  "’": "right curly single quote (use straight ')",
  "«": "left guillemet (use straight \")",
  "»": "right guillemet (use straight \")",
};

// Removed / never-adopted system names (stale-copy markers). Word
// boundaries keep e.g. "kumamoto" safe; case-insensitive.
const BANNED_WORDS = [
  { re: /\bdokploy\b/i, name: "dokploy (replaced by Portainer)" },
  { re: /\bkuma\b/i, name: "kuma / uptime-kuma (replaced by Gatus)" },
  { re: /\bnetdata\b/i, name: "netdata (removed)" },
  { re: /\bauthelia\b/i, name: "authelia (never adopted; Keycloak)" },
  { re: /\bnetbird\b/i, name: "netbird (never adopted; Tailscale)" },
  { re: /\bpomerium\b/i, name: "pomerium (never adopted; Tailscale)" },
  { re: /\bcal\.com\b/i, name: "cal.com (replaced by Easy!Appointments)" },
];

// Operator-private decision logs may name a retired system to record
// WHY it was retired (allowed context per banned-words.md). Unicode
// hygiene still applies to these files; only the banned-word scan is
// skipped. Paths are repo-relative, so entries are inert in repos
// that do not contain them.
const BANNED_WORD_ALLOWED_FILES = [
  /^onboarding\/3_discovery_call\/README\.md$/,
  /^onboarding\/4_defining_contract\/PLANNING\.md$/,
];

const SKIP_DIR_PATTERNS = [
  /^vendor\//,
  /^dist\//,
  /^\.next\//,
  /^\.astro\//,
  /^node_modules\//,
  /^\.git\//,
];

const SKIP_FILE_PATTERNS = [
  /package-lock\.json$/,
  /\.tgz$/,
  /\.lock$/,
  /scripts\/check-unicode\.mjs$/,
  // Third-party text we do not control. The CC/Apache/MIT boilerplate
  // ships with curly quotes in upstream form and modifying it would
  // alter the legal text.
  /^LICENSE(\..*)?$/,
  /(^|\/)LICEN[CS]E(\..*)?$/,
  /(^|\/)COPYING(\..*)?$/,
];

const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".otf", ".ttf", ".eot",
  ".pdf", ".zip", ".gz", ".webp", ".avif",
  // Office binary formats. They embed stray Unicode codepoints inside
  // their zip-compressed payload that look like forbidden punctuation
  // to a naive byte scan but are not editable text.
  ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
  ".odt", ".ods", ".odp", ".odg",
]);

const files = execSync("git ls-files", { encoding: "utf-8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const findings = [];

for (const file of files) {
  if (SKIP_DIR_PATTERNS.some((p) => p.test(file))) continue;
  if (SKIP_FILE_PATTERNS.some((p) => p.test(file))) continue;
  const dot = file.lastIndexOf(".");
  if (dot !== -1 && SKIP_EXTENSIONS.has(file.slice(dot).toLowerCase())) continue;

  let content;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  // Cheap fast-path: skip the line-by-line scan if no forbidden char
  // or banned word is in the file at all.
  let hit = false;
  for (const ch of Object.keys(FORBIDDEN)) {
    if (content.includes(ch)) {
      hit = true;
      break;
    }
  }
  const scanBanned = !BANNED_WORD_ALLOWED_FILES.some((p) => p.test(file));
  if (!hit && scanBanned) {
    for (const { re } of BANNED_WORDS) {
      if (re.test(content)) {
        hit = true;
        break;
      }
    }
  }
  if (!hit) continue;

  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    for (const [ch, name] of Object.entries(FORBIDDEN)) {
      if (line.includes(ch)) {
        const preview = line.length > 100 ? line.slice(0, 100) + "..." : line;
        findings.push(`${file}:${idx + 1}: ${name}\n    ${preview}`);
      }
    }
    if (!scanBanned) return;
    for (const { re, name } of BANNED_WORDS) {
      if (re.test(line)) {
        const preview = line.length > 100 ? line.slice(0, 100) + "..." : line;
        findings.push(`${file}:${idx + 1}: banned word: ${name}\n    ${preview}`);
      }
    }
  });
}

if (findings.length > 0) {
  console.error("Forbidden Unicode characters or banned words found (per workspace CLAUDE.md):");
  console.error("");
  for (const f of findings) console.error("  " + f);
  console.error("");
  console.error(`Total: ${findings.length} occurrence(s).`);
  console.error("Replace with ASCII equivalents / current system names and re-run.");
  console.error("Banned-word rationale: ops/internal_docs/operator/banned-words.md");
  process.exit(1);
}

console.log("Unicode hygiene: clean.");
