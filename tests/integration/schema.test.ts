import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseError } from "pg";
import { applySchema } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../helpers/db.js";

// PostgreSQL error codes
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

const UINT256_MAX = (2n ** 256n - 1n).toString();
const SELLER = "0x" + "a".repeat(40);
const NFT = "0x" + "b".repeat(40);
const BIDDER = "0x" + "c".repeat(40);
const HASH = "0x" + "d".repeat(64);

describe("db/schema.sql (design.md 10번)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.pool.query("TRUNCATE bids, auctions, indexer_state");
  });

  const insertAuction = (id = "0", seller = SELLER) =>
    db.pool.query(
      `INSERT INTO auctions (auction_id, seller, nft_address, token_id, bidding_end, reveal_end)
       VALUES ($1, $2, $3, 1, 1000, 2000) ON CONFLICT DO NOTHING`,
      [id, seller, NFT],
    );
  const insertBid = (auctionId = "0", bidder = BIDDER) =>
    db.pool.query(
      `INSERT INTO bids (auction_id, bidder, commitment, deposit)
       VALUES ($1, $2, $3, 5) ON CONFLICT DO NOTHING`,
      [auctionId, bidder, HASH],
    );

  async function expectPgError(promise: Promise<unknown>, code: string) {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as DatabaseError).code).toBe(code);
  }

  it("creates the three tables and is safe to apply again", async () => {
    const client = await db.pool.connect();
    try {
      await applySchema(client); // second run: IF NOT EXISTS → no error
    } finally {
      client.release();
    }
    const { rows } = await db.pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [db.schema],
    );
    expect(rows.map((r) => r.table_name)).toEqual(["auctions", "bids", "indexer_state"]);
  });

  describe("duplicate events are stored once (design.md 9번)", () => {
    it("the same auction twice → one row", async () => {
      await insertAuction();
      const second = await insertAuction();
      expect(second.rowCount).toBe(0);
      const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM auctions");
      expect(rows[0].n).toBe(1);
    });

    it("the same (auction, bidder) twice → one row", async () => {
      await insertAuction();
      await insertBid();
      const second = await insertBid();
      expect(second.rowCount).toBe(0);
      const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM bids");
      expect(rows[0].n).toBe(1);
    });

    it("without ON CONFLICT the primary key rejects the duplicate", async () => {
      await insertAuction();
      await expectPgError(
        db.pool.query(
          `INSERT INTO auctions (auction_id, seller, nft_address, token_id, bidding_end, reveal_end)
           VALUES (0, $1, $2, 1, 1000, 2000)`,
          [SELLER, NFT],
        ),
        UNIQUE_VIOLATION,
      );
    });
  });

  it("stores uint256 values exactly and returns them as strings", async () => {
    await insertAuction(UINT256_MAX);
    await db.pool.query(
      `INSERT INTO bids (auction_id, bidder, commitment, deposit) VALUES ($1, $2, $3, $1)`,
      [UINT256_MAX, BIDDER, HASH],
    );
    const { rows } = await db.pool.query("SELECT auction_id, deposit FROM bids");
    expect(rows[0]).toEqual({ auction_id: UINT256_MAX, deposit: UINT256_MAX });
  });

  describe("constraints", () => {
    it("rejects addresses that are not lowercase 0x + 40 hex", async () => {
      await expectPgError(insertAuction("0", "0x" + "A".repeat(40)), CHECK_VIOLATION);
      await expectPgError(insertAuction("0", "0x1234"), CHECK_VIOLATION);
    });

    it("rejects a bid for an auction that does not exist", async () => {
      await expectPgError(insertBid("7"), FOREIGN_KEY_VIOLATION);
    });

    it("rejects an unknown result value", async () => {
      await insertAuction();
      await insertBid();
      await expectPgError(
        db.pool.query(`UPDATE bids SET revealed = TRUE, value = 3, result = 'winner'`),
        CHECK_VIOLATION,
      );
    });

    it("keeps revealed, value and result consistent", async () => {
      await insertAuction();
      await insertBid();
      // value without revealed
      await expectPgError(db.pool.query(`UPDATE bids SET value = 3`), CHECK_VIOLATION);
      // revealed but still 'unrevealed'
      await expectPgError(db.pool.query(`UPDATE bids SET revealed = TRUE, value = 3`), CHECK_VIOLATION);
      // the valid transition is accepted
      await db.pool.query(`UPDATE bids SET revealed = TRUE, value = 3, result = 'valid'`);
    });

    it("keeps finalized and the result fields consistent", async () => {
      await insertAuction();
      await expectPgError(db.pool.query(`UPDATE auctions SET finalized = TRUE`), CHECK_VIOLATION);
      await expectPgError(db.pool.query(`UPDATE auctions SET winning_bid = 3`), CHECK_VIOLATION);
      // no valid bid: winner stays NULL
      await db.pool.query(`UPDATE auctions SET finalized = TRUE, winning_bid = 0, forfeited = 2`);
    });

    it("allows only one indexer_state row", async () => {
      await db.pool.query(`INSERT INTO indexer_state (last_block, last_block_time) VALUES (10, 1000)`);
      await expectPgError(
        db.pool.query(`INSERT INTO indexer_state (id, last_block, last_block_time) VALUES (2, 11, 1001)`),
        CHECK_VIOLATION,
      );
      await expectPgError(
        db.pool.query(`INSERT INTO indexer_state (last_block, last_block_time) VALUES (11, 1001)`),
        UNIQUE_VIOLATION,
      );
    });
  });
});
