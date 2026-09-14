export type BalanceReadResult = {
  status?: string;
  result?: unknown;
};

type TokenCandidate = { address: string };

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
