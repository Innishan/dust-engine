import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";

const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const otherWallet = privateKeyToAccount("0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd");

async function getPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start");
}

async function startServer(databasePath: string) {
  const port = await getPort();
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), "server.ts"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      PORT: String(port),
      DUST_ENGINE_DATABASE_PATH: databasePath,
      X_CLIENT_ID: "test-client",
      X_CLIENT_SECRET: "test-secret",
      X_REDIRECT_URI: `http://127.0.0.1:${port}/api/auth/x/callback`,
    },
    stdio: "ignore",
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);
  return { child, baseUrl };
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function requestNonce(baseUrl: string, walletAddress = wallet.address) {
  const response = await fetch(`${baseUrl}/api/ambassadors/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress }),
  });
  return { response, body: await response.json() as { nonce?: string; message?: string } };
}

async function activate(baseUrl: string, nonce: string, signature: string, walletAddress = wallet.address) {
  return fetch(`${baseUrl}/api/ambassadors/auth/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress, nonce, signature }),
  });
}

function sessionCookie(response: Response) {
  const value = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(value, "activation must create an Ambassador session cookie");
  return value;
}

async function createOauthState(baseUrl: string, cookie: string) {
  const response = await fetch(`${baseUrl}/api/auth/x/start`, { headers: { cookie }, redirect: "manual" });
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  const state = new URL(location).searchParams.get("state");
  assert.ok(state);
  return state;
}

async function callback(baseUrl: string, state: string, cookie?: string) {
  return fetch(`${baseUrl}/api/auth/x/callback?state=${encodeURIComponent(state)}&error=access_denied`, {
    headers: cookie ? { cookie } : undefined,
    redirect: "manual",
  });
}

function assertStateUnused(databasePath: string, state: string) {
  const database = new Database(databasePath, { readonly: true });
  const record = database.prepare("SELECT used_at FROM ambassador_oauth_states WHERE state = ?").get(state) as { used_at: string | null } | undefined;
  database.close();
  assert.equal(record?.used_at, null, "rejected state must remain unconsumed");
}

const tempDirectory = await mkdtemp(path.join(tmpdir(), "dust-engine-ambassador-test-"));
const databasePath = path.join(tempDirectory, "ambassadors.sqlite");
let running: { child: ChildProcess; baseUrl: string } | null = null;

try {
  running = await startServer(databasePath);
  const firstNonce = await requestNonce(running.baseUrl);
  assert.equal(firstNonce.response.status, 200);
  assert.ok(firstNonce.body.nonce && firstNonce.body.message);
  const firstSignature = await wallet.signMessage({ message: firstNonce.body.message });
  const firstActivation = await activate(running.baseUrl, firstNonce.body.nonce, firstSignature);
  assert.equal(firstActivation.status, 200);
  const firstCookie = sessionCookie(firstActivation);
  const firstProfile = await firstActivation.json() as { profile: { id: string; referralCode: string } };
  assert.match(firstProfile.profile.id, /^amb_/);
  assert.match(firstProfile.profile.referralCode, /^AMB[0-9A-F]+$/);

  const reusedNonce = await activate(running.baseUrl, firstNonce.body.nonce, firstSignature);
  assert.equal(reusedNonce.status, 400, "a nonce must be one-time-use");

  const existingNonce = await requestNonce(running.baseUrl);
  assert.equal(existingNonce.response.status, 200);
  const existingSignature = await wallet.signMessage({ message: existingNonce.body.message! });
  const existingActivation = await activate(running.baseUrl, existingNonce.body.nonce!, existingSignature);
  const differentSessionCookie = sessionCookie(existingActivation);
  const existingProfile = await existingActivation.json() as { profile: { id: string; referralCode: string } };
  assert.equal(existingActivation.status, 200);
  assert.equal(existingProfile.profile.id, firstProfile.profile.id);
  assert.equal(existingProfile.profile.referralCode, firstProfile.profile.referralCode);

  const missingSessionState = await createOauthState(running.baseUrl, firstCookie);
  const missingSessionCallback = await callback(running.baseUrl, missingSessionState);
  assert.equal(missingSessionCallback.headers.get("location"), "/?section=ambassador&x=invalid-state");
  assertStateUnused(databasePath, missingSessionState);

  const mismatchedSessionState = await createOauthState(running.baseUrl, firstCookie);
  const mismatchedSessionCallback = await callback(running.baseUrl, mismatchedSessionState, differentSessionCookie);
  assert.equal(mismatchedSessionCallback.headers.get("location"), "/?section=ambassador&x=invalid-state");
  assertStateUnused(databasePath, mismatchedSessionState);

  const validSessionState = await createOauthState(running.baseUrl, firstCookie);
  const validSessionCallback = await callback(running.baseUrl, validSessionState, firstCookie);
  assert.equal(validSessionCallback.headers.get("location"), "/?section=ambassador&x=cancelled", "the valid originating session must pass state validation");
  const replayedCallback = await callback(running.baseUrl, validSessionState, firstCookie);
  assert.equal(replayedCallback.headers.get("location"), "/?section=ambassador&x=invalid-state", "a consumed OAuth state must not replay");

  const invalidNonce = await requestNonce(running.baseUrl);
  const invalidSignature = await otherWallet.signMessage({ message: invalidNonce.body.message! });
  assert.equal((await activate(running.baseUrl, invalidNonce.body.nonce!, invalidSignature)).status, 401, "wrong wallet signature must be rejected");

  const arbitraryNonce = await requestNonce(running.baseUrl, otherWallet.address);
  const arbitrarySignature = await wallet.signMessage({ message: arbitraryNonce.body.message! });
  assert.equal((await activate(running.baseUrl, arbitraryNonce.body.nonce!, arbitrarySignature, otherWallet.address)).status, 401, "an arbitrary wallet cannot be authenticated");

  await stopServer(running.child);
  running = null;
  const database = new Database(databasePath);
  database.prepare("UPDATE ambassadors SET status = 'revoked' WHERE id = ?").run(firstProfile.profile.id);
  database.close();
  running = await startServer(databasePath);
  assert.equal((await requestNonce(running.baseUrl)).response.status, 403, "revoked wallets must remain blocked");
  console.log("Ambassador registration tests passed");
} finally {
  if (running) await stopServer(running.child);
  await rm(tempDirectory, { recursive: true, force: true });
}
