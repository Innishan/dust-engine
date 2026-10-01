import assert from "node:assert/strict";
import { runGeminiDiagnostic } from "../server/ambassadorGeminiDiagnostic";

async function main() {
  let receivedKey = "";
  const calls: string[] = [];
  const result = await runGeminiDiagnostic("test-key", "gemini-2.5-flash", (key) => {
    receivedKey = key;
    return { models: {
      get: async ({ model }) => { calls.push(`get:${model}`); return {}; },
      generateContent: async ({ model, contents }) => { calls.push(`generate:${model}:${contents}`); return { text: "OK" }; },
    } };
  });
  assert.equal(receivedKey, "test-key");
  assert.deepEqual(calls, ["get:gemini-2.5-flash", "generate:gemini-2.5-flash:Reply with the single word OK."]);
  assert.equal(result.configured, true);
  assert.equal(result.effectiveModelMatchesExpected, true);
  assert.equal(result.modelAccess.success, true);
  assert.equal(result.generation.success, true);

  const unsafeError = Object.assign(new Error("API_KEY=fake-secret Authorization: Bearer fake-token https://example.test/key response={\"payload\":\"private\"}"), { status: 404, code: "NOT_FOUND" });
  const failed = await runGeminiDiagnostic("test-key", "gemini-2.5-flash", () => ({ models: {
    get: async () => { throw unsafeError; },
    generateContent: async () => { throw unsafeError; },
  } }));
  assert.equal(failed.modelAccess.httpStatus, 404);
  assert.equal(failed.modelAccess.providerCode, "NOT_FOUND");
  assert.equal(failed.generation.diagnosticClass, "provider_api_failure");
  assert.equal(JSON.stringify(failed).includes("fake-secret"), false);
  assert.equal(JSON.stringify(failed).includes("fake-token"), false);
  assert.equal(JSON.stringify(failed).includes("https://"), false);
  assert.equal(JSON.stringify(failed).includes("Authorization"), false);
  assert.equal(JSON.stringify(failed).includes("payload"), false);
  assert.equal(JSON.stringify(failed).includes("private"), false);

  const unconfigured = await runGeminiDiagnostic(undefined, "gemini-2.5-flash", () => { throw new Error("must not construct client"); });
  assert.equal(unconfigured.configured, false);
  assert.equal(unconfigured.modelAccess.category, "configuration");
  console.log("Gemini diagnostic tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
