export type RouteQuoteStatus =
  | "route_unavailable"
  | "route_input_mismatch"
  | "route_output_invalid"
  | "route_token_mismatch"
  | "route_recipient_mismatch"
  | "transaction_data_invalid"
  | "route_quote_validated";

export type RouteQuoteDiagnostic = {
  status: RouteQuoteStatus;
  inputAmount?: string;
  outputAmount?: string;
  minimumOutputAmount?: string;
};

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function address(value: unknown): string | undefined {
  return typeof value === "string" && /^0x[\da-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
}
function amount(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  try { return BigInt(value); } catch { return undefined; }
}

/** Validates the route quote and transaction request for the exact input Dust Engine asked LI.FI to route. */
export function diagnoseRouteQuote(input: {
  route?: unknown;
  step?: unknown;
  transactionRequest?: unknown;
  requestedInputAmount: string;
  expectedInputToken: string;
  expectedOutputToken: string;
  expectedRecipient: string;
}): RouteQuoteDiagnostic {
  const route = record(input.route);
  const step = record(input.step);
  const action = record(step?.action);
  const tx = record(input.transactionRequest);
  if (!route || !step || !action) return { status: "route_unavailable" };

  const inputAmount = typeof route.fromAmount === "string" ? route.fromAmount : undefined;
  const outputAmount = typeof route.toAmount === "string" ? route.toAmount : undefined;
  const minimumOutputAmount = typeof route.toAmountMin === "string" ? route.toAmountMin : undefined;
  const parsedInput = amount(inputAmount);
  const expectedInput = amount(input.requestedInputAmount);
  if (parsedInput === undefined || expectedInput === undefined || parsedInput !== expectedInput) {
    return { status: "route_input_mismatch", inputAmount, outputAmount, minimumOutputAmount };
  }
  const parsedOutput = amount(outputAmount);
  const parsedMinimum = amount(minimumOutputAmount);
  if (parsedOutput === undefined || parsedMinimum === undefined || parsedOutput <= 0n || parsedMinimum <= 0n || parsedMinimum > parsedOutput) {
    return { status: "route_output_invalid", inputAmount, outputAmount, minimumOutputAmount };
  }

  const fromToken = record(route.fromToken);
  const toToken = record(route.toToken);
  if (Number(route.fromChainId) !== 8453 || Number(route.toChainId) !== 8453
    || address(fromToken?.address) !== address(input.expectedInputToken)
    || address(toToken?.address) !== address(input.expectedOutputToken)) {
    return { status: "route_token_mismatch", inputAmount, outputAmount, minimumOutputAmount };
  }
  const expectedRecipient = address(input.expectedRecipient);
  if (!expectedRecipient || address(action.toAddress) !== expectedRecipient
    || (route.toAddress !== undefined && address(route.toAddress) !== expectedRecipient)) {
    return { status: "route_recipient_mismatch", inputAmount, outputAmount, minimumOutputAmount };
  }
  const txTo = address(tx?.to);
  const txData = tx?.data;
  const txValue = tx?.value;
  const validTxValue = txValue === undefined
    || (typeof txValue === "string" && /^(?:\d+|0x[\da-f]+)$/i.test(txValue) && BigInt(txValue) >= 0n)
    || (typeof txValue === "bigint" && txValue >= 0n)
    || (typeof txValue === "number" && Number.isSafeInteger(txValue) && txValue >= 0);
  if (!tx || !txTo || typeof txData !== "string" || !/^0x(?:[\da-f]{2})+$/i.test(txData) || !validTxValue) {
    return { status: "transaction_data_invalid", inputAmount, outputAmount, minimumOutputAmount };
  }
  return { status: "route_quote_validated", inputAmount, outputAmount, minimumOutputAmount };
}
