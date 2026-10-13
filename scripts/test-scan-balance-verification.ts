import assert from "node:assert/strict";
import {
  isTransientBalanceReadError,
  MAX_INDIVIDUAL_BALANCE_RETRIES_PER_SCAN,
  recordSuccessfulBalances,
  retryFailedBalanceReads,
  verifiedPositiveBalances,
} from "../src/scanBalanceVerification";

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

let retryCalls = 0;
const recovered = await retryFailedBalanceReads(
  firstChunk,
  [
    { status: "success", result: 0n },
    { status: "failure", error: Object.assign(new Error("temporary gateway error"), { status: 503 }) },
    { status: "success", result: 42n },
  ],
  async () => { retryCalls++; return { status: "success", result: 9n }; },
  isTransientBalanceReadError,
  async () => undefined,
);
assert.equal(retryCalls, 1, "only an identified transient per-call failure is retried");
assert.equal(recovered.retriedCount, 1);
assert.equal(recovered.results[0].result, 0n, "a confirmed zero is preserved and never retried");
assert.equal(recovered.results[1].result, 9n);
assert.equal(recovered.results[2].result, 42n, "successful sibling results remain unchanged");

let deterministicRetryCalls = 0;
const deterministic = await retryFailedBalanceReads(
  [firstChunk[0]],
  [{ status: "failure", error: new Error("execution reverted") }],
  async () => { deterministicRetryCalls++; return { status: "success", result: 1n }; },
  isTransientBalanceReadError,
  async () => undefined,
);
assert.equal(deterministicRetryCalls, 0, "deterministic contract-call failure is not retried");
assert.equal(deterministic.results[0].status, "failure");

let exhaustedCalls = 0;
const exhausted = await retryFailedBalanceReads(
  [firstChunk[1]],
  [{ status: "failure", error: Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" }) }],
  async () => { exhaustedCalls++; throw Object.assign(new Error("upstream timeout"), { code: "ETIMEDOUT" }); },
  isTransientBalanceReadError,
  async () => undefined,
);
assert.equal(exhaustedCalls, 1, "individual retry budget is bounded to one attempt");
assert.equal(exhausted.results[0].status, "failure", "exhausted retry remains unavailable, not zero");

const capped = await retryFailedBalanceReads(
  Array.from({ length: MAX_INDIVIDUAL_BALANCE_RETRIES_PER_SCAN + 2 }, (_, index) => ({ address: `0x${index.toString(16).padStart(40, "0")}` })),
  Array.from({ length: MAX_INDIVIDUAL_BALANCE_RETRIES_PER_SCAN + 2 }, () => ({ status: "failure", error: { status: 429 } })),
  async () => { retryCalls++; return { status: "success", result: 1n }; },
  isTransientBalanceReadError,
  async () => undefined,
);
assert.equal(capped.retriedCount, MAX_INDIVIDUAL_BALANCE_RETRIES_PER_SCAN);
assert.equal(capped.retryOmittedCount, 2, "individual retry work stays capped per scan");

// A thrown chunk records no results, so it cannot synthesize zero balances.
assert.equal(balances.has(failedChunk[0].address), false);

const positives = verifiedPositiveBalances([...firstChunk, ...failedChunk], balances);
assert.deepEqual(positives, [{ token: firstChunk[2], balance: 42n }], "only verified positive balances proceed to metadata");

console.log("scan balance verification tests passed");
