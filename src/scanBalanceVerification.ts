export type BalanceReadResult = {
  status?: string;
  result?: unknown;
  error?: unknown;
};

type TokenCandidate = { address: string };
export const MAX_INDIVIDUAL_BALANCE_RETRIES_PER_SCAN = 25;

function errorDetails(error: unknown): Array<{ name?: unknown; message?: unknown; shortMessage?: unknown; code?: unknown; status?: unknown; cause?: unknown }> {
  const details = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const item = current as { name?: unknown; message?: unknown; shortMessage?: unknown; code?: unknown; status?: unknown; cause?: unknown };
    details.push(item);
    current = item.cause;
  }
  return details;
}

export function isTransientBalanceReadError(error: unknown): boolean {
  const details = errorDetails(error);
  return details.some((item) => {
    const code = String(item.code ?? "").toUpperCase();
    const status = Number(item.status);
    const message = [item.name, item.shortMessage, item.message]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase();
    return ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ERR_NETWORK"].includes(code)
      || status === 429 || status === 502 || status === 503 || status === 504
      || /timeout|timed out|abort|rate.?limit|too many requests|network error|fetch failed|transport error|temporarily unavailable/.test(message);
  });
}

export async function retryFailedBalanceReads<T extends TokenCandidate>(
  tokens: readonly T[],
  initialResults: readonly BalanceReadResult[],
  retryRead: (token: T) => Promise<BalanceReadResult>,
  shouldRetry: (error: unknown) => boolean = isTransientBalanceReadError,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRetries = MAX_INDIVIDUAL_BALANCE_RETRIES_PER_SCAN,
): Promise<{ results: BalanceReadResult[]; retriedCount: number; retryOmittedCount: number }> {
  const results = tokens.map((_, index) => initialResults[index] ?? {});
  const retryIndexes = tokens.flatMap((_, index) => {
    const result = results[index];
    return result.status === "failure" && shouldRetry(result.error) ? [index] : [];
  });
  const selectedIndexes = retryIndexes.slice(0, Math.max(0, maxRetries));
  for (const [position, index] of selectedIndexes.entries()) {
    if (position > 0) await wait(100);
    try {
      results[index] = await retryRead(tokens[index]);
    } catch (error) {
      results[index] = { status: "failure", error };
    }
  }
  return { results, retriedCount: selectedIndexes.length, retryOmittedCount: retryIndexes.length - selectedIndexes.length };
}

export function recordSuccessfulBalances<T extends TokenCandidate>(
  balancesByAddress: Map<string, bigint>,
  tokens: readonly T[],
  results: readonly BalanceReadResult[],
): void {
  tokens.forEach((token, index) => {
    const result = results[index];
    if (result?.status === "success" && typeof result.result === "bigint") {
      balancesByAddress.set(token.address.toLowerCase(), result.result);
    }
  });
}

export function verifiedPositiveBalances<T extends TokenCandidate>(
  tokens: readonly T[],
  balancesByAddress: ReadonlyMap<string, bigint>,
): Array<{ token: T; balance: bigint }> {
  return tokens.flatMap((token) => {
    const balance = balancesByAddress.get(token.address.toLowerCase());
    return balance !== undefined && balance > 0n ? [{ token, balance }] : [];
  });
}
