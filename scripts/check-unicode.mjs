#!/usr/bin/env node
// Unicode hygiene gate (per workspace CLAUDE.md hard rule: no em dashes,
// smart quotes, decorative Unicode). Fails the run if any forbidden
// character appears in a tracked source file. Natural-language
// characters (accented letters, CJK, etc.) are unaffected.
//
// Also scans for banned words: names of removed or never-adopted systems
// that mark stale copy. Client-facing repos must never mention them.
//
// The list is DATA, read from banned-words.json next to this checkout.
// That file is rendered from ops/automation/audit/banned-words.yml, which
// carries the rationale for each entry and is the manifest the Python
// audit reads. Before that, this script carried a hand-maintained copy of
// the list, and the two had drifted: the copy was missing five tokens and
// matched with \b, which anchors in the wrong place for a token carrying
// punctuation such as cal.com or vault.sops.yml.
//
// ONE COPY. This script lives here and nowhere else. A consumer repo
// runs it out of the sibling contracts checkout:
//
//   node ../contracts/scripts/check-unicode.mjs
//
// Scope is the cwd, because `git ls-files` runs there. So the command
// above gates the consumer's tree, and the consumer's own
// banned-words-debt.txt is the only file it owns here.
//
// Wired as `npm run check:unicode` and a CI step in ci.yml.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const MANIFEST = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "banned-words.json");

// The boundary is custom rather than \b, and matches audit/banned_words.py
// exactly: several tokens carry punctuation ("cal.com", "vault.sops.yml")
// where \b anchors in the wrong places, so the neighbour test is "not a
// letter, digit or underscore" applied to the token as a literal. A stem
// keeps its leading boundary only, so "obfuscat" still matches
// "obfuscated"; a whole word gets both, so "kuma" leaves "kumamoto" alone.
//
// Bare "age" is deliberately absent from the manifest: it is a substring
// of ordinary English. The gated tokens are the ones that can only mean
// the retired system.
function boundary(token, stem) {
  const literal = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = stem ? "" : "(?![0-9A-Za-z_])";
  return new RegExp(`(?<![0-9A-Za-z_])${literal}${tail}`, "i");
}

function loadBanned() {
  if (!existsSync(MANIFEST)) {
    console.error(`banned-words manifest not found: ${MANIFEST}`);
    console.error("Re-run catenahq/ops automation/operator-tools/generate-banned-words-json.py");
    process.exit(2);
  }
  const { tokens } = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  if (!tokens || tokens.length === 0) {
    console.error(`${MANIFEST} lists no tokens`);
    process.exit(2);
  }
  return tokens.map((t) => ({
    re: boundary(t.token, t.stem),
    name: t.use_instead ? `${t.token} (use instead: ${t.use_instead})` : t.token,
  }));
}

const BANNED_WORDS = loadBanned();

// Files exempt from the banned-word scan, one `path -- reason` per line.
// Two kinds of entry earn a place: an operator-private decision log
// that names a retired system and records WHY it went, and a file whose
// migration is scheduled but not done.
//
// Unicode hygiene still applies to a listed file; only the banned-word
// scan is skipped.
//
// The path is relative to the cwd the scan runs from, because
// `git ls-files` makes cwd the scan scope. A listed path outside the
// current scope is inert, so one list can be shared across scopes.
//
// A listed file that IS in scope and has no banned word is an error. A
// stale exemption is how a gate quietly stops gating.
const DEBT_FILE = "banned-words-debt.txt";

function readDebt() {
  const entries = new Map();
  if (!existsSync(DEBT_FILE)) return entries;
  for (const raw of readFileSync(DEBT_FILE, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [path, ...reason] = line.split(/\s+--\s+/);
    entries.set(path.trim(), (reason.join(" -- ") || "").trim());
  }
  return entries;
}

const debt = readDebt();
const debtHit = new Set();

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
  // The debt list names the systems it grants an exemption for, and the
  // manifest IS the list of names.
  /(^|\/)banned-words-debt\.txt$/,
  /(^|\/)banned-words\.json$/,
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
  let unicodeInFile = false;
  for (const ch of Object.keys(FORBIDDEN)) {
    if (content.includes(ch)) {
      unicodeInFile = true;
      break;
    }
  }
  // An exempt file is still scanned, so that an exemption which has
  // stopped being needed can be reported below.
  let bannedInFile = false;
  for (const { re } of BANNED_WORDS) {
    if (re.test(content)) {
      bannedInFile = true;
      break;
    }
  }
  const exempt = debt.has(file);
  if (bannedInFile && exempt) debtHit.add(file);
  if (!unicodeInFile && !(bannedInFile && !exempt)) continue;

  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    for (const [ch, name] of Object.entries(FORBIDDEN)) {
      if (line.includes(ch)) {
        const preview = line.length > 100 ? line.slice(0, 100) + "..." : line;
        findings.push(`${file}:${idx + 1}: ${name}\n    ${preview}`);
      }
    }
    if (exempt) return;
    for (const { re, name } of BANNED_WORDS) {
      if (re.test(line)) {
        const preview = line.length > 100 ? line.slice(0, 100) + "..." : line;
        findings.push(`${file}:${idx + 1}: banned word: ${name}\n    ${preview}`);
      }
    }
  });
}

// An exemption for a file that is in scope and already clean gates
// nothing, and hides the next regression on that file.
const tracked = new Set(files);
const stale = [...debt.keys()].filter((f) => tracked.has(f) && !debtHit.has(f));

if (findings.length > 0 || stale.length > 0) {
  if (findings.length > 0) {
    console.error("Forbidden Unicode characters or banned words found (per workspace CLAUDE.md):");
    console.error("");
    for (const f of findings) console.error("  " + f);
    console.error("");
    console.error(`Total: ${findings.length} occurrence(s).`);
    console.error("Replace with ASCII equivalents / current system names and re-run.");
    console.error("Banned-word rationale: ops/automation/audit/banned-words.yml");
  }
  if (stale.length > 0) {
    console.error("");
    console.error(`Stale entries in ${DEBT_FILE} (these files name no banned system now):`);
    for (const f of stale) console.error("  " + f);
    console.error("Delete them, or the gate stops gating those files.");
  }
  process.exit(1);
}

console.log(`Unicode hygiene: clean (${files.length} file(s) in scope).`);
