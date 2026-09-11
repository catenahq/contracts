// Extract the comments from a shell script as a "skeleton": same line
// count, every comment at its exact line and column, everything else
// blanked. The sibling of lib/yaml-comments.mjs, and handed to Vale as
// .py for the same reason: `#` is Python's comment character too, a file
// of nothing but comments parses cleanly, and padding the prefix rather
// than stripping it keeps line and column exact.
//
// Vale ships no shell grammar, and unlike .mjs the content is not some
// other language in disguise, so the skeleton is the only route.
//
// WHOLE-LINE COMMENTS ONLY, matching the YAML scanner. A trailing
// comment would need quote tracking to tell `rm -rf "$d"  # clean up`
// from `echo "a # b"`, and the YAML measurement said trailing comments
// carry no findings.
//
// THE SHEBANG IS NOT PROSE. Line 1 `#!/usr/bin/env bash` is a comment by
// syntax and an interpreter directive by meaning; scanning it finds
// nothing and reports the path if it ever did.
//
// HEREDOCS are the reason this needs state, exactly as block scalars are
// in YAML. Their bodies carry `#` lines that are content, not comments:
//
//     cat >/etc/catena/gatus.yml <<'EOF'
//     # managed by catena, edits are overwritten
//     EOF
//
// A body runs from the opener to a line whose trimmed text is the
// delimiter. `<<-` strips leading tabs, which trimming already covers.
// `<<<` is a here-string with no body and must not open one.
//
// LIMIT: a multi-line quoted string whose continuation begins with `#`
// reads as a comment. Same shape and same rarity as the YAML case.

// Openers on one line, in order. Excludes `<<<`.
const HEREDOC = /(?<!<)<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;

export function shellCommentSkeleton(text) {
  const lines = text.split("\n");
  const out = [];
  // Delimiters whose bodies are still to come, oldest first. A line may
  // open more than one heredoc, and the bodies arrive in that order.
  const pending = [];
  let inBody = null;

  lines.forEach((line, i) => {
    if (inBody !== null) {
      out.push("");
      if (line.trim() === inBody) inBody = pending.length ? pending.shift() : null;
      return;
    }

    const isComment = line.trimStart().startsWith("#");
    const isShebang = i === 0 && line.startsWith("#!");
    out.push(isComment && !isShebang ? line : "");

    // A comment line cannot open a heredoc, so only scan code.
    if (isComment) return;
    HEREDOC.lastIndex = 0;
    let m;
    while ((m = HEREDOC.exec(line)) !== null) {
      pending.push(m[2] ?? m[3] ?? m[4]);
    }
    if (pending.length) inBody = pending.shift();
  });

  return out.join("\n");
}
