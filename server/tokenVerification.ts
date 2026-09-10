import { getAddress, isAddress, zeroAddress, type Address } from "viem";

export const MAX_VERIFICATION_TOKENS = 2_000;
export const BALANCE_CHUNK_SIZE = 50;
export const METADATA_CHUNK_SIZE = 50;
const MAX_RPC_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

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

type VerificationLogger = Pick<Console, "warn">;

export type VerificationOptions = {
  maxRpcAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: VerificationLogger;
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

function errorDetails(error: unknown): { type: string; message: string } {
  const type = error instanceof Error ? error.name : typeof error;
  const rawMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const message = /429|rate.?limit|too many requests/.test(rawMessage)
    ? "rate_limited"
    : /timeout|timed out|abort/.test(rawMessage)
      ? "timeout"
      : /network|transport|fetch|socket|econn/.test(rawMessage)
        ? "transport_failure"
        : "rpc_multicall_failure";
  return { type, message };
}

async function multicallWithRetry(
  client: VerificationClient,
  contracts: readonly unknown[],
  stage: "balance" | "metadata",
  chunkIndex: number,
  options: Required<Pick<VerificationOptions, "maxRpcAttempts" | "retryDelayMs" | "sleep" | "logger">>,
): Promise<MulticallResult[] | undefined> {
  for (let attempt = 1; attempt <= options.maxRpcAttempts; attempt += 1) {
    try {
      return await client.multicall({ allowFailure: true, contracts });
    } catch (error) {
      const { type, message } = errorDetails(error);
      options.logger.warn(
        `[Token verification] stage=${stage} chunk=${chunkIndex} attempt=${attempt}/${options.maxRpcAttempts} errorType=${type} message=${message}`,
      );
      if (attempt < options.maxRpcAttempts) await options.sleep(options.retryDelayMs * attempt);
    }
  }
  return undefined;
}

export async function verifyTokenCandidates(
  request: TokenVerificationRequest,
  client: VerificationClient,
  options: VerificationOptions = {},
): Promise<TokenVerificationResponse> {
  const balances = new Map<string, { address: Address; rawBalance: bigint }>();
  let failedChunks = 0;
  const retryOptions = {
    maxRpcAttempts: options.maxRpcAttempts ?? MAX_RPC_ATTEMPTS,
    retryDelayMs: options.retryDelayMs ?? RETRY_DELAY_MS,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    logger: options.logger ?? console,
  };

  for (const [chunkIndex, chunk] of chunks(request.tokens, BALANCE_CHUNK_SIZE).entries()) {
    const results = await multicallWithRetry(
      client,
      chunk.map((address) => ({ address, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [request.address] })),
      "balance",
      chunkIndex + 1,
      retryOptions,
    );
    if (!results) {
      failedChunks += 1;
      continue;
    }
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
      if (chunkFailed) {
        failedChunks += 1;
        retryOptions.logger.warn(`[Token verification] stage=balance chunk=${chunkIndex + 1} individualCallFailures=true`);
      }
  }

  const verified: VerifiedToken[] = [];
  for (const [chunkIndex, chunk] of chunks([...balances.values()], METADATA_CHUNK_SIZE).entries()) {
    const results = await multicallWithRetry(
      client,
      chunk.flatMap(({ address }) => [
        { address, abi: ERC20_READ_ABI, functionName: "decimals" },
        { address, abi: ERC20_READ_ABI, functionName: "symbol" },
      ]),
      "metadata",
      chunkIndex + 1,
      retryOptions,
    );
    if (!results) {
      failedChunks += 1;
      continue;
    }
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
      if (chunkFailed) {
        failedChunks += 1;
        retryOptions.logger.warn(`[Token verification] stage=metadata chunk=${chunkIndex + 1} individualCallFailures=true`);
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
