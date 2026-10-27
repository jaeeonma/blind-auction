// npm run indexer — runs the Indexer as its own process, separate from the API (design.md 3번).
import { setTimeout as sleep } from "node:timers/promises";
import { JsonRpcProvider } from "ethers";
import pg from "pg";
import { loadConfig } from "./config.js";
import { Indexer } from "./indexer.js";
import { IndexerAlreadyRunning, IndexerLock, IndexerLockTaken } from "./lock.js";
import { runIndexer } from "./run.js";
import { runStartupChecks, StartupCheckFailed } from "./startup.js";

const config = loadConfig();

// The chain id is given up front and fixed (staticNetwork), so ethers never runs its own
// network-detection retry loop. A node outage then shows up as a plain request error,
// which runIndexer logs and retries (design.md 9번 "노드 연결이 끊김").
const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
const pool = new pg.Pool({ connectionString: config.databaseUrl });
// An idle connection dropping (e.g. PostgreSQL restarted) must not crash the process.
pool.on("error", (err) => console.error(`indexer: idle DB connection error: ${err.message}`));

// Ctrl+C: stop after the current step. Killing the process at any point is also safe,
// because an unfinished DB transaction is rolled back and the bookmark stays where it was.
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

let lock: IndexerLock | null = null;
const shutdown = async () => {
  provider.destroy();
  await lock?.release();
  await pool.end();
};

/** Stops with a message for a person, like a failed startup check (exit 1, no retry). */
const fail = async (message: string): Promise<never> => {
  console.error(`indexer: 시작 확인 실패. Indexer를 멈춥니다.\n${message}`);
  await shutdown();
  process.exit(1);
};

// 1. Only one Indexer per database (design.md 9번 "Indexer가 두 개 켜짐"). Taken before anything else
//    and held until the process ends. A DB that is not up yet is retried like the startup checks.
while (!lock) {
  if (stop.signal.aborted) {
    await shutdown();
    process.exit(0);
  }
  try {
    lock = await IndexerLock.acquire(config.databaseUrl);
  } catch (err) {
    if (err instanceof IndexerAlreadyRunning) await fail(err.message);
    console.log(`indexer: could not reach the DB to take the Indexer lock, retrying in ${config.retryDelayMs} ms: ${(err as Error).message}`);
    await sleep(config.retryDelayMs, undefined, { signal: stop.signal }).catch(() => {});
  }
}
const heldLock = lock;

const indexer = new Indexer(provider, pool, {
  contractAddress: config.contractAddress,
  deployBlock: config.deployBlock,
  batchSize: config.batchSize,
  beforeCommit: (client) => heldLock.assertOwner(client),
});

// 2. Startup checks (design.md 9번): a wrong CONTRACT_ADDRESS / DEPLOY_BLOCK / bookmark stops the Indexer
//    here with what to do, instead of retrying the same failure forever.
try {
  const report = await runStartupChecks(provider, pool, {
    contractAddress: config.contractAddress,
    deployBlock: config.deployBlock,
    retryDelayMs: config.retryDelayMs,
    signal: stop.signal,
  });
  if (!report) {
    await shutdown();
    process.exit(0); // Ctrl+C during the checks
  }
  for (const warning of report.warnings) console.log(`indexer: 경고: ${warning}`);
} catch (err) {
  if (!(err instanceof StartupCheckFailed)) throw err;
  await fail(err.message);
}

console.log(
  `indexer: contract ${config.contractAddress}, reading from block ${(await indexer.lastProcessedBlock()) + 1} ` +
    `(Indexer lock: PostgreSQL pid ${heldLock.pid})`,
);
try {
  await runIndexer(indexer, {
    pollIntervalMs: config.pollIntervalMs,
    retryDelayMs: config.retryDelayMs,
    signal: stop.signal,
    // The lock connection may have dropped: take the lock again, or stop if another Indexer has it.
    beforeStep: () => heldLock.ensureHeld(),
    isFatal: (err) => err instanceof IndexerLockTaken,
  });
} catch (err) {
  if (!(err instanceof IndexerLockTaken)) throw err;
  console.error(`indexer: Indexer를 멈춥니다.\n${err.message}`);
  await shutdown();
  process.exit(1);
}

await shutdown();
console.log("indexer: stopped");
