import { setTimeout as sleep } from "node:timers/promises";
import type { Indexer } from "./indexer.js";

export interface RunOptions {
  pollIntervalMs: number;
  retryDelayMs: number;
  signal: AbortSignal;
  log?: (message: string) => void;
}

/**
 * Keeps the DB in step with the chain until `signal` aborts.
 * - Behind the head: process batches back to back.
 * - Caught up: wait pollIntervalMs, then look for new blocks.
 * - Node or DB error: log, wait retryDelayMs, try the same range again (design.md 9번 장애 상황).
 *   Nothing is lost because a failed step never moves the bookmark.
 */
export async function runIndexer(indexer: Indexer, options: RunOptions): Promise<void> {
  const log = options.log ?? console.log;
  const wait = async (ms: number) => {
    await sleep(ms, undefined, { signal: options.signal }).catch(() => {}); // aborted → stop waiting
  };

  while (!options.signal.aborted) {
    try {
      const r = await indexer.syncOnce();
      if (r.range) log(`indexer: blocks ${r.range.from}-${r.range.to}, ${r.events} event(s)`);
      if (r.caughtUp) await wait(options.pollIntervalMs);
    } catch (err) {
      log(`indexer: sync failed, retrying in ${options.retryDelayMs} ms: ${(err as Error).message}`);
      await wait(options.retryDelayMs);
    }
  }
}
