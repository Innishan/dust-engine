import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

const PRIVATE_KEY_FORMAT = /^0x[0-9a-fA-F]{64}$/;

/** Accept only a complete, 0x-prefixed 32-byte account private key. */
export function normalizeDeployerPrivateKey(input: string): Hex | undefined {
  const trimmed = input.trim();
  return PRIVATE_KEY_FORMAT.test(trimmed) ? trimmed as Hex : undefined;
}

/** Derive an address without exposing the key or an exception that might contain input. */
export function derivePrivateKeyAddress(privateKey: Hex): Address | undefined {
  try {
    return privateKeyToAccount(privateKey).address;
  } catch {
    return undefined;
  }
}

export function addressMatches(actual: Address, expected: Address): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}
