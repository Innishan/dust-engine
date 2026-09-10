import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatUnits } from "viem";
import {
  MAX_VERIFICATION_TOKENS,
  parseTokenVerificationRequest,
  verifyTokenCandidates,
  type VerificationClient,
} from "../server/tokenVerification";

const wallet = "0xf5ED4F07cDdD8CF29E33EE3b7a0266D5538dE912";
const sixDecimals = "0x1111111111111111111111111111111111111111";
const eighteenDecimals = "0x2222222222222222222222222222222222222222";
const zeroBalance = "0x3333333333333333333333333333333333333333";

function clientFor(options: { failBalanceFor?: string; resultFailBalanceFor?: string; failDecimalsFor?: string; failSymbolFor?: string } = {}): VerificationClient {
  return {
    async multicall({ contracts }: any) {
      const functionName = contracts[0]?.functionName;
      if (functionName === "balanceOf") {
        if (options.failBalanceFor && contracts.some((contract: any) => contract.address.toLowerCase() === options.failBalanceFor?.toLowerCase())) throw new Error("RPC failure");
        return contracts.map((contract: any) => ({
          status: options.resultFailBalanceFor?.toLowerCase() === contract.address.toLowerCase() ? "failure" : "success",
          result: contract.address.toLowerCase() === sixDecimals.toLowerCase()
            ? 188854n
            : contract.address.toLowerCase() === eighteenDecimals.toLowerCase()
              ? 1500000000000000000n
              : 0n,
        }));
      }
      return contracts.map((contract: any) => {
        const isSix = contract.address.toLowerCase() === sixDecimals.toLowerCase();
        if (contract.functionName === "decimals") {
          return options.failDecimalsFor?.toLowerCase() === contract.address.toLowerCase()
            ? { status: "failure" }
            : { status: "success", result: isSix ? 6 : 18 };
        }
        return options.failSymbolFor?.toLowerCase() === contract.address.toLowerCase()
          ? { status: "failure" }
          : { status: "success", result: isSix ? "GENERIC6" : "GENERIC18" };
      });
    },
  };
}

async function run() {
  const request = parseTokenVerificationRequest({ address: wallet, tokens: [sixDecimals, eighteenDecimals, zeroBalance] });
  const verified = await verifyTokenCandidates(request, clientFor());
  assert.equal(verified.status, "success");
  assert.equal(verified.tokens.length, 2);
  assert.deepEqual(verified.diagnostics, {
    balanceTransportFailures: 0,
    balanceCallFailures: 0,
    metadataTransportFailures: 0,
    decimalsFailures: 0,
    symbolFailures: 0,
    verifiedPositiveBalances: 2,
    errorCategories: { rate_limited: 0, timeout: 0, transport_failure: 0, rpc_multicall_failure: 0 },
  });
  assert.equal(verified.tokens.find((token) => token.address.toLowerCase() === sixDecimals.toLowerCase())?.rawBalance, "188854");
  assert.equal(formatUnits(188854n, 6), "0.188854");
  assert.equal(formatUnits(1500000000000000000n, 18), "1.5");

  const missingDecimals = await verifyTokenCandidates(request, clientFor({ failDecimalsFor: sixDecimals }));
  assert.equal(missingDecimals.status, "partial_success");
  assert.equal(missingDecimals.tokens.some((token) => token.address.toLowerCase() === sixDecimals.toLowerCase()), false);
  assert.equal(missingDecimals.diagnostics.decimalsFailures, 1);

  const missingSymbol = await verifyTokenCandidates(request, clientFor({ failSymbolFor: sixDecimals }));
  assert.equal(missingSymbol.tokens.find((token) => token.address.toLowerCase() === sixDecimals.toLowerCase())?.symbol, "???");
  assert.equal(missingSymbol.diagnostics.symbolFailures, 1);

  let transientCalls = 0;
  const diagnosticMessages: string[] = [];
  const transient = await verifyTokenCandidates(request, {
    async multicall(multicallRequest) {
      transientCalls += 1;
      if (transientCalls === 1) throw new Error("429 https://rpc.example/v2/secret-key?apiKey=leaked");
      return clientFor().multicall(multicallRequest);
    },
  }, {
    maxRpcAttempts: 3,
    retryDelayMs: 0,
    sleep: async () => undefined,
    logger: { warn: (message: string) => diagnosticMessages.push(message) },
  });
  assert.equal(transient.tokens.length, 2);
  assert.equal(transientCalls, 3);
  assert.equal(diagnosticMessages.length, 1);
  assert.match(diagnosticMessages[0]!, /stage=balance chunk=1 attempt=1\/3 errorType=Error/);
  assert.doesNotMatch(diagnosticMessages[0]!, /secret-key|leaked|rpc\.example/);

  let metadataTransientCalls = 0;
  const metadataTransient = await verifyTokenCandidates(request, {
    async multicall(multicallRequest: any) {
      if (multicallRequest.contracts[0]?.functionName === "decimals") {
        metadataTransientCalls += 1;
        if (metadataTransientCalls === 1) throw new Error("temporary metadata transport failure");
      }
      return clientFor().multicall(multicallRequest);
    },
  }, { maxRpcAttempts: 3, retryDelayMs: 0, sleep: async () => undefined, logger: { warn: () => undefined } });
  assert.equal(metadataTransient.tokens.length, 2);
  assert.equal(metadataTransientCalls, 2);

  let permanentCalls = 0;
  const permanent = await verifyTokenCandidates(
    parseTokenVerificationRequest({ address: wallet, tokens: [sixDecimals] }),
    { async multicall() { permanentCalls += 1; throw new Error("transport unavailable"); } },
    { maxRpcAttempts: 3, retryDelayMs: 0, sleep: async () => undefined, logger: { warn: () => undefined } },
  );
  assert.equal(permanent.status, "verification_unavailable");
  assert.equal(permanentCalls, 3);
  assert.equal(permanent.diagnostics.balanceTransportFailures, 3);
  assert.equal(permanent.diagnostics.errorCategories.transport_failure, 3);

  const individualBalanceFailure = await verifyTokenCandidates(request, clientFor({ resultFailBalanceFor: sixDecimals }));
  assert.equal(individualBalanceFailure.diagnostics.balanceCallFailures, 1);
  assert.equal(individualBalanceFailure.tokens.some((token) => token.address.toLowerCase() === sixDecimals.toLowerCase()), false);

  const partial = await verifyTokenCandidates(
    parseTokenVerificationRequest({
      address: wallet,
      tokens: [
        sixDecimals,
        ...Array.from({ length: 99 }, (_, index) => `0x${(index + 10).toString(16).padStart(40, "0")}`),
        eighteenDecimals,
      ],
    }),
    clientFor({ failBalanceFor: eighteenDecimals }),
    { maxRpcAttempts: 1, logger: { warn: () => undefined } },
  );
  assert.equal(partial.status, "partial_success");
  assert.equal(partial.tokens.length, 1);
  assert.equal(partial.tokens[0]?.address.toLowerCase(), sixDecimals.toLowerCase());

  assert.throws(() => parseTokenVerificationRequest({ address: "invalid", tokens: [sixDecimals] }));
  assert.throws(() => parseTokenVerificationRequest({ address: wallet, tokens: ["not-an-address"] }));
  assert.throws(() => parseTokenVerificationRequest({ address: wallet, tokens: [sixDecimals], rawBalance: "1" }));
  assert.throws(() => parseTokenVerificationRequest({ address: wallet, tokens: Array(MAX_VERIFICATION_TOKENS + 1).fill(sixDecimals) }));
  const verificationSource = readFileSync(new URL("../server/tokenVerification.ts", import.meta.url), "utf8");
  assert.match(verificationSource, /functionName: "balanceOf"/);
  assert.doesNotMatch(verificationSource, /\b(?:USDC|UP|AERO)\b/);
  console.log("token verification tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
