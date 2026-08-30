import { decodeEventLog, isAddress, isHash } from "viem";
import { DUST_ENGINE_ABI, DUST_ENGINE_ADDRESS } from "../src/contracts/dustEngine.js";

export const BASE_CHAIN_ID = 8453;

export type CleanVerificationResult =
  | { ok: true; ambassadorId: string; eventId: string; quantity: number; completedAt: string }
  | { ok: false; reason: string };

type BaseRpcClient = {
  getChainId: () => Promise<number>;
  getBlockNumber: () => Promise<bigint>;
  getBlock: (parameters: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
  getTransaction: (parameters: { hash: `0x${string}` }) => Promise<{ from: string; to: string | null }>;
  getTransactionReceipt: (parameters: { hash: `0x${string}` }) => Promise<{
    status: string;
    blockNumber: bigint;
    logs: Array<{ address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }>;
  }>;
};

export async function verifyCleanDustTransaction({
  txHash,
  client,
  minimumConfirmations,
  findApprovedAmbassadorId,
}: {
  txHash: string;
  client: BaseRpcClient;
  minimumConfirmations: number;
  findApprovedAmbassadorId: (walletAddress: string) => string | undefined;
}): Promise<CleanVerificationResult> {
  if (!isHash(txHash)) return { ok: false, reason: "Invalid transaction hash" };
  if (!Number.isInteger(minimumConfirmations) || minimumConfirmations < 1) return { ok: false, reason: "Invalid confirmation configuration" };

  try {
    if (await client.getChainId() !== BASE_CHAIN_ID) return { ok: false, reason: "Configured RPC is not Base" };
    const hash = txHash.toLowerCase() as `0x${string}`;
    const [transaction, receipt, head] = await Promise.all([
      client.getTransaction({ hash }),
      client.getTransactionReceipt({ hash }),
      client.getBlockNumber(),
    ]);
    if (receipt.status !== "success") return { ok: false, reason: "Transaction did not succeed" };
    if (head < receipt.blockNumber || (head - receipt.blockNumber + 1n) < BigInt(minimumConfirmations)) {
      return { ok: false, reason: "Transaction is not sufficiently confirmed" };
    }
    if (!transaction.to || transaction.to.toLowerCase() !== DUST_ENGINE_ADDRESS.toLowerCase()) {
      return { ok: false, reason: "Transaction was not sent to Dust Engine" };
    }
    if (!isAddress(transaction.from)) return { ok: false, reason: "Transaction sender is invalid" };
    const ambassadorId = findApprovedAmbassadorId(transaction.from.toLowerCase());
    if (!ambassadorId) return { ok: false, reason: "Transaction sender is not an approved ambassador" };

    let quantity = 0;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== DUST_ENGINE_ADDRESS.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: DUST_ENGINE_ABI, data: log.data, topics: log.topics as any });
        if (decoded.eventName === "Debug" && (decoded.args as { success?: boolean }).success === true) quantity += 1;
      } catch {
        // Logs from the Dust Engine contract that are not Debug events are irrelevant.
      }
    }
    if (quantity <= 0) return { ok: false, reason: "No successful Clean Dust events found" };

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return {
      ok: true,
      ambassadorId,
      eventId: `clean:${BASE_CHAIN_ID}:${hash}`,
      quantity,
      completedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
  } catch {
    // Do not leak RPC provider details to callers.
    return { ok: false, reason: "Unable to verify Clean Dust transaction" };
  }
}

// Bridge verification deliberately stops at this server-only contract. The repository
// has no trusted LI.FI completion/status API or USD valuation source yet, so no Bridge
// endpoint is exposed until a provider can supply this independently verified evidence.
export type VerifiedBridgeEvidence = {
  sourceChainId: number;
  sourceTransactionHash: `0x${string}`;
  sender: string;
  bridgeProcess: "CROSS_CHAIN";
  completedAt: string;
  actualSourceAmount: string;
  bridgeVolumeUsd: number;
};
