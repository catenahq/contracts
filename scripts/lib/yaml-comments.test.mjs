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
  "a trailing comment keeps its column",
  "command: /bin/true  # runs it",
  "                    # runs it",
);

check(
  "a hash inside a double-quoted scalar is not a comment",
  'name: "deploy # not a comment"',
  "",
);

check(
  "a hash inside a single-quoted scalar is not a comment",
  "name: 'deploy # not a comment'",
  "",
);

check(
  "an escaped quote does not end a single-quoted scalar early",
  "name: 'it''s # still a scalar'",
  "",
);

check(
  "a real comment after a quoted scalar is found",
  'name: "deploy"  # the real one',
  "                # the real one",
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
  "a comment on the block scalar header is kept",
  "script: | # header comment\n  # not a comment\nnext: 1",
  "          # header comment\n\n",
);

check(
  "a block scalar ends at a dedent",
  "script: |\n  content\nother: 2  # found\n",
  "\n\n          # found\n",
);

check(
  "folded and chomped block indicators are recognised",
  "a: >-\n  # content\nb: 1",
  "\n\n",
);

check(
  "blank lines inside a block scalar stay inside it",
  "script: |\n  one\n\n  # still content\nnext: 1",
  "\n\n\n\n",
);

check("an empty file stays empty", "", "");

console.log("yaml-comments: ok");
