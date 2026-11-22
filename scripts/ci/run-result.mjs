// Assertions on a script run of the tests ({status, out, err}): ok wants exit
// 0, fails wants another exit and, given one, the message in the output.
import { strict as assert } from "node:assert";

export const ok = (r, label) => {
  assert.equal(r.status, 0, `${label}: exit ${r.status}\n${r.out}\n${r.err}`);
  return r;
};

export const fails = (r, label, message) => {
  assert.notEqual(r.status, 0, `${label}: passed\n${r.out}\n${r.err}`);
  if (message) assert.ok(`${r.out}${r.err}`.includes(message), `${label}: want "${message}"\n${r.out}\n${r.err}`);
  return r;
};
