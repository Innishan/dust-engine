import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export const MAX_VERIFICATION_TOKENS = 2_000;
export const BALANCE_CHUNK_SIZE = 50;
export const METADATA_CHUNK_SIZE = 50;

const NATIVE_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const ERC20_READ_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

type MulticallResult = { status?: string; result?: unknown };

export type VerificationClient = {
  multicall: (request: { allowFailure: boolean; contracts: readonly unknown[] }) => Promise<MulticallResult[]>;
};

export type TokenVerificationRequest = {
  address: Address;
  tokens: Address[];
};

export type VerifiedToken = {
  address: Address;
  rawBalance: string;
  decimals: number;
  symbol: string;
};

export type TokenVerificationResponse = {
  status: "success" | "partial_success" | "verification_unavailable";
  tokens: VerifiedToken[];
  failedChunks: number;
  error?: string;
};

function isErc20Address(value: unknown): value is string {
  return typeof value === "string"
    && isAddress(value)
    && value.toLowerCase() !== zeroAddress
    && value.toLowerCase() !== NATIVE_SENTINEL;
}

export function parseTokenVerificationRequest(value: unknown): TokenVerificationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object");
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("address") || !keys.includes("tokens")) {
    throw new Error("Only address and tokens are accepted");
  }
  if (!isAddress(body.address)) throw new Error("Invalid wallet address");
  if (!Array.isArray(body.tokens) || body.tokens.length > MAX_VERIFICATION_TOKENS) {
    throw new Error(`tokens must contain at most ${MAX_VERIFICATION_TOKENS} addresses`);
  }

  const tokens = new Map<string, Address>();
  for (const token of body.tokens) {
    if (!isErc20Address(token)) throw new Error("Invalid ERC-20 token address");
    const normalized = getAddress(token);
    tokens.set(normalized.toLowerCase(), normalized);
  }
  return { address: getAddress(body.address as string), tokens: [...tokens.values()] };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push([...values.slice(index, index + size)]);
  return result;
}

function validDecimals(result: MulticallResult | undefined): number | undefined {
  const decimals = Number(result?.result);
  return result?.status === "success" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255
    ? decimals
    : undefined;
}

export async function verifyTokenCandidates(
  request: TokenVerificationRequest,
  client: VerificationClient,
): Promise<TokenVerificationResponse> {
  const balances = new Map<string, { address: Address; rawBalance: bigint }>();
  let failedChunks = 0;

  for (const chunk of chunks(request.tokens, BALANCE_CHUNK_SIZE)) {
    try {
      const results = await client.multicall({
        allowFailure: true,
        contracts: chunk.map((address) => ({ address, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [request.address] })),
      });
      let chunkFailed = false;
      chunk.forEach((address, index) => {
        const result = results[index];
        if (result?.status !== "success") {
          chunkFailed = true;
          return;
        }
        if (typeof result.result !== "bigint") {
          chunkFailed = true;
          return;
        }
        if (result.result > 0n) balances.set(address.toLowerCase(), { address, rawBalance: result.result });
      });
      if (chunkFailed) failedChunks += 1;
    } catch {
      failedChunks += 1;
    }
  }

  const verified: VerifiedToken[] = [];
  for (const chunk of chunks([...balances.values()], METADATA_CHUNK_SIZE)) {
    try {
      const results = await client.multicall({
        allowFailure: true,
        contracts: chunk.flatMap(({ address }) => [
          { address, abi: ERC20_READ_ABI, functionName: "decimals" },
          { address, abi: ERC20_READ_ABI, functionName: "symbol" },
        ]),
      });
      let chunkFailed = false;
      chunk.forEach(({ address, rawBalance }, index) => {
        const decimals = validDecimals(results[index * 2]);
        if (decimals === undefined) {
          chunkFailed = true;
          return;
        }
        const symbolResult = results[index * 2 + 1];
        verified.push({
          address,
          rawBalance: rawBalance.toString(),
          decimals,
          symbol: symbolResult?.status === "success" && typeof symbolResult.result === "string" && symbolResult.result
            ? symbolResult.result
            : "???",
        });
      });
      if (chunkFailed) failedChunks += 1;
    } catch {
      failedChunks += 1;
    }
  }

  if (request.tokens.length > 0 && balances.size === 0 && failedChunks > 0) {
    return { status: "verification_unavailable", tokens: [], failedChunks, error: "Base RPC verification failed" };
  }
  return { status: failedChunks > 0 ? "partial_success" : "success", tokens: verified, failedChunks };
}

export function configuredBaseRpcUrl(baseRpcUrl?: string, alchemyApiKey?: string): string | undefined {
  if (baseRpcUrl?.trim()) return baseRpcUrl.trim();
  return alchemyApiKey?.trim()
    ? `https://base-mainnet.g.alchemy.com/v2/${encodeURIComponent(alchemyApiKey.trim())}`
    : undefined;
}
