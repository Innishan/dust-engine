import assert from "node:assert/strict";
import { addressMatches, derivePrivateKeyAddress, normalizeDeployerPrivateKey } from "./dust-genesis-key-validation.js";

// This deterministic fixture is public test data only and must never be used for funds.
const TEST_PRIVATE_KEY = `0x${"0".repeat(63)}1` as const;
const TEST_WRONG_ADDRESS = "0x1111111111111111111111111111111111111111" as const;

const accepted = normalizeDeployerPrivateKey(` \t${TEST_PRIVATE_KEY}\r\n`);
assert.equal(accepted, TEST_PRIVATE_KEY, "accept a 0x-prefixed 64-digit key and trim surrounding whitespace");
assert.equal(normalizeDeployerPrivateKey(TEST_PRIVATE_KEY.slice(2)), undefined, "reject a missing 0x prefix");
assert.equal(normalizeDeployerPrivateKey(`0x${"1".repeat(63)}`), undefined, "reject a short key");
assert.equal(normalizeDeployerPrivateKey(`0x${"1".repeat(65)}`), undefined, "reject a long key");
assert.equal(normalizeDeployerPrivateKey(`0x${"g"}${"1".repeat(63)}`), undefined, "reject non-hex characters");

const derivedTestAddress = derivePrivateKeyAddress(TEST_PRIVATE_KEY);
assert.ok(derivedTestAddress, "derive a valid test-only key");
assert.equal(addressMatches(derivedTestAddress, TEST_WRONG_ADDRESS), false, "reject a valid key with a mismatched address");
assert.equal(addressMatches(derivedTestAddress, derivedTestAddress), true, "accept a matching derived address");

console.log("Dust Genesis key validation tests passed (test-only fixture; no secrets used).");
