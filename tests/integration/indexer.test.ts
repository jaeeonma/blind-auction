import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { Indexer } from "../../indexer/indexer.js";
import { createTestDb, type TestDb } from "../helpers/db.js";
import {
  auctionTimes,
  createAuction,
  deployContracts,
  eth,
  finalize,
  mineAt,
  placeBid,
  revealBid,
  testProvider,
  type Chain,
} from "../helpers/chain.js";

const wei = (v: string) => eth(v).toString();

describe("Indexer (design.md 9번)", () => {
  let db: TestDb;
  let chain: Chain;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.pool.query("TRUNCATE bids, auctions, indexer_state");
    chain = await deployContracts(inject("rpcUrl")); // fresh contracts per test
  });

  /** A new Indexer object = the Indexer process (re)started. Small batches to exercise several steps. */
  const newIndexer = (batchSize = 3) =>
    new Indexer(chain.provider, db.pool, {
      contractAddress: chain.auctionAddress,
      deployBlock: chain.deployBlock,
      batchSize,
    });

  const auctionRow = async (id: bigint) =>
    (await db.pool.query("SELECT * FROM auctions WHERE auction_id = $1", [id.toString()])).rows[0];
  const bidRows = async (id: bigint) =>
    (
      await db.pool.query(
        "SELECT bidder, commitment, deposit, revealed, value, result FROM bids WHERE auction_id = $1 ORDER BY bidder",
        [id.toString()],
      )
    ).rows;
  const counts = async () =>
    (
      await db.pool.query(
        "SELECT (SELECT count(*) FROM auctions)::int AS auctions, (SELECT count(*) FROM bids)::int AS bids",
      )
    ).rows[0];
  const lower = async (s: { getAddress(): Promise<string> }) => (await s.getAddress()).toLowerCase();

  /** design.md 7번 example: A 5/3, B 4/4, C 2/3 (invalid), D 3 (never revealed). Reveal A → B → C. */
  async function runExampleAuction() {
    const [A, B, C, D] = chain.bidders;
    const auctionId = await createAuction(chain);
    const a = await placeBid(chain, auctionId, A, eth("3"), eth("5"));
    const b = await placeBid(chain, auctionId, B, eth("4"), eth("4"));
    const c = await placeBid(chain, auctionId, C, eth("3"), eth("2"));
    await placeBid(chain, auctionId, D, eth("1"), eth("3"));
    const { biddingEnd, revealEnd } = await auctionTimes(chain, auctionId);
    await mineAt(chain, biddingEnd);
    await revealBid(chain, auctionId, a);
    await revealBid(chain, auctionId, b);
    await revealBid(chain, auctionId, c);
    await mineAt(chain, revealEnd);
    await finalize(chain, auctionId);
    return auctionId;
  }

  async function expectExampleRows(auctionId: bigint) {
    const [A, B, C, D] = chain.bidders;
    expect(await auctionRow(auctionId)).toMatchObject({
      auction_id: auctionId.toString(),
      seller: await lower(chain.seller),
      nft_address: (await chain.nft.getAddress()).toLowerCase(),
      finalized: true,
      winner: await lower(B),
      winning_bid: wei("4"),
      forfeited: wei("3"),
    });
    const rows = await bidRows(auctionId);
    const byBidder = Object.fromEntries(rows.map((r) => [r.bidder, r]));
    expect(byBidder[await lower(A)]).toMatchObject({ deposit: wei("5"), revealed: true, value: wei("3"), result: "lost" });
    expect(byBidder[await lower(B)]).toMatchObject({ deposit: wei("4"), revealed: true, value: wei("4"), result: "won" });
    expect(byBidder[await lower(C)]).toMatchObject({ deposit: wei("2"), revealed: true, value: wei("3"), result: "invalid" });
    expect(byBidder[await lower(D)]).toMatchObject({ deposit: wei("3"), revealed: false, value: null, result: "unrevealed" });
    expect(rows).toHaveLength(4);
  }

  it("copies a whole auction into the DB and the DB matches the contract", async () => {
    const auctionId = await runExampleAuction();

    await newIndexer().syncToHead();
    await expectExampleRows(auctionId);

    // Cross-check with the contract (the source of truth, design.md 3번).
    const onChain = await chain.auction.getFunction("getAuction")(auctionId);
    const row = await auctionRow(auctionId);
    expect(row.bidding_end).toBe(onChain.biddingEnd.toString());
    expect(row.reveal_end).toBe(onChain.revealEnd.toString());
    expect(row.token_id).toBe(onChain.tokenId.toString());
    expect(row.winner).toBe(onChain.highestBidder.toLowerCase());
    for (const r of await bidRows(auctionId)) {
      const b = await chain.auction.getFunction("getBid")(auctionId, r.bidder);
      expect(r.commitment).toBe(b.commitment.toLowerCase());
      expect(r.deposit).toBe(b.deposit.toString());
      expect(r.revealed).toBe(b.revealed);
    }

    // The bookmark is the chain head and its block time (used for status, design.md 10번).
    const head = await chain.provider.getBlock("latest");
    const { rows } = await db.pool.query("SELECT last_block, last_block_time FROM indexer_state");
    expect(rows[0]).toEqual({ last_block: String(head!.number), last_block_time: String(head!.timestamp) });
  });

  it("an auction with no valid bid keeps winner NULL", async () => {
    const auctionId = await createAuction(chain);
    await placeBid(chain, auctionId, chain.bidders[0], eth("1"), eth("1")); // never revealed
    await mineAt(chain, (await auctionTimes(chain, auctionId)).revealEnd);
    await finalize(chain, auctionId);

    await newIndexer().syncToHead();
    expect(await auctionRow(auctionId)).toMatchObject({
      finalized: true,
      winner: null,
      winning_bid: "0",
      forfeited: wei("1"),
    });
    expect((await bidRows(auctionId))[0]).toMatchObject({ result: "unrevealed" });
  });

  it("bids placed while the Indexer was off are all saved after a restart (design.md 14번)", async () => {
    const [A, B, C] = chain.bidders;
    const auctionId = await createAuction(chain);
    await placeBid(chain, auctionId, A, eth("1"), eth("1"));

    await newIndexer().syncToHead();
    expect(await counts()).toEqual({ auctions: 1, bids: 1 });

    // Indexer is off: two more bids arrive.
    await placeBid(chain, auctionId, B, eth("2"), eth("2"));
    await placeBid(chain, auctionId, C, eth("3"), eth("3"));
    expect(await counts()).toEqual({ auctions: 1, bids: 1 });

    // Restart: a new Indexer continues from the bookmark in the DB.
    const restarted = newIndexer();
    const before = await restarted.lastProcessedBlock();
    const saved = await restarted.syncToHead();
    expect(saved).toBe(2); // only the two new events, nothing read twice
    expect(await restarted.lastProcessedBlock()).toBeGreaterThan(before);
    expect(await counts()).toEqual({ auctions: 1, bids: 3 });
  });

  it("reading the same events twice stores them once (design.md 14번)", async () => {
    const auctionId = await runExampleAuction();
    const indexer = newIndexer();
    await indexer.syncToHead();

    // Rewind only the bookmark to read every event a second time on top of the saved rows (design.md 14번).
    // This is a test setup, not the recovery for a wrong DB: that is `npm run indexer:reset` (design.md 9번),
    // which also empties the tables (see system test 3-b).
    await indexer.resetBookmark();
    expect(await indexer.lastProcessedBlock()).toBe(chain.deployBlock - 1);
    await indexer.syncToHead();

    expect(await counts()).toEqual({ auctions: 1, bids: 4 });
    // Results did not regress (e.g. 'won' back to 'valid') on the second pass.
    await expectExampleRows(auctionId);
  });

  it("a DB error mid-batch saves nothing from that batch and keeps the bookmark (design.md 9번)", async () => {
    const [A] = chain.bidders;
    const auctionId = await createAuction(chain);
    await placeBid(chain, auctionId, A, eth("1"), eth("1"));
    const indexer = newIndexer(1000); // one batch holds both AuctionCreated and BidCommitted

    // Make the bid INSERT fail inside the DB, after the auction INSERT already ran in the same transaction.
    await db.pool.query(`
      CREATE FUNCTION fail_bid_insert() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'simulated DB failure'; END $$;
      CREATE TRIGGER fail_bid_insert BEFORE INSERT ON bids FOR EACH ROW EXECUTE FUNCTION fail_bid_insert();
    `);
    try {
      await expect(indexer.syncOnce()).rejects.toThrow("simulated DB failure");
      expect(await counts()).toEqual({ auctions: 0, bids: 0 }); // the auction row was rolled back too
      expect(await indexer.lastProcessedBlock()).toBe(chain.deployBlock - 1); // bookmark unchanged
    } finally {
      await db.pool.query("DROP TRIGGER fail_bid_insert ON bids; DROP FUNCTION fail_bid_insert();");
    }

    // DB is healthy again: the same range is processed and nothing is missing.
    await indexer.syncToHead();
    expect(await counts()).toEqual({ auctions: 1, bids: 1 });
  });

  it("a node outage writes nothing and leaves the bookmark for the retry (design.md 9번)", async () => {
    await createAuction(chain);
    const offline = new Indexer(testProvider("http://127.0.0.1:1"), db.pool, {
      contractAddress: chain.auctionAddress,
      deployBlock: chain.deployBlock,
      batchSize: 1000,
    });

    await expect(offline.syncOnce()).rejects.toThrow();
    expect(await counts()).toEqual({ auctions: 0, bids: 0 });
    expect(await offline.lastProcessedBlock()).toBe(chain.deployBlock - 1);

    // Node reachable again (same DB, same bookmark): catches up.
    await newIndexer().syncToHead();
    expect(await counts()).toEqual({ auctions: 1, bids: 0 });
  });
});
