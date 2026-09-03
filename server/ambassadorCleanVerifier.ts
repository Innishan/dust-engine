import { decodeEventLog, isAddress, isHash } from "viem";
import { DUST_ENGINE_ABI, DUST_ENGINE_ADDRESS } from "../src/contracts/dustEngine.js";

export const BASE_CHAIN_ID = 8453;

export type CleanVerificationResult =
  | { ok: true; ambassadorId: string; eventId: string; quantity: number; completedAt: string }
  | { ok: false; reason: string };

export type CleanAchievementVerificationResult =
  | { ok: true; eventId: string; walletAddress: string; tokenAddresses: string[]; quantity: number; completedAt: string }
  | { ok: false; reason: string };

export type BaseRpcClient = {
  getChainId: () => Promise<number>;
  getBlockNumber: () => Promise<bigint>;
  getBlock: (parameters: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
  getTransaction: (parameters: { hash: `0x${string}` }) => Promise<{ from: string; to: string | null }>;
  getTransactionReceipt: (parameters: { hash: `0x${string}` }) => Promise<{
    status: string;
    blockNumber: bigint;
    logs: Array<{ address: string; data: `0x${string}`; topics?: readonly `0x${string}`[] }>;
  }>;
};

export async function verifyCleanDustAchievementTransaction({
  txHash,
  client,
  minimumConfirmations,
}: {
  txHash: string;
  client: BaseRpcClient;
  minimumConfirmations: number;
}): Promise<CleanAchievementVerificationResult> {
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

    const tokenAddresses: string[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== DUST_ENGINE_ADDRESS.toLowerCase()) continue;
      if (!log.topics) continue;
      try {
        const decoded = decodeEventLog({ abi: DUST_ENGINE_ABI, data: log.data, topics: log.topics as any });
        if (decoded.eventName === "Debug" && (decoded.args as { success?: boolean }).success === true) {
          const token = (decoded.args as { token?: string }).token;
          if (typeof token === "string" && isAddress(token)) tokenAddresses.push(token.toLowerCase());
        }
      } catch {
        // Irrelevant contract logs do not constitute clean-success evidence.
      }
    }
    if (tokenAddresses.length <= 0) return { ok: false, reason: "No successful Clean Dust events found" };

    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return {
      ok: true,
      eventId: `clean:${BASE_CHAIN_ID}:${hash}`,
      walletAddress: transaction.from.toLowerCase(),
      tokenAddresses,
      quantity: tokenAddresses.length,
      completedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    };
  } catch {
    return { ok: false, reason: "Unable to verify Clean Dust transaction" };
  }
}

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
  const verification = await verifyCleanDustAchievementTransaction({ txHash, client, minimumConfirmations });
  if (!verification.ok) return { ok: false, reason: verification.reason };
  const ambassadorId = findApprovedAmbassadorId(verification.walletAddress);
  if (!ambassadorId) return { ok: false, reason: "Transaction sender is not an approved ambassador" };
  return { ok: true, ambassadorId, eventId: verification.eventId, quantity: verification.quantity, completedAt: verification.completedAt };
}

export type VerifiedBridgeEvidence = {
  sourceChainId: number;
  sourceTransactionHash: `0x${string}`;
  sender: string;
  bridgeProcess: "CROSS_CHAIN";
  completedAt: string;
  actualSourceAmount: string;
  bridgeVolumeUsd: number;
};
