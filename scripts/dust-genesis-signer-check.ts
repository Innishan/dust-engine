import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

const EXPECTED_SIGNER = "0x699C2b62196667D5D9D550C405780d3C91C84057";
const signerKey = process.env.DUST_GENESIS_SIGNER_PRIVATE_KEY?.trim();

if (!signerKey) {
  console.error("Dust Genesis signer check failed: backend signer key is not configured in this backend environment.");
  process.exit(1);
}

try {
  const account = privateKeyToAccount(signerKey as Hex);
  if (account.address.toLowerCase() !== EXPECTED_SIGNER.toLowerCase()) {
    console.error("Dust Genesis signer check failed: backend key does not derive to the confirmed signer address.");
    process.exit(1);
  }
} catch {
  console.error("Dust Genesis signer check failed: backend key is invalid or does not derive to the confirmed signer address.");
  process.exit(1);
}

console.log("Dust Genesis backend signer key matches the confirmed public signer address.");
