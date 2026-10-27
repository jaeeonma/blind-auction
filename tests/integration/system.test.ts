import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, inject, it } from "vitest";
import request from "supertest";
import type { Contract, JsonRpcProvider } from "ethers";
import { lockHolder, tryLock } from "../../indexer/lock.js";
import { attachAuction, testProvider } from "../helpers/chain.js";
import {
  createTempDatabase,
  freePort,
  indexedBlock,
  runBackendScript,
  runScript,
  runServiceUntilExit,
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

  /** Indexer environment for the deployed contract (`overrides` replaces single settings). */
  const indexerEnv = (batchSize = 3, overrides: Record<string, string> = {}) => ({
    DATABASE_URL: db.url,
    RPC_URL: rpcUrl,
    CHAIN_ID: "31337",
    CONTRACT_ADDRESS: deployment.blindAuction,
    DEPLOY_BLOCK: String(deployment.deployBlock),
    BATCH_SIZE: String(batchSize),
    POLL_INTERVAL_MS: "200",
    RETRY_DELAY_MS: "300",
    ...overrides,
  });

  /** Starts the Indexer process for the deployed contract. */
  async function startIndexer(batchSize = 3): Promise<Service> {
    const s = await startService("indexer", indexerEnv(batchSize), "indexer: contract");
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
    expect(out).toContain("모든 검사 통과");
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
    const token = /토큰 (\d+)번 발행/.exec(minted)![1]!;
    const created = await script("create-auction", "--token", token, "--bidding", "10m", "--reveal", "1d");
    expect(created).toContain("경매 1번 생성");

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

  const countRows = async () =>
    (
      await db.pool.query(
        "SELECT (SELECT count(*) FROM auctions)::int AS auctions, (SELECT count(*) FROM bids)::int AS bids",
      )
    ).rows[0];

  it("2-a. bids placed while the Indexer process is down are all saved after it restarts", async () => {
    let indexer = await startIndexer();
    const token = /토큰 (\d+)번 발행/.exec(await script("mint-nft"))![1]!;
    await script("create-auction", "--token", token, "--bidding", "10m", "--reveal", "1d");
    await script("bid", "--auction", "0", "--value", "3", "--deposit", "5", "--account", "1");
    await waitIndexed();
    expect((await api().get("/auctions/0").expect(200)).body.auction.bids).toHaveLength(1);

    // The Indexer crashes (hard kill, no clean shutdown).
    await indexer.kill();
    const bookmark = await indexedBlock(db.pool);

    // B, C and D bid while it is down.
    for (const [account, value, deposit] of [
      ["2", "4", "4"],
      ["3", "3", "2"],
      ["4", "1", "3"],
    ] as const) {
      await script("bid", "--auction", "0", "--value", value, "--deposit", deposit, "--account", account);
    }
    expect(await provider.getBlockNumber()).toBeGreaterThan(bookmark);

    // The API is a separate process and keeps answering from the DB (design.md 3번).
    // asOf shows the data is from the last block the Indexer saved.
    const stale = await api().get("/auctions/0").expect(200);
    expect(stale.body.auction.bids).toHaveLength(1);
    expect(stale.body.asOf.blockNumber).toBe(bookmark);

    // Restart: it continues right after its bookmark (design.md 9번), not from the deploy block.
    indexer = await startIndexer();
    expect(indexer.output()).toContain(`reading from block ${bookmark + 1}`);
    await waitIndexed();

    expect(await countRows()).toEqual({ auctions: 1, bids: 4 }); // nothing missing, nothing twice
    await expectApiMatchesContract(0n);
  });

  it("2-b. killing the Indexer again and again while it catches up loses and duplicates nothing", async () => {
    // A backlog built while no Indexer runs: three demo runs, about 16 blocks each.
    for (let i = 0; i < 3; i++) expect(await script("demo")).toContain("모든 검사 통과");
    const head = await provider.getBlockNumber();
    expect(head - deployment.deployBlock).toBeGreaterThanOrEqual(30);

    // BATCH_SIZE 1: one DB transaction per block, so there are many points to die between (and inside).
    let killedMidway = 0;
    for (let round = 0; round < 8 && (await indexedBlock(db.pool)) < head; round++) {
      const from = await indexedBlock(db.pool);
      const indexer = await startIndexer(1);
      // Kill it as soon as it has committed at least one more block.
      await waitFor("the Indexer to make progress", async () => (await indexedBlock(db.pool)) > from, 30_000, undefined, 10);
      await indexer.kill();
      if ((await indexedBlock(db.pool)) < head) killedMidway++;
    }
    console.log(`2-b: killed the Indexer ${killedMidway} time(s) while it was catching up (${head - deployment.deployBlock} blocks)`);
    expect(killedMidway).toBeGreaterThanOrEqual(2);

    // Last restart, left running to the end.
    await startIndexer(1);
    await waitIndexed();

    expect(await countRows()).toEqual({ auctions: 3, bids: 12 });
    for (const id of [0n, 1n, 2n]) await expectApiMatchesContract(id);
  });

  /** Every row of the DB copy, in a fixed order. */
  const snapshot = async () => ({
    auctions: (await db.pool.query("SELECT * FROM auctions ORDER BY auction_id")).rows,
    bids: (await db.pool.query("SELECT * FROM bids ORDER BY auction_id, bidder")).rows,
  });

  it("3. reading the same events twice stores them once (design.md 14번)", async () => {
    let indexer = await startIndexer();
    expect(await script("demo")).toContain("모든 검사 통과");
    await waitIndexed();
    const before = await snapshot();
    expect(before.bids).toHaveLength(4);

    // Rewind only the bookmark: every event is read a second time on top of the rows already saved.
    await indexer.kill();
    await db.pool.query("DELETE FROM indexer_state");
    indexer = await startIndexer();
    expect(indexer.output()).toContain(`reading from block ${deployment.deployBlock}`);
    await waitIndexed();

    // UNIQUE keys and the guarded UPDATEs (store.ts) keep exactly one copy, with the same values:
    // e.g. 'won'/'lost' did not fall back to 'valid' when the reveal events were read again.
    expect(await snapshot()).toEqual(before);
    await expectApiMatchesContract(0n);
  });

  it("3-b. npm run indexer:reset rebuilds a DB copy that holds wrong rows (design.md 9번)", async () => {
    let indexer = await startIndexer();
    expect(await script("demo")).toContain("모든 검사 통과");
    await waitIndexed();
    const good = await snapshot();
    await indexer.kill();

    // Damage the copy: one bid gets a wrong deposit, another bid row disappears.
    const [first, second] = good.bids as Array<{ bidder: string }>;
    await db.pool.query("UPDATE bids SET deposit = 1 WHERE auction_id = 0 AND bidder = $1", [first!.bidder]);
    await db.pool.query("DELETE FROM bids WHERE auction_id = 0 AND bidder = $1", [second!.bidder]);

    // Why the reset empties the tables: rewinding only the bookmark brings the missing row back,
    // but the wrong row is skipped (it already exists) and keeps its wrong value.
    await db.pool.query("DELETE FROM indexer_state");
    indexer = await startIndexer();
    await waitIndexed();
    await indexer.kill();
    const rewound = await snapshot();
    expect(rewound.bids).toHaveLength(4);
    expect((rewound.bids as Array<{ bidder: string; deposit: string }>).find((b) => b.bidder === first!.bidder)!.deposit).toBe("1");

    // The recovery command, run as a real process.
    const out = await runBackendScript("indexer/reset.ts", { DATABASE_URL: db.url });
    expect(out).toContain("removed 1 auction(s), 4 bid(s) and the bookmark");
    expect(await countRows()).toEqual({ auctions: 0, bids: 0 });

    await startIndexer();
    await waitIndexed();
    expect(await snapshot()).toEqual(good); // rebuilt exactly from the chain
    await expectApiMatchesContract(0n);
  });

  it("4. an Indexer with a wrong DEPLOY_BLOCK stops with what to do instead of retrying forever (design.md 9번)", async () => {
    const token = /토큰 (\d+)번 발행/.exec(await script("mint-nft"))![1]!;
    await script("create-auction", "--token", token, "--bidding", "10m", "--reveal", "1d");
    const createdAt = await provider.getBlockNumber(); // the AuctionCreated block
    await script("bid", "--auction", "0", "--value", "1", "--deposit", "1", "--account", "1");

    // DEPLOY_BLOCK just after the auction was created: AuctionCreated would be skipped and the bid
    // could never be saved (foreign key). Before the startup check this retried forever.
    const r = await runServiceUntilExit("indexer", indexerEnv(3, { DEPLOY_BLOCK: String(createdAt + 1) }));
    expect(r.code).toBe(1); // exited by itself, not killed after the timeout
    expect(r.output).toContain("시작 확인 실패");
    expect(r.output).toContain("DEPLOY_BLOCK이 실제 배포 블록보다 뒤에 있어서 그 사이의 이벤트(경매 생성 등)를 놓칩니다");
    expect(r.output).toContain(`DEPLOY_BLOCK: ${createdAt + 1}, 실제 배포 블록: ${deployment.deployBlock}`);
    expect(await countRows()).toEqual({ auctions: 0, bids: 0 }); // nothing was written

    // With the DEPLOY_BLOCK it suggested, the Indexer starts and saves everything.
    await startIndexer();
    await waitIndexed();
    expect(await countRows()).toEqual({ auctions: 1, bids: 1 });
  });

  // ── only one Indexer per database (design.md 9번 "Indexer가 두 개 켜짐") ──

  /** PostgreSQL pid of the Indexer's lock connection, from its startup line. */
  const lockPid = (s: Service) => Number(/Indexer lock: PostgreSQL pid (\d+)/.exec(s.output())![1]);
  /** Waits until nobody holds the Indexer lock (PostgreSQL releases it when the connection closes). */
  const waitLockFree = () =>
    waitFor("the Indexer lock to be released", async () => (await lockHolder(db.pool)) === null, 30_000);

  it("5-a. a second Indexer stops with what to do (exit 1); once the first is stopped it can start", async () => {
    const first = await startIndexer();
    const pid = lockPid(first);
    expect(await lockHolder(db.pool)).toBe(pid);

    const second = await runServiceUntilExit("indexer", indexerEnv());
    expect(second.code).toBe(1); // exited by itself, not killed after the timeout
    expect(second.output).toContain("시작 확인 실패");
    expect(second.output).toContain("Indexer가 이미 실행 중입니다");
    expect(second.output).toContain("할 일: 다른 터미널의 Indexer를 끄고 다시 실행하세요");
    expect(second.output).toContain(`잠금을 가진 PostgreSQL 연결(pid): ${pid}`);
    expect(second.output).not.toContain("indexer: contract"); // never started indexing

    // Hard kill (a crash): PostgreSQL drops the connection and with it the lock. No stale lock remains.
    await first.kill();
    await waitLockFree();
    await startIndexer();
    expect(await script("demo")).toContain("모든 검사 통과");
    await waitIndexed();
    expect(await countRows()).toEqual({ auctions: 1, bids: 4 });
  });

  it("5-c. lock connection dropped: the Indexer takes the lock again, or stops if another one took it", async () => {
    const indexer = await startIndexer();
    const admin = await db.pool.connect();
    try {
      // (1) The lock connection is cut (like a DB restart or a network drop) and nobody else wants the
      // lock: the Indexer takes it again on its next step and keeps indexing.
      await admin.query("SELECT pg_terminate_backend($1, 5000)", [lockPid(indexer)]);
      await waitFor("the Indexer to take the lock again", async () => indexer.output().includes("took the Indexer lock again"), 30_000, () => indexer.output());
      const newPid = Number(/took the Indexer lock again \(PostgreSQL pid (\d+)\)/.exec(indexer.output())![1]);
      expect(await lockHolder(db.pool)).toBe(newPid);
      expect(await script("demo")).toContain("모든 검사 통과");
      await waitIndexed();
      expect(await countRows()).toEqual({ auctions: 1, bids: 4 });

      // (2) Cut again, and this time another session takes the lock first (pg_terminate_backend waits
      // for the connection to end, so the next statement runs before the Indexer can reconnect).
      await admin.query("SELECT pg_terminate_backend($1, 5000)", [newPid]);
      expect(await tryLock(admin)).toBe(true);
      expect(await indexer.exited).toBe(1);
      expect(indexer.output()).toContain("다른 Indexer(또는 indexer:reset)가 잠금을 가져갔습니다. 이 Indexer는 멈춥니다");
      expect(indexer.output()).toContain(`잠금을 가진 PostgreSQL 연결(pid): ${(await admin.query("SELECT pg_backend_pid() AS pid")).rows[0].pid}`);
    } finally {
      admin.release(true); // closing the connection also releases the test's lock
    }
  });
});
