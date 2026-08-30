import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { DUST_ENGINE_ABI, DUST_ENGINE_ADDRESS } from "../src/contracts/dustEngine.js";
import { BASE_CHAIN_ID, verifyCleanDustTransaction } from "../server/ambassadorCleanVerifier.js";

const hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const sender = "0x1111111111111111111111111111111111111111";
const blockNumber = 100n;

function debugLog(success: boolean) {
  return {
    address: DUST_ENGINE_ADDRESS,
    topics: encodeEventTopics({ abi: DUST_ENGINE_ABI, eventName: "Debug" }) as `0x${string}`[],
    data: encodeAbiParameters([{ type: "address" }, { type: "bool" }], ["0x2222222222222222222222222222222222222222", success]),
  };
}

function client({ status = "success", to = DUST_ENGINE_ADDRESS, logs = [debugLog(true)], from = sender, head = 102n } = {}) {
  return {
    getChainId: async () => BASE_CHAIN_ID,
    getBlockNumber: async () => head,
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
    getTransaction: async () => ({ from, to }),
    getTransactionReceipt: async () => ({ status, blockNumber, logs }),
  };
}

async function verify(overrides = {}, approved = true) {
  return verifyCleanDustTransaction({
    txHash: hash,
    client: client(overrides),
    minimumConfirmations: 3,
    findApprovedAmbassadorId: (wallet) => approved && wallet === sender.toLowerCase() ? "ambassador-1" : undefined,
  });
}

const valid = await verify();
assert.equal(valid.ok, true);
if (valid.ok) {
  assert.equal(valid.quantity, 1);
  assert.equal(valid.eventId, `clean:${BASE_CHAIN_ID}:${hash}`);
  assert.equal(valid.ambassadorId, "ambassador-1");
}
assert.equal((await verify({ status: "reverted" })).ok, false, "failed transaction must not award");
assert.equal((await verify({ to: "0x3333333333333333333333333333333333333333" })).ok, false, "wrong destination must not award");
assert.equal((await verify({}, false)).ok, false, "unknown wallet must not award");
assert.equal((await verify({ logs: [debugLog(false)] })).ok, false, "zero successful Debug events must not award");
const repeated = await verify();
assert.equal(repeated.ok, true);
if (repeated.ok) assert.equal(repeated.eventId, valid.ok ? valid.eventId : "", "same hash must produce the same idempotency key");
console.log("Ambassador Clean verifier tests passed");
