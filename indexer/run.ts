import { setTimeout as sleep } from "node:timers/promises";
import type { Indexer } from "./indexer.js";

export interface RunOptions {
  pollIntervalMs: number;
  retryDelayMs: number;
  signal: AbortSignal;
  log?: (message: string) => void;
  /** Runs before every sync step (main.ts: make sure the Indexer lock is still held, lock.ts). */
  beforeStep?: () => Promise<void>;
  /** Errors that stop the loop instead of being retried (e.g. another Indexer took the lock). */
  isFatal?: (err: unknown) => boolean;
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
      await options.beforeStep?.();
      const r = await indexer.syncOnce();
      if (r.range) log(`indexer: blocks ${r.range.from}-${r.range.to}, ${r.events} event(s)`);
      if (r.caughtUp) await wait(options.pollIntervalMs);
    } catch (err) {
      if (options.isFatal?.(err)) throw err;
      log(`indexer: sync failed, retrying in ${options.retryDelayMs} ms: ${(err as Error).message}`);
      await wait(options.retryDelayMs);
    }
  }
}
