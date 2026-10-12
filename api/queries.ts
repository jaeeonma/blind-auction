import type { ClientBase, Pool } from "pg";

// Read-only queries for the API (design.md 11번). Response shapes follow design.md 10번:
// amounts and auction ids as decimal strings, addresses lowercase, times as unix seconds.

export const STATUSES = ["bidding", "revealing", "awaiting_finalize", "finalized"] as const;
export type Status = (typeof STATUSES)[number];

/** "진행 중" = not finalized yet, including awaiting_finalize (design.md 11번). */
export const ACTIVE_STATUSES: readonly Status[] = ["bidding", "revealing", "awaiting_finalize"];

/**
 * Status is computed, never stored (design.md 10번). "Now" is the block time of the last block the
 * Indexer processed, not the server clock, and the comparisons are the contract's own (_phase in
 * BlindAuction.sol): Bidding while time < biddingEnd, Reveal while time < revealEnd.
 */
const STATUS_SQL = `
  CASE
    WHEN a.finalized THEN 'finalized'
    WHEN s.last_block_time < a.bidding_end THEN 'bidding'
    WHEN s.last_block_time < a.reveal_end THEN 'revealing'
    ELSE 'awaiting_finalize'
  END`;

export interface AsOf {
  blockNumber: number;
  blockTime: number;
}

export interface AuctionResult {
  /** null when the auction ended without a valid bid. */
  winner: string | null;
  winningBid: string;
  forfeited: string;
}

export interface AuctionSummary {
  auctionId: string;
  seller: string;
  nftAddress: string;
  tokenId: string;
  biddingEnd: number;
  revealEnd: number;
  status: Status;
  /** null until the auction is finalized. */
  result: AuctionResult | null;
}

export interface Bid {
  bidder: string;
  commitment: string;
  deposit: string;
  revealed: boolean;
  /** null until revealed: the bid value is secret before the reveal phase (design.md 8번). */
  value: string | null;
  result: "unrevealed" | "valid" | "invalid" | "won" | "lost";
}

interface AuctionRow {
  auction_id: string;
  seller: string;
  nft_address: string;
  token_id: string;
  bidding_end: string;
  reveal_end: string;
  finalized: boolean;
  winner: string | null;
  winning_bid: string | null;
  forfeited: string | null;
  status: Status;
}

interface BidRow {
  bidder: string;
  commitment: string;
  deposit: string;
  revealed: boolean;
  value: string | null;
  result: Bid["result"];
}

const AUCTION_COLUMNS = `
  a.auction_id, a.seller, a.nft_address, a.token_id, a.bidding_end, a.reveal_end,
  a.finalized, a.winner, a.winning_bid, a.forfeited, ${STATUS_SQL} AS status`;
const BID_COLUMNS = "b.bidder, b.commitment, b.deposit, b.revealed, b.value, b.result";

function toAuction(row: AuctionRow): AuctionSummary {
  return {
    auctionId: row.auction_id,
    seller: row.seller,
    nftAddress: row.nft_address,
    tokenId: row.token_id,
    // BIGINT arrives as a string; unix seconds are far below 2^53, so Number is exact.
    biddingEnd: Number(row.bidding_end),
    revealEnd: Number(row.reveal_end),
    status: row.status,
    result: row.finalized
      ? { winner: row.winner, winningBid: row.winning_bid!, forfeited: row.forfeited! }
      : null,
  };
}

function toBid(row: BidRow): Bid {
  return {
    bidder: row.bidder,
    commitment: row.commitment,
    deposit: row.deposit,
    revealed: row.revealed,
    value: row.value,
    result: row.result,
  };
}

/**
 * Runs `fn` in one read-only snapshot. The Indexer commits events and the bookmark together, so
 * reading asOf, auctions and bids from the same snapshot keeps them consistent with each other
 * even while the Indexer is writing. READ ONLY also makes "조회 전용" hold at the DB level.
 *
 * Returns null when the Indexer has not processed any block yet (no block time → no status).
 */
export async function inSnapshot<T>(
  pool: Pool,
  fn: (client: ClientBase) => Promise<T>,
): Promise<{ asOf: AsOf; data: T } | null> {
  const client = await pool.connect();
  let failed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query<{ last_block: string; last_block_time: string }>(
      "SELECT last_block, last_block_time FROM indexer_state WHERE id = 1",
    );
    const state = rows[0];
    const result = state
      ? {
          asOf: { blockNumber: Number(state.last_block), blockTime: Number(state.last_block_time) },
          data: await fn(client),
        }
      : null;
    await client.query("COMMIT");
    return result;
  } catch (err) {
    failed = true;
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release(failed);
  }
}

/** Auctions, newest first. `statuses` empty = all. */
export async function listAuctions(client: ClientBase, statuses: readonly Status[]): Promise<AuctionSummary[]> {
  const { rows } = await client.query<AuctionRow>(
    `SELECT ${AUCTION_COLUMNS}
     FROM auctions a CROSS JOIN indexer_state s
     WHERE cardinality($1::text[]) = 0 OR ${STATUS_SQL} = ANY($1::text[])
     ORDER BY a.auction_id DESC`,
    [statuses],
  );
  return rows.map(toAuction);
}

/** One auction with its bids, or null if it does not exist. */
export async function getAuction(
  client: ClientBase,
  auctionId: string,
): Promise<(AuctionSummary & { bids: Bid[] }) | null> {
  const { rows } = await client.query<AuctionRow>(
    `SELECT ${AUCTION_COLUMNS} FROM auctions a CROSS JOIN indexer_state s WHERE a.auction_id = $1`,
    [auctionId],
  );
  const row = rows[0];
  if (!row) return null;
  const bids = await client.query<BidRow>(
    `SELECT ${BID_COLUMNS} FROM bids b WHERE b.auction_id = $1 ORDER BY b.bidder`,
    [auctionId],
  );
  return { ...toAuction(row), bids: bids.rows.map(toBid) };
}

/** Auctions `bidder` bid in, newest first, each with that bidder's own bid. */
export async function listUserAuctions(
  client: ClientBase,
  bidder: string,
): Promise<Array<AuctionSummary & { myBid: Bid }>> {
  // Uses bids_bidder_idx (db/schema.sql).
  const { rows } = await client.query<AuctionRow & BidRow>(
    `SELECT ${AUCTION_COLUMNS}, ${BID_COLUMNS}
     FROM bids b
     JOIN auctions a ON a.auction_id = b.auction_id
     CROSS JOIN indexer_state s
     WHERE b.bidder = $1
     ORDER BY a.auction_id DESC`,
    [bidder],
  );
  return rows.map((row) => ({ ...toAuction(row), myBid: toBid(row) }));
}
