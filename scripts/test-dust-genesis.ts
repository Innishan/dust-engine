import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import Database from "better-sqlite3";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DUST_GENESIS_CAMPAIGN_DURATION_SECONDS, DUST_GENESIS_PROFILE_URL, createDustGenesisRouter, initializeDustGenesisTables } from "../server/dustGenesis.js";

const SIGNER_KEY = `0x${"11".repeat(32)}` as Hex;
const WALLET_A_KEY = `0x${"22".repeat(32)}` as Hex;
const WALLET_B_KEY = `0x${"33".repeat(32)}` as Hex;
const signer = privateKeyToAccount(SIGNER_KEY);
const walletA = privateKeyToAccount(WALLET_A_KEY);
const walletB = privateKeyToAccount(WALLET_B_KEY);
const CONTRACT = "0x1111111111111111111111111111111111111111" as Address;
const testUrls = {
  announcement: "https://x.com/PLACEHOLDER_TEST_ANNOUNCEMENT_DO_NOT_USE",
};

const db = new Database(":memory:");
initializeDustGenesisTables(db);
let now = 1_800_000_000_000;
let mockedHasMinted = false;
let mockedMintingClosed = false;
let mockedChainId = 8453;
let mockedAuthorizedSigner: Address = signer.address;
let mockedCampaignStartTimestamp = 1_799_000_000n;
let mockedCampaignDeadline = mockedCampaignStartTimestamp + BigInt(DUST_GENESIS_CAMPAIGN_DURATION_SECONDS);
const app = express();
app.use(express.json());
app.use("/api/dust-genesis", createDustGenesisRouter(db, {
  xAnnouncementUrl: testUrls.announcement,
  contractAddress: CONTRACT,
  signerPrivateKey: SIGNER_KEY,
  now: () => now,
  chainEligibility: {
    chainId: async () => mockedChainId,
    hasMinted: async () => mockedHasMinted,
    mintingClosed: async () => mockedMintingClosed,
    authorizedSigner: async () => mockedAuthorizedSigner,
    campaignStartTimestamp: async () => mockedCampaignStartTimestamp,
    campaignDeadline: async () => mockedCampaignDeadline,
    chainTimestamp: async () => BigInt(Math.floor(now / 1000)),
  },
}));
app.use("/api/dust-genesis-unconfigured", createDustGenesisRouter(db, { now: () => now }));
const closedDb = new Database(":memory:");
closedDb.close();
app.use("/api/dust-genesis-db-error", createDustGenesisRouter(closedDb, { now: () => now }));
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
const api = `http://127.0.0.1:${address.port}/api/dust-genesis`;

async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

async function postTo(baseUrl: string, path: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

async function authenticate(account: typeof walletA) {
  const challenge = await post("/auth/nonce", { walletAddress: account.address });
  assert.equal(challenge.status, 200);
  const signature = await account.signMessage({ message: challenge.data.message });
  const verified = await post("/auth/verify", {
    walletAddress: account.address,
    nonce: challenge.data.nonce,
    signature,
  });
  assert.equal(verified.status, 200);
  return { token: verified.data.accessToken as string, challenge: challenge.data };
}

try {
  const config = await fetch(`${api}/config`).then((response) => response.json()) as {
    tasks: Array<{ label: string; url: string | null }>;
    campaignStartTimestamp: number;
    campaignDeadline: number;
  };
  assert.equal(config.tasks[0].label, "Follow the official Dust Engine X profile");
  assert.equal(config.tasks[0].url, DUST_GENESIS_PROFILE_URL);
  assert.equal(config.tasks[1].url, testUrls.announcement);
  assert.equal(config.campaignDeadline - config.campaignStartTimestamp, DUST_GENESIS_CAMPAIGN_DURATION_SECONDS);
  for (let index = 0; index < 29; index += 1) {
    assert.equal((await fetch(`${api}/config`)).status, 200);
  }
  assert.equal((await fetch(`${api}/config`)).status, 429, "public campaign endpoint is rate limited");

  assert.equal((await post("/tasks/profile/start", {})).status, 401, "task progress requires wallet proof");
  const foreignChallenge = await post("/auth/nonce", { walletAddress: walletA.address });
  assert.equal((await post("/auth/verify", {
    walletAddress: walletA.address,
    nonce: foreignChallenge.data.nonce,
    signature: await walletB.signMessage({ message: foreignChallenge.data.message }),
  })).status, 401, "a different wallet cannot prove ownership");
  const authA = await authenticate(walletA);
  const replayedWalletProof = await post("/auth/verify", {
    walletAddress: walletA.address,
    nonce: authA.challenge.nonce,
    signature: await walletA.signMessage({ message: authA.challenge.message }),
  });
  assert.equal(replayedWalletProof.status, 400, "wallet nonce is one-use");

  const concurrentChallenge = await post("/auth/nonce", { walletAddress: walletA.address });
  const concurrentSignature = await walletA.signMessage({ message: concurrentChallenge.data.message });
  const concurrentProofs = await Promise.all([
    post("/auth/verify", { walletAddress: walletA.address, nonce: concurrentChallenge.data.nonce, signature: concurrentSignature }),
    post("/auth/verify", { walletAddress: walletA.address, nonce: concurrentChallenge.data.nonce, signature: concurrentSignature }),
  ]);
  assert.deepEqual(concurrentProofs.map((result) => result.status).sort(), [200, 400], "concurrent wallet-proof replay is accepted at most once");

  const malformedStart = await post("/tasks/profile/start", { clientTimestamp: now }, authA.token);
  assert.equal(malformedStart.status, 400, "client timestamps are rejected");
  assert.equal((await post("/authorization", {}, authA.token)).status, 403, "mint authorization requires both tasks");

  assert.equal((await post("/tasks/profile/start", {}, authA.token)).status, 200);
  assert.equal((await post("/tasks/announcement/start", {}, authA.token)).status, 403, "announcement stays locked until the profile delay completes");
  now += 5_000;
  assert.equal((await post("/tasks/profile/start", {}, authA.token)).status, 200, "reopening a task cannot reset its start time");
  now += 4_999;
  let progress = await post("/progress", {}, authA.token);
  assert.deepEqual(progress.data, { profileComplete: false, announcementComplete: false }, "server delay cannot be bypassed");
  assert.equal((await post("/tasks/announcement/start", {}, authA.token)).status, 403, "announcement is still locked at 9.999 seconds");
  now += 1;
  progress = await post("/progress", {}, authA.token);
  assert.equal(progress.data.profileComplete, true, "task completes after server elapsed time");
  assert.equal(progress.data.announcementComplete, false);

  now += 100;
  assert.equal((await post("/tasks/announcement/start", {}, authA.token)).status, 200);
  assert.equal((await post("/tasks/announcement/start", {}, authA.token)).status, 200, "repeated task starts remain safe and idempotent");
  now += 10_000;
  progress = await post("/progress", {}, authA.token);
  assert.deepEqual(progress.data, { profileComplete: true, announcementComplete: true });

  const authB = await authenticate(walletB);
  assert.equal((await post("/authorization", {}, authB.token)).status, 403, "task progress is isolated by wallet");

  const authorization = await post("/authorization", {}, authA.token);
  assert.equal(authorization.status, 200);
  assert.equal(authorization.data.contractAddress, CONTRACT);
  assert.equal(authorization.data.recipient.toLowerCase(), walletA.address.toLowerCase());
  assert.ok(authorization.data.expiry <= Math.floor(now / 1000) + 5 * 60, "mint authorization is short-lived");
  const recovered = await recoverTypedDataAddress({
    domain: { name: "Dust Genesis", version: "1", chainId: 8453, verifyingContract: CONTRACT },
    types: { MintAuthorization: [
      { name: "recipient", type: "address" },
      { name: "nonce", type: "bytes32" },
      { name: "expiry", type: "uint256" },
    ] },
    primaryType: "MintAuthorization",
    message: { recipient: walletA.address, nonce: authorization.data.nonce as Hex, expiry: BigInt(authorization.data.expiry) },
    signature: authorization.data.signature as Hex,
  });
  assert.equal(recovered.toLowerCase(), signer.address.toLowerCase(), "authorization is signed by the configured dedicated signer");

  const secondsNow = Math.floor(now / 1000);
  mockedCampaignStartTimestamp = BigInt(secondsNow - DUST_GENESIS_CAMPAIGN_DURATION_SECONDS + 120);
  mockedCampaignDeadline = BigInt(secondsNow + 120);
  const nearDeadlineAuthorization = await post("/authorization", {}, authA.token);
  assert.equal(nearDeadlineAuthorization.status, 200);
  assert.equal(nearDeadlineAuthorization.data.expiry, Number(mockedCampaignDeadline), "authorization expiry is capped at campaign deadline");
  now = Number(mockedCampaignDeadline) * 1000;
  assert.equal((await post("/authorization", {}, authA.token)).status, 403, "no authorization is issued exactly at campaign expiry");

  const unconfiguredApi = `http://127.0.0.1:${address.port}/api/dust-genesis-unconfigured`;
  const unconfiguredAuthorization = await postTo(unconfiguredApi, "/authorization", {}, authA.token);
  assert.equal(unconfiguredAuthorization.status, 503, "missing contract and signer configuration fails closed");

  const dbErrorConfig = await fetch(`http://127.0.0.1:${address.port}/api/dust-genesis-db-error/config`);
  assert.equal(dbErrorConfig.status, 503, "config rate-limit database failures return a controlled service error");
  assert.deepEqual(await dbErrorConfig.json(), { error: "Dust Genesis campaign state could not be checked" });
  const dbErrorProgress = await postTo(`http://127.0.0.1:${address.port}/api/dust-genesis-db-error`, "/progress", {}, authA.token);
  assert.equal(dbErrorProgress.status, 503, "progress database failures cannot be mistaken for task completion");
  assert.deepEqual(dbErrorProgress.data, { error: "Dust Genesis task progress could not be checked" });

  mockedHasMinted = true;
  assert.equal((await post("/authorization", {}, authA.token)).status, 403, "claimed wallets cannot receive another authorization");
  mockedHasMinted = false;
  mockedMintingClosed = true;
  assert.equal((await post("/authorization", {}, authA.token)).status, 403, "closed minting blocks authorizations");
  mockedMintingClosed = false;
  mockedChainId = 1;
  assert.equal((await post("/authorization", {}, authA.token)).status, 403, "authorization is issued only after a Base chain check");
  mockedChainId = 8453;
  mockedCampaignStartTimestamp = 0n;
  assert.equal((await post("/authorization", {}, authA.token)).status, 403, "no authorization is issued before one-time campaign activation");
  mockedCampaignStartTimestamp = BigInt(Math.floor(now / 1000) - DUST_GENESIS_CAMPAIGN_DURATION_SECONDS);
  mockedCampaignDeadline = BigInt(Math.floor(now / 1000));
  assert.equal((await post("/authorization", {}, authA.token)).status, 403, "no authorization is issued after campaign expiry");
  mockedCampaignStartTimestamp = BigInt(Math.floor(now / 1000) - DUST_GENESIS_CAMPAIGN_DURATION_SECONDS + 120);
  mockedCampaignDeadline = BigInt(Math.floor(now / 1000) + 120);
  mockedAuthorizedSigner = walletB.address;
  assert.equal((await post("/authorization", {}, authA.token)).status, 403, "backend refuses to sign when its key differs from the on-chain signer");

  console.log("Dust Genesis backend tests passed");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
}
