import { requireEnv } from "../db/env.js";

export interface IndexerConfig {
  databaseUrl: string;
  rpcUrl: string;
  /** Chain id of the node (Hardhat: 31337). Given up front so ethers never has to detect the network. */
  chainId: number;
  contractAddress: string;
  /** Block the contract was deployed in. Reading starts here when there is no bookmark yet. */
  deployBlock: number;
  /** Max blocks per getLogs request (and per DB transaction). */
  batchSize: number;
  /** Wait between polls once caught up with the chain head. */
  pollIntervalMs: number;
  /** Wait before retrying after the node or the DB failed (design.md 9번 장애 상황). */
  retryDelayMs: number;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function loadConfig(): IndexerConfig {
  const batchSize = intEnv("BATCH_SIZE", 1000);
  if (batchSize < 1) throw new Error("BATCH_SIZE must be at least 1");
  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    rpcUrl: requireEnv("RPC_URL"),
    chainId: intEnv("CHAIN_ID", 31337),
    contractAddress: requireEnv("CONTRACT_ADDRESS"),
    deployBlock: intEnv("DEPLOY_BLOCK", 0),
    batchSize,
    pollIntervalMs: intEnv("POLL_INTERVAL_MS", 2000),
    retryDelayMs: intEnv("RETRY_DELAY_MS", 5000),
  };
}
