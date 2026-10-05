import type { Address } from "viem";

export type WalletDiagnosticState = {
  status: string;
  address?: Address;
  chainId?: number;
  connectorId?: string;
  connectorName?: string;
  activeSection: string;
  environment: "farcaster-mini-app" | "normal-web";
};

export const walletDiagnosticsEnabled = import.meta.env.VITE_WALLET_DIAGNOSTICS === "true";

export function logWalletDiagnostic(event: string, state: WalletDiagnosticState, extra: Record<string, unknown> = {}) {
  if (!walletDiagnosticsEnabled) return;
  try {
    console.info(`[WALLET_DIAG] ${event}`, { ...state, ...extra });
  } catch {
    // Diagnostics must never affect wallet or transaction behavior.
  }
}

export function getWalletErrorDetails(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const cause = value.cause && typeof value.cause === "object" ? value.cause as Record<string, unknown> : {};
  const message = typeof value.shortMessage === "string" ? value.shortMessage
    : typeof value.message === "string" ? value.message
      : String(error);
  return {
    errorCode: value.code ?? cause.code,
    errorMessage: message.slice(0, 500),
    ...(typeof value.method === "string" ? { providerMethod: value.method } : {}),
    ...(typeof cause.method === "string" ? { providerMethod: cause.method } : {}),
  };
}
