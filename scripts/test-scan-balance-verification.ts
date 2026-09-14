import assert from "node:assert/strict";
import { recordSuccessfulBalances, verifiedPositiveBalances } from "../src/scanBalanceVerification";

const firstChunk = [
  { address: "0x1111111111111111111111111111111111111111" },
  { address: "0x2222222222222222222222222222222222222222" },
  { address: "0x3333333333333333333333333333333333333333" },
];
const failedChunk = [{ address: "0x4444444444444444444444444444444444444444" }];
const balances = new Map<string, bigint>();

recordSuccessfulBalances(balances, firstChunk, [
  { status: "success", result: 0n },
  { status: "failure" },
  { status: "success", result: 42n },
]);

assert.equal(balances.get(firstChunk[0].address), 0n, "successful zero balance must be retained");
assert.equal(balances.has(firstChunk[1].address), false, "failed balance read must remain unavailable");
assert.equal(balances.get(firstChunk[2].address), 42n);

// A thrown chunk records no results, so it cannot synthesize zero balances.
assert.equal(balances.has(failedChunk[0].address), false);

const positives = verifiedPositiveBalances([...firstChunk, ...failedChunk], balances);
assert.deepEqual(positives, [{ token: firstChunk[2], balance: 42n }], "only verified positive balances proceed to metadata");

console.log("scan balance verification tests passed");
