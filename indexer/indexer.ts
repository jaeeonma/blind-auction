import type { JsonRpcProvider } from "ethers";
import type { Pool, PoolClient } from "pg";
import { auctionEvents } from "./events.js";
import { applyEvent } from "./store.js";

export interface SyncResult {
  /** Block range processed in this step, or null when there was no new block. */
  range: { from: number; to: number } | null;
  events: number;
  /** True when the bookmark has reached the chain head. */
  caughtUp: boolean;
}

export interface IndexerOptions {
  contractAddress: string;
  deployBlock: number;
  batchSize: number;
  /**
   * Runs inside each sync transaction right before COMMIT; throwing rolls the step back. main.ts uses it
   * to check that this Indexer still holds the Indexer lock (lock.ts, design.md 9번).
   */
  beforeCommit?: (client: PoolClient) => Promise<void>;
}

/**
 * Copies BlindAuction events into PostgreSQL (design.md 9번).
 *
 * The bookmark (indexer_state.last_block) is the last block whose events are fully saved.
 * Each sync step reads the next block range and saves its events together with the new bookmark
 * in ONE DB transaction, so either both are saved or neither is:
 *   - Indexer stopped or killed mid-step → the transaction rolls back, the bookmark stays,
 *     and the next run reads the same range again.
 *   - The same events read twice → UNIQUE keys and guarded UPDATEs keep one copy (store.ts).
 */
export class Indexer {
  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly pool: Pool,
    private readonly options: IndexerOptions,
  ) {}

  /** Last fully processed block, or deployBlock − 1 when nothing has been processed yet. */
  async lastProcessedBlock(): Promise<number> {
    const { rows } = await this.pool.query<{ last_block: string }>("SELECT last_block FROM indexer_state WHERE id = 1");
    return rows[0] ? Number(rows[0].last_block) : this.options.deployBlock - 1;
  }

  /** Processes at most one batch of blocks after the bookmark. */
  async syncOnce(): Promise<SyncResult> {
    const head = await this.provider.getBlockNumber();
    const from = (await this.lastProcessedBlock()) + 1;
    if (from > head) return { range: null, events: 0, caughtUp: true };
    const to = Math.min(from + this.options.batchSize - 1, head);

    // Read everything from the node BEFORE opening the DB transaction. If the node fails here,
    // nothing has been written and the step is simply retried (design.md 9번 "노드 연결이 끊김").
    const logs = await this.provider.getLogs({ address: this.options.contractAddress, fromBlock: from, toBlock: to });
    const toBlock = await this.provider.getBlock(to);
    if (!toBlock) throw new Error(`Block ${to} not found`);

    // getLogs returns logs in chain order (block, then log index), which is the order the
    // contract emitted them. Order matters: a bid row must exist before its reveal updates it.
    const client = await this.pool.connect();
    let failed = false;
    try {
      await client.query("BEGIN");
      let events = 0;
      for (const log of logs) {
        const event = auctionEvents.parseLog({ topics: [...log.topics], data: log.data });
        if (!event) continue; // not one of the five events
        await applyEvent(client, event);
        events++;
      }
      // The bookmark moves in the same transaction as the events.
      // last_block_time is the "current time" the API uses to compute auction status (design.md 10번).
      await client.query(
        `INSERT INTO indexer_state (id, last_block, last_block_time) VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET last_block = EXCLUDED.last_block, last_block_time = EXCLUDED.last_block_time`,
        [to, toBlock.timestamp],
      );
      await this.options.beforeCommit?.(client);
      await client.query("COMMIT");
      return { range: { from, to }, events, caughtUp: to === head };
    } catch (err) {
      // DB error mid-batch: nothing from this batch is kept, and the bookmark is unchanged
      // (design.md 9번 "DB 연결이 끊김"). ROLLBACK itself may fail if the connection is gone.
      failed = true;
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      // After a failure the connection may be broken, so it is discarded instead of reused.
      client.release(failed);
    }
  }

  /** Runs sync steps until the bookmark reaches the chain head. Returns the number of events saved. */
  async syncToHead(): Promise<number> {
    let total = 0;
    for (;;) {
      const r = await this.syncOnce();
      total += r.events;
      if (r.caughtUp) return total;
    }
  }

  /**
   * Moves only the bookmark back, so the next sync reads every event again from deployBlock on top of
   * the rows already saved. Tests use it to create the "same events read twice" situation
   * (design.md 14번): the UNIQUE keys and guarded UPDATEs must keep exactly one copy.
   *
   * This is NOT the recovery for a wrong DB (design.md 9번 "DB가 블록체인과 다르다고 의심됨"):
   * rows that already exist are skipped, so a wrong value would stay. That recovery is
   * `npm run indexer:reset` (indexer/reset.ts), which empties auctions, bids and the bookmark.
   */
  async resetBookmark(): Promise<void> {
    await this.pool.query("DELETE FROM indexer_state");
  }
}
