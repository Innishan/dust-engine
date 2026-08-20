# Dust Engine

Dust Engine is an EVM wallet asset consolidation application, currently focused on Base mainnet. It helps users find small ERC-20 balances in a wallet, value eligible balances, obtain same-chain swap routes, and submit selected conversions through the existing DustEngine execution contract.

The current implementation targets conversions to WETH/ETH liquidity on Base. It is available as a web application and includes Farcaster Mini App integration.

## Product vision

Dust Engine is intended to consolidate forgotten EVM wallet assets across macro-balances, dust, and micro-balances into ETH. That is the product vision, not a claim about the current classification model or network coverage. Today, the application implements Base-focused, threshold-based ERC-20 dust discovery and same-chain routing to WETH.

## The problem

Wallets commonly accumulate small, fragmented token balances. Individually, these balances can be inconvenient to evaluate and swap. Dust Engine brings the discovery, on-chain balance checks, price lookups, route construction, and batch execution flow into one interface so users can decide which eligible balances to consolidate.

## Current features

- Connects injected and Coinbase Wallet-compatible wallets with Wagmi and ConnectKit.
- Operates on Base mainnet (`chainId` `8453`).
- Discovers ERC-20 candidates from Base Blockscout token balances and recent token transfers.
- Verifies discovered balances on-chain with batched `balanceOf` calls.
- Retrieves USD prices from Blockscout data where available, then CoinGecko, with DexScreener as a fallback.
- Lets users set a dust threshold, review results, select assets, and add a Base ERC-20 token manually.
- Requests Base-to-Base routes to WETH through the LI.FI SDK.
- Uses Permit2 batch-transfer typed-data signatures for the selected routed tokens.
- Submits one `cleanDust` transaction to the configured DustEngine contract when routes are available.
- Parses contract receipt events to report per-token outcomes and retain failed assets in the UI.
- Includes Farcaster Mini App SDK initialization and a Frame manifest.

## How it works

1. Connect a wallet and scan the connected wallet, or enter an EVM address to inspect.
2. The server and client query Base Blockscout for token-balance and transfer-history candidates.
3. The client deduplicates the candidates and checks current ERC-20 balances on Base using multicall.
4. Tokens with balances are priced, valued in USD, and marked eligible when they meet the current dust filter and have price/verification data.
5. The user reviews and selects eligible assets. For every selected token, the client asks LI.FI for a Base-to-Base route to WETH with the DustEngine contract as the route recipient.
6. The wallet approves Permit2 as necessary, then signs a Permit2 batch-transfer authorization for routed tokens.
7. The client calls `cleanDust` on the deployed DustEngine contract with the token amounts, Permit2 signature, and generated route calls.
8. After confirmation, receipt events determine the token-level result. The UI removes only tokens identified as successful; unsuccessful tokens remain visible.

## Architecture

| Layer | Responsibility |
| --- | --- |
| React + Vite client | Wallet connection, token scanning workflow, on-chain reads, pricing, route requests, Permit2 signing, execution UI, and receipt handling. |
| Express server (`server.ts`) | Serves the built client; provides health, scan, quote, analytics, webhook, and CORS proxy endpoints. |
| Base services | Base RPC, Base Blockscout, LI.FI, CoinGecko, and DexScreener are used by the current implementation. |
| DustEngine contract | The existing deployed execution layer that receives the batch call at the configured address. It is intentionally out of scope for the current product-improvement phase. |

```text
Wallet
  → Token Discovery
  → On-chain Balance Verification
  → Pricing / Valuation
  → Dust Classification
  → Route Discovery
  → Permit2
  → Existing DustEngine Contract
  → ETH
```

Current development improves off-chain, frontend, and backend functionality around the existing deployed contract. It does not modify, redeploy, or otherwise change that contract.

## Token discovery and dust detection

Discovery starts with Base Blockscout token-balance data and recent ERC-20 transfers. The frontend supplements the server scan with a direct Blockscout balance query, deduplicates token addresses, and excludes the native-token sentinel address.

The client then verifies balances from the Base RPC using batched ERC-20 `balanceOf` calls. This on-chain verification is the source used to determine whether a discovered token currently has a nonzero balance.

The current implementation uses a configurable USD threshold for dust classification; it is a threshold-based implementation, not the final detection model. By default, the UI treats a token as dust when it is priced and verified, has a value from `$0.01` through the selected threshold, and is not WETH. The initial threshold is `$1.00`; users can adjust it between `$0.01` and `$5.00`. The “Show All Coins” view exposes all scanned results.

## Balance verification

Candidate balances returned by an indexer are not used as the final balance for selection. The client queries each discovered ERC-20 on Base with `balanceOf(wallet)` through multicall, in chunks with limited retry handling. Balances are formatted with the token’s discovered decimals before valuation and execution.

## Token valuation and pricing

The price sequence in the current client is:

1. Exchange-rate data supplied with discovered Blockscout tokens, when present.
2. CoinGecko’s Base token-price endpoint, requested in batches with a single-token fallback.
3. DexScreener for tokens still missing a price.
4. Local fallback prices for the configured common Base assets: USDC, USDT, DAI, and WETH.

Tokens without a usable price remain visible in the full-results view but are not automatically selected as eligible dust.

## Swap routing

Dust Engine requests routes from LI.FI for same-chain Base swaps (`8453` to `8453`) from each selected token to Base WETH. The client requests the DustEngine contract as both the source and destination recipient for routing purposes, requires the returned route step to target that contract, and validates the generated transaction request before including it in a batch.

Not every token will have a route. Tokens with no valid route or an invalid transaction request are skipped before the contract call.

## Permit2

Before execution, the client checks each selected token’s ERC-20 allowance to the canonical Permit2 address. If required, the wallet is asked to approve Permit2. The client then finds an unused Permit2 nonce bit and requests a single EIP-712 `PermitBatchTransferFrom` signature whose spender is the configured DustEngine contract. The signature has a one-hour deadline in the current implementation.

Approval and signature prompts are wallet actions; review them carefully before confirming.

## Partial-success execution

Batch execution is designed to surface token-level results. After a successful transaction receipt, the client parses `Debug` events emitted by the configured contract ABI. Tokens marked successful are included in the completion total and removed from the UI; tokens without a successful result remain, and the UI displays a partial-success message when applicable.

This behavior reflects the application’s receipt-processing logic. A mined transaction does not by itself guarantee that every requested token conversion succeeded.

## Supported network

**Base mainnet only** is configured today:

- Chain ID: `8453`
- RPC: `https://mainnet.base.org`
- Output asset used by routing: Base WETH (`0x4200000000000000000000000000000000000006`)

Although several components are capable of working with more than one network, this application currently configures only Base. Do not treat it as a fully implemented multi-chain product.

## Deployed contract information

The client references the following deployed DustEngine contract address:

`0x8CE9D13FEb45cFd723dac5923896A96A46DD3894`

The repository ABI exposes `cleanDust`, which accepts token and amount arrays, a Permit2 signature/nonce/deadline, and parallel target/value/calldata arrays. The ABI also includes events such as `CallResult`, `Debug`, and `SwapFailed`, along with read methods including `FEE_PERCENT`, `FEE_WALLET`, `PERMIT2`, `WETH`, `owner`, and `paused`.

This contract is production infrastructure and the execution layer for Dust Engine. It is intentionally out of scope for the current product-improvement phase: development improves the off-chain, frontend, and backend experience around it without modifying, redeploying, or changing the contract address or Solidity behavior.

## Security considerations

- Treat every wallet approval and Permit2 signature as a security-sensitive action. Confirm the chain, token, spender, amount, and transaction in your wallet.
- Token discovery and pricing depend on external indexers and market-data services. A token being discovered or priced does not establish that it is safe, liquid, or suitable to trade.
- A route may be unavailable or fail. The application validates route data client-side, but users remain responsible for reviewing wallet prompts and transaction outcomes.
- Use a dedicated testing wallet when developing locally. Never commit private keys, seed phrases, API keys, or populated environment files.
- This repository documents and interacts with an existing deployed contract; it does not authorize contract redeployment or contract changes.

## Project structure

```text
src/
  App.tsx                    Main wallet, scan, pricing, routing, and execution UI
  contracts/dustEngine.ts    Configured contract address and ABI
  main.tsx                   React entry point
  index.css                  Application styles
public/
  .well-known/farcaster.json Farcaster Frame manifest
server.ts                    Express API and static-file server
```

## Local development

Prerequisites:

- Node.js (use a current LTS release)
- A wallet that can connect to Base mainnet

Install packages and start the Vite development server:

```bash
npm install
npm run dev
```

The Vite development server is configured for port `3000`.

To run the Express server, first create a production build, then start it:

```bash
npm run build
npm run start
```

The Express server defaults to port `4000` and serves `dist/`. It also exposes `/api/health` and `/api/scan/:address`.

## Environment variables

Copy `.env.example` to a local environment file when needed. The example declares these optional server-side variables:

| Variable | Purpose in the current server |
| --- | --- |
| `DEBANK_API_KEY` | Its presence is reported by `/api/health`; it is not used by the current scan implementation. |
| `ONE_INCH_API_KEY` | Its presence is reported by `/api/health`; it is not used by the current LI.FI routing flow. |
| `PORT` | Optional Express port override; defaults to `4000`. |

Do not put real credentials in the README, source files, or commits.

## Available scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite development server. |
| `npm run build` | Build the client into `dist/`. |
| `npm run start` | Run `server.ts` with `tsx`; it serves the built client and API. |
| `npm run preview` | Preview the Vite production build on port `3000`. |
| `npm run lint` | Run TypeScript type checking with no emitted files. |
| `npm run clean` | Remove `dist/`. |

## Testing

There is no dedicated automated test script in the current `package.json`. At minimum, run the type check before submitting a change:

```bash
npm run lint
```

For manual validation, use a Base wallet with known small ERC-20 balances, inspect the scan results, and carefully review any wallet prompts. Do not test by changing the deployed contract.

## Deployment

The production server serves the Vite build from `dist/` and exposes the API routes in `server.ts`. A deployment therefore needs to build the client before starting the server.

Deployment configuration is intentionally outside the scope of this README. Do not change the deployed contract address, contract behavior, or deployment configuration as part of documentation work.

## Farcaster Mini App

The client initializes `@farcaster/miniapp-sdk` and calls `sdk.actions.ready()` at startup. The Frame manifest at `public/.well-known/farcaster.json` identifies Dust Engine, points to `https://dustengine.xyz`, and includes the configured webhook URL. The server responds to `GET` and `POST` requests at `/api/webhook`.

## Current status and roadmap

The current implementation provides Base-only wallet connection, token discovery, on-chain balance verification, pricing, threshold-based dust filtering, LI.FI route requests, Permit2 signing, contract execution UI, receipt-based per-token success handling, and Farcaster Mini App metadata. Macro/micro-balance classification, multi-chain support, Lend & Borrow, and Cross-Chain Bridge are not currently implemented.

Development priorities are:

1. Improve dust/token discovery accuracy.
2. Improve scan performance and RPC efficiency.
3. Improve pricing and route-quality evaluation.
4. Improve mobile and Farcaster UX.
5. Lend & Borrow — **Coming Soon**.
6. Cross-Chain Bridge — **Coming Soon**.
7. Expand supported EVM networks.

## Contributing

Keep changes scoped and reviewable. In particular, do not modify Solidity or contract behavior, change the deployed contract address, alter deployment configuration, or commit generated `dist/` files unless the task explicitly requires it.
