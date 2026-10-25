import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  announcementMarkdown: "[Campaign announcement](https://x.com/PLACEHOLDER_TEST_ANNOUNCEMENT_DO_NOT_USE)",
};

const appSource = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(appSource, /if \(window\.location\.pathname === "\/genesis"\) \{\s*return \(\s*<WagmiProvider config=\{config\} reconnectOnMount=\{false\}>/s,
  "the Genesis route does not automatically reconnect a wallet on page load");
const campaignStart = appSource.indexOf("function DustGenesisCampaign()");
const campaignEnd = appSource.indexOf("function WalletDiagnostics", campaignStart);
assert.ok(campaignStart >= 0 && campaignEnd > campaignStart, "Dust Genesis campaign component exists");
const campaignSource = appSource.slice(campaignStart, campaignEnd);
assert.match(campaignSource, /const claimDisabled = claiming \|\| !tasksComplete \|\| !campaign\?\.contractAddress \|\| !campaignActive;/,
  "Claim NFT stays disabled until the campaign and task requirements are met");
assert.match(campaignSource, /!campaignActive && inactiveCampaignReason/,
  "an inactive campaign explains why claiming is unavailable");
assert.match(campaignSource, /The Dust Genesis campaign has not been activated yet\./,
  "the inactive campaign explanation identifies the unactivated state");
assert.match(campaignSource, /const unavailable = !task\.url \|\| locked \|\| busy;/,
  "the profile link remains enabled when it has a URL and the announcement is the only locked task");
assert.match(campaignSource, /if \(unavailable\) \{\s*return \(\s*<button[^>]*disabled/s,
  "locked task destinations are rendered as genuinely disabled controls");
assert.match(campaignSource, /const locked = task\.id === "announcement" && !progress\.profileComplete;/,
  "the announcement stays locked until server-reported profile completion");
const openTaskStart = campaignSource.indexOf("const openTask = async");
const openTaskEnd = campaignSource.indexOf("const hasExpectedMintEvent", openTaskStart);
const claimStart = campaignSource.indexOf("const claimNft = async");
const claimEnd = campaignSource.indexOf("useEffect(() => {\n    if (!showSuccess)", claimStart);
assert.ok(openTaskStart >= 0 && openTaskEnd > openTaskStart && claimStart > openTaskEnd && claimEnd > claimStart);
assert.doesNotMatch(campaignSource.slice(openTaskStart, openTaskEnd), /ensureWalletSession|signMessageAsync|setOpen\(|\/auth\/(nonce|verify)/,
  "task-link interactions do not connect or request wallet signatures");
assert.match(campaignSource.slice(claimStart, claimEnd), /ensureWalletSession\(/,
  "wallet verification starts only in the Claim NFT handler");
assert.equal((campaignSource.match(/ensureWalletSession\(/g) ?? []).length, 1,
  "campaign load and task links cannot invoke the wallet session flow");
assert.equal((campaignSource.match(/signMessageAsync\(/g) ?? []).length, 1,
  "Dust Genesis invokes wallet signing only in the claim session flow");
assert.equal((campaignSource.match(/setOpen\(true\)/g) ?? []).length, 1,
  "the claim button is the only Dust Genesis path that opens wallet connection UI");

const db = new Database(":memory:");
initializeDustGenesisTables(db);
const anonymousDb = new Database(":memory:");
initializeDustGenesisTables(anonymousDb);
const missingAnnouncementDb = new Database(":memory:");
initializeDustGenesisTables(missingAnnouncementDb);
let now = 1_800_000_000_000;
let missingAnnouncementNow = now;
let mockedHasMinted = false;
let mockedMintingClosed = false;
let mockedChainId = 8453;
let mockedAuthorizedSigner: Address = signer.address;
let mockedCampaignStartTimestamp = 1_799_000_000n;
let mockedCampaignDeadline = mockedCampaignStartTimestamp + BigInt(DUST_GENESIS_CAMPAIGN_DURATION_SECONDS);
const app = express();
app.use(express.json());
app.use("/api/dust-genesis", createDustGenesisRouter(db, {
  xAnnouncementUrl: testUrls.announcementMarkdown,
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
app.use("/api/dust-genesis-anonymous", createDustGenesisRouter(anonymousDb, {
  xAnnouncementUrl: testUrls.announcementMarkdown,
  now: () => now,
  secureCookies: true,
}));
app.use("/api/dust-genesis-missing-announcement", createDustGenesisRouter(missingAnnouncementDb, {
  now: () => missingAnnouncementNow,
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

async function post(path: string, body: unknown, token?: string, cookie?: string) {
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

async function postTo(baseUrl: string, path: string, body: unknown, token?: string, cookie?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, any> };
}

async function authenticateAt(baseUrl: string, account: typeof walletA) {
  const challenge = await postTo(baseUrl, "/auth/nonce", { walletAddress: account.address });
  assert.equal(challenge.status, 200);
  const signature = await account.signMessage({ message: challenge.data.message });
  const verified = await postTo(baseUrl, "/auth/verify", {
    walletAddress: account.address,
    nonce: challenge.data.nonce,
    signature,
  });
  assert.equal(verified.status, 200);
  return { token: verified.data.accessToken as string, challenge: challenge.data };
}

try {
  const configResponse = await fetch(`${api}/config`);
  const config = await configResponse.json() as {
    tasks: Array<{ label: string; url: string | null }>;
    campaignStartTimestamp: number;
    campaignDeadline: number;
  };
  const anonymousApi = `http://127.0.0.1:${address.port}/api/dust-genesis-anonymous`;
  const anonymousConfigResponse = await fetch(`${anonymousApi}/config`);
  const taskCookie = anonymousConfigResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(taskCookie, "campaign config establishes an HttpOnly anonymous task session");
  assert.match(anonymousConfigResponse.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict; Max-Age=3600; Secure/);
  assert.equal(anonymousConfigResponse.headers.get("cache-control"), "no-store");
  const anonymousConfig = await anonymousConfigResponse.json() as { tasks: Array<{ id: string; url: string | null }> };
  assert.equal(anonymousConfig.tasks[0].url, DUST_GENESIS_PROFILE_URL);
  assert.equal(anonymousConfig.tasks[1].url, testUrls.announcement,
    "Markdown-formatted campaign configuration returns the original plain announcement URL");
  const initialProgress = await postTo(anonymousApi, "/progress", {}, undefined, taskCookie);
  assert.deepEqual(initialProgress.data, {
    profileStarted: false,
    profileComplete: false,
    announcementStarted: false,
    announcementComplete: false,
  }, "neither task is initially started or marked complete");
  assert.equal((await postTo(anonymousApi, "/tasks/profile/start", {}, undefined, taskCookie)).status, 200,
    "profile task starts without wallet auth or a signature");
  assert.equal((await postTo(anonymousApi, "/tasks/announcement/start", {}, undefined, taskCookie)).status, 403,
    "announcement stays locked before the profile interval completes");
  now += 5_000;
  assert.equal((await postTo(anonymousApi, "/tasks/profile/start", {}, undefined, taskCookie)).status, 200,
    "reopening the anonymous profile task does not reset its server timestamp");
  now += 4_999;
  let anonymousProgress = await postTo(anonymousApi, "/progress", {}, undefined, taskCookie);
  assert.deepEqual(anonymousProgress.data, {
    profileStarted: true,
    profileComplete: false,
    announcementStarted: false,
    announcementComplete: false,
  }, "anonymous task progress does not complete early");
  now += 1;
  anonymousProgress = await postTo(anonymousApi, "/progress", {}, undefined, taskCookie);
  assert.equal(anonymousProgress.data.profileComplete, true, "anonymous profile task completes at 10 seconds");
  assert.equal((await postTo(anonymousApi, "/tasks/announcement/start", {}, undefined, taskCookie)).status, 200,
    "announcement unlocks after profile completion");
  now += 5_000;
  assert.equal((await postTo(anonymousApi, "/tasks/announcement/start", {}, undefined, taskCookie)).status, 200,
    "reopening the announcement task does not reset its server timestamp");
  const refreshedConfigResponse = await fetch(`${anonymousApi}/config`, { headers: { Cookie: taskCookie } });
  assert.equal(refreshedConfigResponse.headers.get("set-cookie"), null,
    "refreshing the campaign page reuses the existing anonymous task session");
  now += 4_999;
  anonymousProgress = await postTo(anonymousApi, "/progress", {}, undefined, taskCookie);
  assert.equal(anonymousProgress.data.announcementComplete, false,
    "refreshes and repeated clicks cannot complete the announcement early");
  now += 1;
  anonymousProgress = await postTo(anonymousApi, "/progress", {}, undefined, taskCookie);
  assert.equal(anonymousProgress.data.announcementComplete, true);
  const anonymousWalletA = await authenticateAt(anonymousApi, walletA);
  assert.equal((await postTo(anonymousApi, "/tasks/bind", {}, anonymousWalletA.token, taskCookie)).status, 200,
    "completed anonymous tasks bind to the wallet that proves ownership");
  const boundProgress = await postTo(anonymousApi, "/progress", {}, undefined, taskCookie);
  assert.equal(boundProgress.status, 200,
    "refreshing after wallet binding can still read the task progress tied to this session");
  assert.equal(boundProgress.data.profileComplete, true);
  assert.equal(boundProgress.data.announcementComplete, true);
  const anonymousWalletB = await authenticateAt(anonymousApi, walletB);
  assert.equal((await postTo(anonymousApi, "/tasks/bind", {}, anonymousWalletB.token, taskCookie)).status, 403,
    "another wallet cannot reuse a task session already bound to the claimant");
  assert.equal((await postTo(anonymousApi, "/progress", {}, anonymousWalletB.token, taskCookie)).status, 403,
    "a different authenticated wallet cannot read or reuse the bound task progress");

  const missingAnnouncementApi = `http://127.0.0.1:${address.port}/api/dust-genesis-missing-announcement`;
  const missingAnnouncementResponse = await fetch(`${missingAnnouncementApi}/config`);
  const missingAnnouncementCookie = missingAnnouncementResponse.headers.get("set-cookie")?.split(";", 1)[0];
  const missingAnnouncementConfig = await missingAnnouncementResponse.json() as { tasks: Array<{ id: string; url: string | null }> };
  assert.equal(missingAnnouncementConfig.tasks.find((task) => task.id === "announcement")?.url, null);
  assert.equal((await postTo(missingAnnouncementApi, "/tasks/profile/start", {}, undefined, missingAnnouncementCookie)).status, 200);
  missingAnnouncementNow += 10_000;
  const missingAnnouncementProgress = await postTo(missingAnnouncementApi, "/progress", {}, undefined, missingAnnouncementCookie);
  assert.equal(missingAnnouncementProgress.data.profileComplete, true,
    "an unset announcement URL does not block profile completion");
  assert.equal((await postTo(missingAnnouncementApi, "/tasks/announcement/start", {}, undefined, missingAnnouncementCookie)).status, 503,
    "an unset announcement URL only disables that task");

  assert.equal((await postTo(anonymousApi, "/progress", {})).status, 401,
    "progress failures without a task session do not return successful completion");
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
  const authA = await authenticateAt(api, walletA);
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
  assert.deepEqual(progress.data, {
    profileStarted: true,
    profileComplete: false,
    announcementStarted: false,
    announcementComplete: false,
  }, "server delay cannot be bypassed");
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
  assert.deepEqual(progress.data, {
    profileStarted: true,
    profileComplete: true,
    announcementStarted: true,
    announcementComplete: true,
  });

  const authB = await authenticateAt(api, walletB);
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
  anonymousDb.close();
  missingAnnouncementDb.close();
}
