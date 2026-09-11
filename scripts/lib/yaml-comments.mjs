// Extract the comments from a YAML file as a "skeleton": a string with
// the same number of lines, where every comment keeps its exact line and
// column and everything else is blanked to spaces.
//
// This is what lets Vale read Ansible. Vale finds comments with a
// tree-sitter grammar per language and ships none for YAML, so it falls
// back to reading the file as plain text and matches task names and data
// values instead of comments. A skeleton is handed to it as a .py file:
// Python's comment syntax is also `#`, a file of nothing but comments
// parses cleanly, and because the prefix is padded rather than removed,
// an alert at line:col in the skeleton is at line:col in the YAML.
//
// WHOLE-LINE COMMENTS ONLY. A trailing comment (`command: x  # runs it`)
// is not extracted. Measured over the eight repos: trailing comments are
// 227 of 13456 comment lines, and they account for ZERO of the findings,
// because history and plan references get written in explanatory blocks
// rather than in a four-word annotation after a value. Scanning them
// needed quote tracking to tell `# runs it` from `name: "a # b"`, which
// is a chunk of state machine earning nothing.
//
// BLOCK SCALARS STILL MATTER, and are the reason this is not a one-line
// filter. Their content is indented and frequently starts with `#`:
//
//     notes: |-
//       ## Gaps (tracked, not hidden)     <- Markdown, not a comment
//     run: |
//       # seed the baseline               <- shell, inside a workflow
//
// Ignoring them admits 418 such lines across the workspace as comments.
// So the scanner tracks one thing: whether the current line is inside a
// block scalar.
//
// LIMIT: a multi-line quoted scalar whose continuation line begins with
// `#` reads as a comment. That shape is vanishingly rare in Ansible, and
// a false positive costs one debt-file entry rather than a wrong verdict
// on real code.

// A block scalar opens with | or > (plus optional chomping and indent
// indicators) at the end of the line. The trailing `#.*` allows for a
// comment on the header itself: `script: | # sets it up`.
const BLOCK_SCALAR = /(?:^|\s)[|>][+-]?\d*\s*(?:#.*)?$/;

function indentOf(line) {
  let n = 0;
  while (n < line.length && line[n] === " ") n += 1;
  return n;
}

export function commentSkeleton(text) {
  const lines = text.split("\n");
  const out = [];
  // Indent of the line that opened a block scalar; content is anything
  // indented further. null when not inside one.
  let blockIndent = null;

  for (const line of lines) {
    if (blockIndent !== null) {
      if (line.trim() === "" || indentOf(line) > blockIndent) {
        out.push("");
        continue;
      }
      blockIndent = null;
    }

    out.push(line.trimStart().startsWith("#") ? line : "");

    if (BLOCK_SCALAR.test(line)) blockIndent = indentOf(line);
  }

  return out.join("\n");
}
