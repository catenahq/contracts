// Unit test for the shell comment skeleton. Run with
// `node scripts/lib/shell-comments.test.mjs` (also wired as part of
// `npm test`).
import { strict as assert } from "node:assert";
import { shellCommentSkeleton } from "./shell-comments.mjs";

function check(name, input, expected) {
  const got = shellCommentSkeleton(input);
  assert.equal(got, expected, `${name}\n  got:      ${JSON.stringify(got)}\n  expected: ${JSON.stringify(expected)}`);
  assert.equal(got.split("\n").length, input.split("\n").length, `${name}: line count`);
}

check(
  "a whole-line comment keeps its column",
  "  # history here\nrm -rf /tmp/x",
  "  # history here\n",
);

check(
  "the shebang is not prose",
  "#!/usr/bin/env bash\n# real comment",
  "\n# real comment",
);

check(
  "a hash on line 1 that is not a shebang is a comment",
  "# real comment\nset -eu",
  "# real comment\n",
);

check(
  "a trailing comment is not extracted",
  "rm -rf /tmp/x  # clean up",
  "",
);

check(
  "a quoted heredoc body is not comments",
  "cat <<'EOF'\n# managed by catena\nEOF\n# real",
  "\n\n\n# real",
);

check(
  "an unquoted heredoc body is not comments",
  "cat <<EOF\n# managed by catena\nEOF\n# real",
  "\n\n\n# real",
);

check(
  "a double-quoted delimiter works",
  'cat <<"EOF"\n# body\nEOF\n# real',
  "\n\n\n# real",
);

check(
  "a tab-stripping heredoc closes on the trimmed delimiter",
  "cat <<-EOF\n\t# body\n\tEOF\n# real",
  "\n\n\n# real",
);

check(
  "a here-string opens no body",
  "grep x <<< \"$var\"\n# real",
  "\n# real",
);

check(
  "two heredocs on one line consume their bodies in order",
  "diff <(cat <<A\n# body a\nA\n) <(cat <<B\n# body b\nB\n)\n# real",
  "\n\n\n\n\n\n\n# real",
);

check(
  "a heredoc opener written inside a comment does not open a body",
  "# see cat <<EOF for the pattern\n# still a comment",
  "# see cat <<EOF for the pattern\n# still a comment",
);

check(
  "a redirect to a file plus heredoc still tracks the body",
  "cat >/etc/catena/gatus.yml <<'EOF'\n# managed by catena\nEOF\n# real",
  "\n\n\n# real",
);

check("an empty file stays empty", "", "");

console.log("shell-comments: ok");
