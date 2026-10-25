import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { createPublicClient, http, isAddress } from "viem";
import { base } from "viem/chains";
import { addressMatches, derivePrivateKeyAddress, normalizeDeployerPrivateKey } from "./dust-genesis-key-validation.js";

const CONFIG_PATH = resolve(process.cwd(), ".env.dust-genesis");
const EXPECTED_DEPLOYER = "0xEe36C3c644240302eB8121F66D4e23C068512a40";
const EXPECTED_SIGNER = "0x699C2b62196667D5D9D550C405780d3C91C84057";
const EXPECTED_METADATA_URI = "ipfs://bafkreidir2sulyf2m67bvxltfhexguovjxzfdwqrggcdtehii3e5yh4wky";

function fail(message: string): never {
  console.error(`Dust Genesis preflight failed: ${message}`);
  process.exit(1);
}

if (!existsSync(CONFIG_PATH)) fail("the ignored .env.dust-genesis public configuration file is missing.");

let config: Record<string, string>;
try {
  config = parse(readFileSync(CONFIG_PATH));
} catch {
  fail("could not read .env.dust-genesis.");
}

if (Object.keys(config).some((name) => /PRIVATE_KEY|API_KEY|SECRET/i.test(name))) {
  fail(".env.dust-genesis must contain public settings only; remove secret settings from that file.");
}

const required = [
  "DUST_GENESIS_EXPECTED_DEPLOYER_ADDRESS",
  "DUST_GENESIS_OWNER_ADDRESS",
  "DUST_GENESIS_EXPECTED_OWNER_ADDRESS",
  "DUST_GENESIS_SIGNER_ADDRESS",
  "DUST_GENESIS_EXPECTED_SIGNER_ADDRESS",
  "DUST_GENESIS_METADATA_URI",
];
const missing = required.filter((name) => !config[name]?.trim());
if (missing.length > 0) fail(`missing public setting(s): ${missing.join(", ")}.`);

const normalized = (name: string) => config[name].trim().toLowerCase();
if (!isAddress(config.DUST_GENESIS_EXPECTED_DEPLOYER_ADDRESS)
  || normalized("DUST_GENESIS_EXPECTED_DEPLOYER_ADDRESS") !== EXPECTED_DEPLOYER.toLowerCase()) {
  fail("expected deployer address does not match the confirmed address.");
}
if (!isAddress(config.DUST_GENESIS_OWNER_ADDRESS)
  || !isAddress(config.DUST_GENESIS_EXPECTED_OWNER_ADDRESS)
  || normalized("DUST_GENESIS_OWNER_ADDRESS") !== EXPECTED_DEPLOYER.toLowerCase()
  || normalized("DUST_GENESIS_EXPECTED_OWNER_ADDRESS") !== EXPECTED_DEPLOYER.toLowerCase()
  || normalized("DUST_GENESIS_OWNER_ADDRESS") !== normalized("DUST_GENESIS_EXPECTED_OWNER_ADDRESS")) {
  fail("owner addresses do not match the confirmed owner.");
}
if (!isAddress(config.DUST_GENESIS_SIGNER_ADDRESS)
  || !isAddress(config.DUST_GENESIS_EXPECTED_SIGNER_ADDRESS)
  || normalized("DUST_GENESIS_SIGNER_ADDRESS") !== EXPECTED_SIGNER.toLowerCase()
  || normalized("DUST_GENESIS_EXPECTED_SIGNER_ADDRESS") !== EXPECTED_SIGNER.toLowerCase()
  || normalized("DUST_GENESIS_SIGNER_ADDRESS") !== normalized("DUST_GENESIS_EXPECTED_SIGNER_ADDRESS")) {
  fail("signer addresses do not match the confirmed backend signer.");
}
if (config.DUST_GENESIS_METADATA_URI.trim() !== EXPECTED_METADATA_URI) {
  fail("metadata URI does not match the confirmed final URI.");
}

const deployerInput = process.env.DUST_GENESIS_DEPLOYER_PRIVATE_KEY;
if (!deployerInput?.trim()) fail("no deployer key was entered.");
const deployerKey = normalizeDeployerPrivateKey(deployerInput);
if (!deployerKey) {
  fail("invalid key format. Enter the account's exported private key with a 0x prefix and exactly 64 hexadecimal characters; never enter a seed phrase.");
}
const deployerAddress = derivePrivateKeyAddress(deployerKey);
if (!deployerAddress) fail("the entered value has the correct format but is not a valid account private key.");
if (!addressMatches(deployerAddress, EXPECTED_DEPLOYER)) {
  fail("the private key does not match the confirmed deployer account. Verify the selected wallet account.");
}

const rpcUrl = process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
try {
  const chainId = await createPublicClient({ chain: base, transport: http(rpcUrl) }).getChainId();
  if (chainId !== 8453) fail("RPC endpoint is not reporting Base Mainnet chain ID 8453.");
} catch {
  fail("could not confirm Base Mainnet chain ID from the RPC endpoint.");
}

console.log("Dust Genesis preflight passed: public settings match, deployer key matches, and RPC reports Base Mainnet (8453).");
console.log("No deployment or transaction was submitted.");
