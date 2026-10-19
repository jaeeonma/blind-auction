import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import request from "supertest";
import type { Contract, JsonRpcProvider } from "ethers";
import { attachAuction, testProvider } from "../helpers/chain.js";
import {
  createTempDatabase,
  freePort,
  indexedBlock,
  runScript,
  scriptDirs,
  startService,
  waitFor,
  type Service,
  type TempDatabase,
} from "../helpers/system.js";

// System tests (design.md 14번 통합 테스트). Everything runs as a real process, as in production:
// Hardhat node ← user scripts (Hardhat tasks) | Indexer process → PostgreSQL ← API process.

const STATUS = ["bidding", "revealing", "awaiting_finalize", "finalized"] as const;
const ETH = 10n ** 18n;

describe("system: scripts → chain → Indexer → DB → API (design.md 14번)", { timeout: 240_000 }, () => {
  const rpcUrl = inject("rpcUrl");
  let db: TempDatabase;
  let dirs: ReturnType<typeof scriptDirs>;
  let provider: JsonRpcProvider;
  let auction: Contract;
  let deployment: { blindAuction: string; deployBlock: number };
  let apiUrl: string;
  const services: Service[] = [];

  const script = (task: string, ...args: string[]) => runScript(task, args, dirs);

  /** Starts the Indexer process for the deployed contract. */
  async function startIndexer(batchSize = 3): Promise<Service> {
    const s = await startService(
      "indexer",
      {
        DATABASE_URL: db.url,
        RPC_URL: rpcUrl,
        CHAIN_ID: "31337",
        CONTRACT_ADDRESS: deployment.blindAuction,
        DEPLOY_BLOCK: String(deployment.deployBlock),
        BATCH_SIZE: String(batchSize),
        POLL_INTERVAL_MS: "200",
        RETRY_DELAY_MS: "300",
      },
      "indexer: contract",
    );
    services.push(s);
    return s;
  }

  /** Waits until the Indexer's bookmark reaches the current chain head. */
  async function waitIndexed() {
    const head = await provider.getBlockNumber();
    await waitFor(`the Indexer to reach block ${head}`, async () => (await indexedBlock(db.pool)) >= head, 60_000, () =>
      services.map((s) => `--- ${s.name}\n${s.output()}`).join("\n"),
    );
  }

  const api = () => request(apiUrl);

  beforeEach(async () => {
    db = await createTempDatabase();
    dirs = scriptDirs(rpcUrl);
    provider = testProvider(rpcUrl);

    // A new deployment per test, recorded in the test's own folder (DEPLOYMENTS_DIR).
    await script("deploy");
    deployment = JSON.parse(readFileSync(path.join(dirs.deploymentsDir, "localhost.json"), "utf8"));
    auction = attachAuction(provider, deployment.blindAuction);

    const port = await freePort();
    apiUrl = `http://127.0.0.1:${port}`;
    services.push(await startService("api", { DATABASE_URL: db.url, API_PORT: String(port) }, "api: listening"));
  });

  afterEach(async () => {
    while (services.length) await services.pop()!.kill();
    provider?.destroy();
    await db?.drop();
    dirs?.cleanup();
  });

  /** Value of a bid from its secret file (the contract does not store bid values, design.md 8번). */
  function valueFromSecretFile(auctionId: bigint, bidder: string): string {
    const file = `31337-${deployment.blindAuction.toLowerCase()}-${auctionId}-${bidder.toLowerCase()}.json`;
    return JSON.parse(readFileSync(path.join(dirs.bidsDir, file), "utf8")).value;
  }

  /** Compares GET /auctions/:id with what the contract itself says. */
  async function expectApiMatchesContract(auctionId: bigint) {
    const res = await api().get(`/auctions/${auctionId}`).expect(200);
    const a = res.body.auction;
    const onChain = await auction.getFunction("getAuction")(auctionId);
    const phase = Number(await auction.getFunction("phaseOf")(auctionId));

    expect(res.body.asOf.blockNumber).toBe(await provider.getBlockNumber());
    expect(a).toMatchObject({
      auctionId: auctionId.toString(),
      seller: onChain.seller.toLowerCase(),
      nftAddress: onChain.nft.toLowerCase(),
      tokenId: onChain.tokenId.toString(),
      biddingEnd: Number(onChain.biddingEnd),
      revealEnd: Number(onChain.revealEnd),
      status: STATUS[phase],
    });
    const winner = onChain.highestBidder.toLowerCase();
    if (onChain.finalized) {
      expect(a.result).toEqual({
        winner,
        winningBid: onChain.highestBid.toString(),
        forfeited: (onChain.totalDeposits - onChain.revealedDeposits).toString(),
      });
    } else {
      expect(a.result).toBeNull();
    }

    expect(a.bids).toHaveLength(Number(onChain.bidCount));
    for (const bid of a.bids) {
      const b = await auction.getFunction("getBid")(auctionId, bid.bidder);
      const value = valueFromSecretFile(auctionId, bid.bidder);
      const expectedResult = !b.revealed
        ? "unrevealed"
        : BigInt(b.deposit) < BigInt(value)
          ? "invalid"
          : !onChain.finalized
            ? "valid"
            : bid.bidder === winner
              ? "won"
              : "lost";
      expect(bid).toEqual({
        bidder: bid.bidder,
        commitment: b.commitment.toLowerCase(),
        deposit: b.deposit.toString(),
        revealed: b.revealed,
        value: b.revealed ? value : null,
        result: expectedResult,
      });
    }
    return a;
  }

  it("1. after the full flow, the API answers exactly what the contract holds", async () => {
    await startIndexer();

    // design.md 7번 example through the real demo script.
    const out = await script("demo");
    expect(out).toContain("All checks passed");
    await waitIndexed();

    const a = await expectApiMatchesContract(0n);
    // Spelled out once against design.md 7번, on top of the generic comparison above.
    const [A, B, C, D] = await Promise.all([1, 2, 3, 4].map(async (i) => (await (await provider.getSigner(i)).getAddress()).toLowerCase()));
    expect(a.status).toBe("finalized");
    expect(a.result).toEqual({ winner: B, winningBid: (4n * ETH).toString(), forfeited: (3n * ETH).toString() });
    const results = Object.fromEntries(a.bids.map((b: { bidder: string; result: string }) => [b.bidder, b.result]));
    expect(results).toEqual({ [A!]: "lost", [B!]: "won", [C!]: "invalid", [D!]: "unrevealed" });

    // Each bidder's "participated auctions" (design.md 11번).
    for (const [bidder, result] of Object.entries(results)) {
      const res = await api().get(`/users/${bidder}/auctions`).expect(200);
      expect(res.body.auctions).toHaveLength(1);
      expect(res.body.auctions[0]).toMatchObject({ auctionId: "0", status: "finalized", myBid: { bidder, result } });
    }
    expect((await api().get("/auctions?status=finalized").expect(200)).body.auctions.map((x: { auctionId: string }) => x.auctionId)).toEqual(["0"]);

    // A second auction: its status follows the block time as the scripts move it (design.md 10번).
    const minted = await script("mint-nft");
    const token = /Minted token (\d+)/.exec(minted)![1]!;
    const created = await script("create-auction", "--token", token, "--bidding", "10m", "--reveal", "1d");
    expect(created).toContain("Created auction 1");

    for (const step of [null, "reveal", "end"] as const) {
      if (step) await script("time-travel", "--auction", "1", "--to", step);
      await waitIndexed();
      const live = await expectApiMatchesContract(1n);
      expect(live.status).toBe({ null: "bidding", reveal: "revealing", end: "awaiting_finalize" }[String(step)]);
      // Not finalized yet, so it is "in progress" (awaiting_finalize included, design.md 11번).
      const active = await api().get("/auctions?status=active").expect(200);
      expect(active.body.auctions.map((x: { auctionId: string }) => x.auctionId)).toEqual(["1"]);
    }
  });
});
