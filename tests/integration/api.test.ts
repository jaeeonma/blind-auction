import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../api/app.js";
import { createTestDb, type TestDb } from "../helpers/db.js";

// The API reads only the DB, so these tests seed rows directly and move indexer_state.last_block_time
// to put auctions into each status. The chain → Indexer → API path is covered in 5단계 (design.md 14번).

const SELLER = "0x" + "a".repeat(40);
const NFT = "0x" + "b".repeat(40);
const ALICE = "0x" + "1".repeat(40);
const BOB = "0x" + "2".repeat(40);
const CAROL = "0x" + "3".repeat(40);
const HASH = "0x" + "d".repeat(64);
const UINT256_MAX = (2n ** 256n - 1n).toString();
const ETH = 10n ** 18n;
const wei = (n: number) => (BigInt(n) * ETH).toString();

describe("API (design.md 11번)", () => {
  let db: TestDb;
  let app: Express;

  beforeAll(async () => {
    db = await createTestDb();
    app = createApp(db.pool);
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.pool.query("TRUNCATE bids, auctions, indexer_state");
  });

  // ── seed helpers ────────────────────────────────────────────────
  const setBlock = (blockNumber: number, blockTime: number) =>
    db.pool.query(
      `INSERT INTO indexer_state (id, last_block, last_block_time) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET last_block = EXCLUDED.last_block, last_block_time = EXCLUDED.last_block_time`,
      [blockNumber, blockTime],
    );
  const addAuction = (id: string | number, biddingEnd = 1000, revealEnd = 2000) =>
    db.pool.query(
      `INSERT INTO auctions (auction_id, seller, nft_address, token_id, bidding_end, reveal_end)
       VALUES ($1, $2, $3, 1, $4, $5)`,
      [String(id), SELLER, NFT, biddingEnd, revealEnd],
    );
  const finalizeAuction = (id: string | number, winner: string | null, winningBid: string, forfeited: string) =>
    db.pool.query(`UPDATE auctions SET finalized = TRUE, winner = $2, winning_bid = $3, forfeited = $4 WHERE auction_id = $1`, [
      String(id),
      winner,
      winningBid,
      forfeited,
    ]);
  const addBid = (
    auctionId: string | number,
    bidder: string,
    deposit: string,
    reveal?: { value: string; result: "valid" | "invalid" | "won" | "lost" },
  ) =>
    db.pool.query(
      `INSERT INTO bids (auction_id, bidder, commitment, deposit, revealed, value, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [String(auctionId), bidder, HASH, deposit, !!reveal, reveal?.value ?? null, reveal?.result ?? "unrevealed"],
    );

  /** design.md 7번 example after finalize: A lost, B won, C invalid, D unrevealed. */
  async function seedExample(id = 0) {
    await addAuction(id);
    await addBid(id, ALICE, wei(5), { value: wei(3), result: "lost" });
    await addBid(id, BOB, wei(4), { value: wei(4), result: "won" });
    await addBid(id, CAROL, wei(2), { value: wei(3), result: "invalid" });
    await addBid(id, "0x" + "4".repeat(40), wei(3));
    await finalizeAuction(id, BOB, wei(4), wei(3));
  }

  const statusOf = async (id: number) => (await request(app).get(`/auctions/${id}`).expect(200)).body.auction.status;

  // ── tests ───────────────────────────────────────────────────────
  it("returns 503 on every route until the Indexer has processed a block", async () => {
    await addAuction(0);
    for (const path of ["/auctions", "/auctions/0", `/users/${ALICE}/auctions`]) {
      const res = await request(app).get(path).expect(503);
      expect(res.body.error).toMatch(/indexer/);
    }
  });

  describe("status is computed from the last block time (design.md 10번)", () => {
    // bidding_end = 1000, reveal_end = 2000. Same comparisons as the contract: time < end.
    const cases: Array<[number, string]> = [
      [999, "bidding"],
      [1000, "revealing"],
      [1999, "revealing"],
      [2000, "awaiting_finalize"],
      [99_999, "awaiting_finalize"],
    ];
    for (const [blockTime, expected] of cases) {
      it(`block time ${blockTime} → ${expected}`, async () => {
        await addAuction(0);
        await setBlock(10, blockTime);
        expect(await statusOf(0)).toBe(expected);
      });
    }

    it("finalized wins over the time-based status", async () => {
      await addAuction(0);
      await finalizeAuction(0, null, "0", "0");
      await setBlock(10, 1500);
      expect(await statusOf(0)).toBe("finalized");
    });

    it("the same auction changes status as the block time moves, without any write to auctions", async () => {
      await addAuction(0);
      await setBlock(10, 500);
      expect(await statusOf(0)).toBe("bidding");
      await setBlock(11, 1500);
      expect(await statusOf(0)).toBe("revealing");
    });
  });

  describe("GET /auctions", () => {
    async function seedOnePerStatus() {
      // block time 1500: auction 0 bidding, 1 revealing, 2 awaiting_finalize, 3 finalized
      await addAuction(0, 2000, 3000);
      await addAuction(1, 1000, 2000);
      await addAuction(2, 500, 1000);
      await addAuction(3, 500, 1000);
      await finalizeAuction(3, null, "0", "0");
      await setBlock(42, 1500);
    }
    const ids = (body: { auctions: Array<{ auctionId: string }> }) => body.auctions.map((a) => a.auctionId);

    it("lists every auction, newest first, with asOf", async () => {
      await seedOnePerStatus();
      const res = await request(app).get("/auctions").expect(200);
      expect(res.body.asOf).toEqual({ blockNumber: 42, blockTime: 1500 });
      expect(ids(res.body)).toEqual(["3", "2", "1", "0"]);
      expect(res.body.auctions.map((a: { status: string }) => a.status)).toEqual([
        "finalized",
        "awaiting_finalize",
        "revealing",
        "bidding",
      ]);
    });

    it("?status=active is bidding + revealing + awaiting_finalize (design.md 11번)", async () => {
      await seedOnePerStatus();
      expect(ids((await request(app).get("/auctions?status=active").expect(200)).body)).toEqual(["2", "1", "0"]);
    });

    it("?status=finalized is only finalized auctions", async () => {
      await seedOnePerStatus();
      expect(ids((await request(app).get("/auctions?status=finalized").expect(200)).body)).toEqual(["3"]);
    });

    it("filters by a single status code", async () => {
      await seedOnePerStatus();
      expect(ids((await request(app).get("/auctions?status=bidding").expect(200)).body)).toEqual(["0"]);
      expect(ids((await request(app).get("/auctions?status=revealing").expect(200)).body)).toEqual(["1"]);
      expect(ids((await request(app).get("/auctions?status=awaiting_finalize").expect(200)).body)).toEqual(["2"]);
    });

    it("orders auction ids numerically, not as text", async () => {
      await addAuction(9);
      await addAuction(10);
      await setBlock(1, 0);
      expect(ids((await request(app).get("/auctions").expect(200)).body)).toEqual(["10", "9"]);
    });

    it("an empty DB gives an empty list", async () => {
      await setBlock(1, 0);
      expect((await request(app).get("/auctions").expect(200)).body.auctions).toEqual([]);
    });

    it("rejects an unknown or repeated status with 400", async () => {
      await setBlock(1, 0);
      await request(app).get("/auctions?status=ended").expect(400);
      await request(app).get("/auctions?status=active&status=finalized").expect(400);
    });

    it("list items have no bids", async () => {
      await seedExample();
      await setBlock(1, 5000);
      expect((await request(app).get("/auctions").expect(200)).body.auctions[0]).not.toHaveProperty("bids");
    });
  });

  describe("GET /auctions/:auctionId", () => {
    it("returns details, status, result and bids (design.md 7번 example)", async () => {
      await seedExample(0);
      await setBlock(42, 5000);

      const res = await request(app).get("/auctions/0").expect(200);
      expect(res.body.asOf).toEqual({ blockNumber: 42, blockTime: 5000 });
      expect(res.body.auction).toEqual({
        auctionId: "0",
        seller: SELLER,
        nftAddress: NFT,
        tokenId: "1",
        biddingEnd: 1000,
        revealEnd: 2000,
        status: "finalized",
        result: { winner: BOB, winningBid: wei(4), forfeited: wei(3) },
        bids: [
          { bidder: ALICE, commitment: HASH, deposit: wei(5), revealed: true, value: wei(3), result: "lost" },
          { bidder: BOB, commitment: HASH, deposit: wei(4), revealed: true, value: wei(4), result: "won" },
          { bidder: CAROL, commitment: HASH, deposit: wei(2), revealed: true, value: wei(3), result: "invalid" },
          { bidder: "0x" + "4".repeat(40), commitment: HASH, deposit: wei(3), revealed: false, value: null, result: "unrevealed" },
        ],
      });
    });

    it("result is null before finalize, and an unrevealed bid has no value", async () => {
      await addAuction(0);
      await addBid(0, ALICE, wei(1));
      await setBlock(1, 500);
      const { auction } = (await request(app).get("/auctions/0").expect(200)).body;
      expect(auction.result).toBeNull();
      expect(auction.bids[0]).toMatchObject({ revealed: false, value: null, result: "unrevealed" });
    });

    it("no valid bid: winner null, winningBid \"0\"", async () => {
      await addAuction(0);
      await finalizeAuction(0, null, "0", wei(1));
      await setBlock(1, 5000);
      const { auction } = (await request(app).get("/auctions/0").expect(200)).body;
      expect(auction.result).toEqual({ winner: null, winningBid: "0", forfeited: wei(1) });
    });

    it("returns uint256 amounts and ids exactly, as strings", async () => {
      await addAuction(UINT256_MAX);
      await addBid(UINT256_MAX, ALICE, UINT256_MAX);
      await setBlock(1, 500);
      const { auction } = (await request(app).get(`/auctions/${UINT256_MAX}`).expect(200)).body;
      expect(auction.auctionId).toBe(UINT256_MAX);
      expect(auction.bids[0].deposit).toBe(UINT256_MAX);
    });

    it("accepts leading zeros in the id", async () => {
      await addAuction(7);
      await setBlock(1, 500);
      expect((await request(app).get("/auctions/007").expect(200)).body.auction.auctionId).toBe("7");
    });

    it("404 for an unknown auction, 400 for a malformed id", async () => {
      await setBlock(1, 500);
      await request(app).get("/auctions/5").expect(404);
      for (const bad of ["abc", "-1", "1.5", "0x10", "9".repeat(79), (2n ** 256n).toString()]) {
        await request(app).get(`/auctions/${bad}`).expect(400);
      }
    });
  });

  describe("GET /users/:address/auctions", () => {
    it("lists the auctions a wallet bid in, newest first, with its own bid", async () => {
      await seedExample(0);
      await addAuction(1, 6000, 7000);
      await addBid(1, ALICE, wei(2));
      await addAuction(2); // alice did not bid
      await setBlock(42, 5000);

      const res = await request(app).get(`/users/${ALICE}/auctions`).expect(200);
      expect(res.body.asOf).toEqual({ blockNumber: 42, blockTime: 5000 });
      expect(res.body.address).toBe(ALICE);
      expect(res.body.auctions.map((a: { auctionId: string }) => a.auctionId)).toEqual(["1", "0"]);
      expect(res.body.auctions[0]).toMatchObject({
        status: "bidding",
        result: null,
        myBid: { bidder: ALICE, deposit: wei(2), revealed: false, value: null, result: "unrevealed" },
      });
      expect(res.body.auctions[1]).toMatchObject({
        status: "finalized",
        result: { winner: BOB },
        myBid: { bidder: ALICE, deposit: wei(5), value: wei(3), result: "lost" },
      });
    });

    it("finds the wallet even when the address is sent in mixed case (design.md 10번)", async () => {
      await seedExample(0);
      await setBlock(1, 5000);
      const mixed = "0x" + "aBcD".repeat(10);
      await addBid(0, mixed.toLowerCase(), wei(1));
      const res = await request(app).get(`/users/${mixed}/auctions`).expect(200);
      expect(res.body.address).toBe(mixed.toLowerCase());
      expect(res.body.auctions).toHaveLength(1);
    });

    it("a wallet with no bids gets an empty list", async () => {
      await seedExample(0);
      await setBlock(1, 5000);
      expect((await request(app).get(`/users/${SELLER}/auctions`).expect(200)).body.auctions).toEqual([]);
    });

    it("400 for a malformed address", async () => {
      await setBlock(1, 0);
      for (const bad of ["alice", "0x1234", "0x" + "g".repeat(40)]) {
        await request(app).get(`/users/${bad}/auctions`).expect(400);
      }
    });
  });

  it("is read-only: unknown routes and write methods get 404", async () => {
    await setBlock(1, 0);
    await request(app).get("/nope").expect(404);
    await request(app).post("/auctions").send({}).expect(404);
    await request(app).delete("/auctions/0").expect(404);
  });

  describe("demo web screens (design.md 17번)", () => {
    it("serves the page, its script and its stylesheet from web/", async () => {
      const page = await request(app).get("/").expect(200).expect("Content-Type", /text\/html/);
      expect(page.text).toContain("<title>Blind Auction 시연</title>");
      expect(page.text).toContain('<script type="module" src="/js/app.js">');
      await request(app).get("/js/app.js").expect(200).expect("Content-Type", /javascript/);
      await request(app).get("/css/style.css").expect(200).expect("Content-Type", /text\/css/);
    });

    it("does not change the API: routes answer JSON as before, files never shadow them", async () => {
      await seedExample(0);
      await setBlock(42, 5000);
      const res = await request(app).get("/auctions").expect(200).expect("Content-Type", /json/);
      expect(res.body.auctions.map((a: { auctionId: string }) => a.auctionId)).toEqual(["0"]);
    });

    it("stays read-only: writing to the page or to a file is refused", async () => {
      await request(app).post("/").send({}).expect(404);
      await request(app).put("/js/app.js").send("x").expect(404);
      await request(app).delete("/index.html").expect(404);
    });

    it("does not serve files outside web/", async () => {
      for (const p of ["/../package.json", "/..%2fpackage.json", "/%2e%2e/.env", "/../api/app.ts"]) {
        const res = await request(app).get(p);
        expect(res.status, p).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain("DATABASE_URL");
        expect(res.text).not.toContain('"name": "blind-auction"');
      }
    });
  });
});
