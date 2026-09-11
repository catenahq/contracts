// Unit test for the YAML comment skeleton. Run with
// `node scripts/lib/yaml-comments.test.mjs` (also wired as part of
// `npm test`).
import { strict as assert } from "node:assert";
import { commentSkeleton } from "./yaml-comments.mjs";

function check(name, input, expected) {
  const got = commentSkeleton(input);
  assert.equal(got, expected, `${name}\n  got:      ${JSON.stringify(got)}\n  expected: ${JSON.stringify(expected)}`);
  const inLines = input.split("\n").length;
  const outLines = got.split("\n").length;
  assert.equal(outLines, inLines, `${name}: line count ${outLines} != ${inLines}`);
}

check(
  "a whole-line comment keeps its column",
  "  # history here\nname: x",
  "  # history here\n",
);

check(
  "a comment at column zero is kept",
  "# history here\nname: x",
  "# history here\n",
);

// Trailing comments are out of scope: they carry none of the findings
// and separating them from a `#` inside a scalar needs quote tracking.
check(
  "a trailing comment is not extracted",
  "command: /bin/true  # runs it",
  "",
);

check(
  "a hash inside a quoted scalar is not extracted either",
  'name: "deploy # not a comment"',
  "",
);

check(
  "a hash with no preceding space is not a comment",
  "url: https://example.com/#anchor",
  "",
);

check(
  "block scalar content is not a comment",
  "script: |\n  # not a comment\n  echo hi\nnext: 1",
  "\n\n\n",
);

check(
  "a comment on the block scalar header does not open a scan of its body",
  "script: | # header comment\n  # not a comment\nnext: 1",
  "\n\n",
);

check(
  "a block scalar ends at a dedent",
  "script: |\n  content\n# found\n",
  "\n\n# found\n",
);

check(
  "folded and chomped block indicators are recognised",
  "a: >-\n  # content\nb: 1",
  "\n\n",
);

check(
  "an indent indicator is recognised",
  "a: |2\n  # content\nb: 1",
  "\n\n",
);

check(
  "blank lines inside a block scalar stay inside it",
  "script: |\n  one\n\n  # still content\nnext: 1",
  "\n\n\n\n",
);

check(
  "markdown in a block scalar is not a comment",
  "notes: |-\n  ## Gaps (tracked, not hidden)\n\n  - a bullet\nother: 1",
  "\n\n\n\n",
);

check(
  "a nested block scalar closes at the parent indent",
  "a:\n  b: |\n    # content\n  c: 1\n# real\n",
  "\n\n\n\n# real\n",
);

check(
  "a pipe inside a quoted value does not open a block scalar",
  'cmd: "a | b"\n# real comment',
  "\n# real comment",
);

check("an empty file stays empty", "", "");

console.log("yaml-comments: ok");
