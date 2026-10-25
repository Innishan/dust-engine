# Dust Genesis contract

This is an isolated Foundry project for the new Dust Genesis collection. It does not import, call, or configure the existing Dust Engine contract.

## Dependency and compiler pin

- OpenZeppelin Contracts: `5.7.0`, official stable release tag `v5.7.0`, MIT license.
- OpenZeppelin release commit: `cab19933c33c2ad1d4c7a84864a3601dddfd16f3` (verified release tag).
- The dependency is pinned exactly in the root `package.json` and `package-lock.json`. OpenZeppelin source is consumed from `node_modules/@openzeppelin/contracts` without modifications.
- Solidity compiler: `0.8.33` (exact pragma and Foundry `solc_version`).
- Foundry profile: optimizer enabled, 200 runs, `via_ir = false`, EVM target `cancun`, metadata bytecode hash `ipfs`.

## Reproducing the build and tests

Use Node.js/npm, Foundry, and the exact Solidity compiler version. From the repository root:

```sh
npm ci
forge --version
solc --version
forge build --offline --use "$(command -v solc)" --root contracts/dust-genesis
forge test --offline --use "$(command -v solc)" --root contracts/dust-genesis -vv
```

The compiler command must report `0.8.33`. The test suite uses Foundry cheat codes directly and has no additional test dependency.

## Contract behavior

- All token IDs return the same metadata URI configured once in the constructor.
- `mint` is free and mints safely to `msg.sender`; each address can mint once.
- An EIP-712 signature must match the recipient, a unique nonce, and an expiry no more than five minutes in the future. The EIP-712 domain binds it to the current chain and this contract. Used nonces are recorded on chain.
- Expiry boundary: an authorization remains valid when `block.timestamp == expiry` and becomes invalid only when `block.timestamp > expiry`. `testAuthorizationIsValidAtExactExpiryBoundary` covers the equality boundary; `testExpiredAuthorizationReverts` covers the first later timestamp.
- The owner can rotate the dedicated signer and can permanently close minting. Closure has no inverse function.
- The owner activates the campaign exactly once by calling `activateCampaign(startTimestamp)`. Deployment does not start the campaign. The explicit Unix timestamp may be now or a future time; the contract permanently derives the deadline as `startTimestamp + 14 days`. Minting is rejected before activation, before the configured start, and when `block.timestamp >= campaignDeadline()`.
- The backend checks the active campaign window against the Base RPC block timestamp, caps authorization expiry at the on-chain campaign deadline, and stops issuing authorizations at or after expiry. The frontend refreshes campaign state and disables Claim outside the active window; the contract remains authoritative.
- The owner uses OpenZeppelin `Ownable2Step`; renouncing ownership is disabled so the authority to close minting cannot be discarded. There are no withdrawal, pause, upgrade, or metadata-editing functions.
- Dust Genesis implements the Creator Token interface manually on the existing OpenZeppelin 5.7 ERC-721. Its OpenZeppelin 5 `_update` hook calls `validateTransfer(address,address,address,uint256)` for non-mint, non-burn transfers only when a validator is configured. The default validator is zero: minting, campaign activation, and ordinary transfers work without a validator. This default does not enforce creator earnings.
- The owner can configure or clear an optional validator without redeploying. A nonzero validator must have deployed code and advertise the configured LimitBreak `ITransferValidator` ERC-165 interface. This generic compatibility check does not establish that a validator is OpenSea's registry or that creator earnings are enforced. Only set an address after independently verifying its chain deployment, interface, behavior, and marketplace compatibility. There is no hard-coded or assumed Base validator address.
- OpenSea support confirmed that enforced creator earnings require `StrictAuthorizedTransferSecurityRegistry` and that disabling enforcement removes the validator. The Base Mainnet registry address remains unverified, so Dust Genesis does not claim OpenSea enforcement and no registry address is configured by deployment. The owner-only setter can accept a verified compatible validator later, and can clear it; while cleared, ordinary transfers are unrestricted. OpenSea compatibility must be confirmed separately before describing or relying on enforcement.

## Metadata and IPFS

The verified Pinata artwork CID is `bafybeiflm5n3fvf7n4caki3ytti3vyy6xuxgsx7ekyucic3d6fw4u7nfhm`. The verified shared ERC-721 metadata URI is `ipfs://bafkreidir2sulyf2m67bvxltfhexguovjxzfdwqrggcdtehii3e5yh4wky`. Set that exact URI as `DUST_GENESIS_METADATA_URI` for deployment. The constructor stores the URI once at deployment, and every token returns that same URI; it is fixed in the contract and has no owner-editing function. The checked-in `metadata/dust-genesis.json` remains a template and is not the deployed metadata document.

## Deployment inputs

The deployment script requires chain ID `8453` and reads `DUST_GENESIS_DEPLOYER_PRIVATE_KEY`, `DUST_GENESIS_EXPECTED_DEPLOYER_ADDRESS`, `DUST_GENESIS_OWNER_ADDRESS`, `DUST_GENESIS_EXPECTED_OWNER_ADDRESS`, `DUST_GENESIS_SIGNER_ADDRESS`, `DUST_GENESIS_EXPECTED_SIGNER_ADDRESS`, and `DUST_GENESIS_METADATA_URI`. Before broadcasting, it derives the deployer address from the key and independently pins the deployer, owner, signer, and metadata URI to the confirmed values documented above; the expected-address variables cannot override those pins. It also rejects empty or recognizable placeholder metadata strings. No transfer-validator address is required or configured during deployment. Keep the deployment key only in a protected environment. The backend separately needs `DUST_GENESIS_SIGNER_PRIVATE_KEY` for the same signer address, plus `DUST_GENESIS_CONTRACT_ADDRESS` after deployment. No keys are hardcoded here.

### Local preparation and preflight

The ignored repository-root file `.env.dust-genesis` contains only the confirmed public deployment values. It does not replace `.env`; do not add private keys, API tokens, or the backend signing key to it. The deployer key is requested through hidden terminal input. Enter only the wallet account's exported private key, formatted as `0x` followed by exactly 64 hexadecimal characters. Never enter a seed phrase. The preflight trims surrounding whitespace, validates the format before deriving the address, and never prints the key. It checks the derived address, configured owner/signer/metadata values, and that `BASE_RPC_URL` (or the public Base RPC fallback) reports chain ID `8453`. A well-formed key for a different account fails closed.

Keep `DUST_GENESIS_DEPLOYER_PRIVATE_KEY` local and use it only for the deployment workflow. Generate a fresh backend signer key; never reuse a previously exposed signer key. Configure `DUST_GENESIS_SIGNER_PRIVATE_KEY` only in the backend's secret manager. In that backend environment, `npm run dust-genesis:signer-check` verifies that the key derives to the confirmed signer address and prints only pass/fail status. The backend authorization endpoint also checks that the configured key matches the contract's current `authorizedSigner` before issuing an authorization.

The local deployment handoff is `npm run dust-genesis:deploy`. It clears any inherited deployer-key environment value, runs the hidden-input preflight, then validates `.env.dust-genesis` with a strict parser that treats file contents only as data. The parser accepts only the six documented public settings, rejects duplicate, malformed, missing, or unexpected entries, and checks the canonical values without evaluating shell syntax. The helper then requires the exact confirmation `BROADCAST BASE MAINNET` and prompts for the deployer key again with terminal echo disabled. The key is passed only in the Foundry child process environment and the shell copy is unset as soon as Foundry exits. The second prompt is intentional: the preflight process clears its own key when it exits, so its key is never retained while waiting for confirmation. The Foundry step uses `--broadcast`; running this command can submit a Base Mainnet deployment transaction after the explicit confirmation. Do not run it until deployment is approved. A failed preflight, declined confirmation, or empty second key exits before invoking Foundry. For a non-broadcast validation path, use `npm run dust-genesis:deploy -- --validate-only`; this still runs the hidden-input preflight and strict public configuration validation, but exits before the confirmation prompt, second key prompt, or Foundry.

The constructor and deploy script intentionally do not accept a campaign start time: this permits deployment and private setup without consuming any campaign duration. After deployment, the owner must explicitly call `activateCampaign(uint256 startTimestamp)` once, for example through an owner-controlled transaction using the finalized Unix timestamp. The call may schedule a future start. It cannot be changed or repeated, so confirm the timestamp before submitting it. The campaign deadline is exactly 1,209,600 seconds after that timestamp. The permanent close function remains available before the deadline.

The contract has not been deployed. No wallet transaction or production change has been made.
