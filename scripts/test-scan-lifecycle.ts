import assert from "node:assert/strict";
import { createScanRunGuard, withConsoleTimer } from "../src/scanLifecycle";

async function run() {
  const guard = createScanRunGuard();
  assert.equal(guard.tryAcquire(), true);
  assert.equal(guard.tryAcquire(), false);
  guard.release();
  assert.equal(guard.tryAcquire(), true);
  guard.release();

  const events: string[] = [];
  const timer = { time: (label: string) => events.push(`start:${label}`), timeEnd: (label: string) => events.push(`end:${label}`) };
  await withConsoleTimer("scan", async () => "completed", timer);
  assert.deepEqual(events, ["start:scan", "end:scan"]);

  events.length = 0;
  await assert.rejects(() => withConsoleTimer("scan", async () => { throw new Error("failure"); }, timer));
  assert.deepEqual(events, ["start:scan", "end:scan"]);
  console.log("scan lifecycle tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
