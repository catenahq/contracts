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
// `#` does NOT always start a comment. Three cases have to be told apart:
//
//     name: "deploy # not a comment"   # this one is
//     script: |
//       # block scalar content, not a comment
//     url: https://example.com/#anchor
//
// Per the YAML spec a comment starts at a `#` that is at the start of a
// line or preceded by whitespace, and is not inside a quoted scalar or a
// block scalar. That is what the scanner below implements.
//
// LIMIT: quote state is tracked within a line, not across lines. A
// multi-line quoted scalar containing ` #` would be read as a comment.
// That shape is vanishingly rare in Ansible, and a false positive costs
// one debt-file entry rather than a wrong verdict on real code.

const BLOCK_SCALAR = /(?:^|\s)[|>][+-]?\d*\s*$/;

// Index at which a comment starts on this line, or -1.
function commentStart(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === "\\") i += 1;
      else if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      // '' is an escaped quote inside a single-quoted scalar.
      if (ch === "'" && line[i + 1] === "'") i += 1;
      else if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return i;
    }
  }
  return -1;
}

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
      if (line.trim() === "") {
        out.push("");
        continue;
      }
      if (indentOf(line) > blockIndent) {
        out.push("");
        continue;
      }
      blockIndent = null;
    }

    const start = commentStart(line);
    const code = start === -1 ? line : line.slice(0, start);
    out.push(start === -1 ? "" : " ".repeat(start) + line.slice(start));

    if (BLOCK_SCALAR.test(code)) blockIndent = indentOf(line);
  }

  return out.join("\n");
}
