// npm run indexer — runs the Indexer as its own process, separate from the API (design.md 3번).
import { JsonRpcProvider } from "ethers";
import pg from "pg";
import { loadConfig } from "./config.js";
import { Indexer } from "./indexer.js";
import { runIndexer } from "./run.js";

const config = loadConfig();

// The chain id is given up front and fixed (staticNetwork), so ethers never runs its own
// network-detection retry loop. A node outage then shows up as a plain request error,
// which runIndexer logs and retries (design.md 9번 "노드 연결이 끊김").
const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
const pool = new pg.Pool({ connectionString: config.databaseUrl });
// An idle connection dropping (e.g. PostgreSQL restarted) must not crash the process.
pool.on("error", (err) => console.error(`indexer: idle DB connection error: ${err.message}`));

const indexer = new Indexer(provider, pool, {
  contractAddress: config.contractAddress,
  deployBlock: config.deployBlock,
  batchSize: config.batchSize,
});

// Ctrl+C: stop after the current step. Killing the process at any point is also safe,
// because an unfinished DB transaction is rolled back and the bookmark stays where it was.
const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());

console.log(`indexer: contract ${config.contractAddress}, reading from block ${(await indexer.lastProcessedBlock()) + 1}`);
await runIndexer(indexer, { pollIntervalMs: config.pollIntervalMs, retryDelayMs: config.retryDelayMs, signal: stop.signal });

provider.destroy();
await pool.end();
console.log("indexer: stopped");
