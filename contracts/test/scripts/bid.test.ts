import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { placeBid, revealFromFile, revertName } from "../../scripts/lib/bid";
import { bidFilePath, readBidFile, type BidKey } from "../../scripts/lib/bid-files";
import { computeCommitment } from "../../scripts/lib/commitment";
import { auctionCreatedFixture } from "../fixtures";

const eth = (v: string) => ethers.parseEther(v);

describe("scripts: bid, reveal with secret files (design.md 12번)", function () {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bids-")); // never the real .bids/
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const keyOf = async (f: { auctionAddress: string; auctionId: bigint }, bidder: { address: string }): Promise<BidKey> => ({
    chainId: 31337,
    contract: f.auctionAddress,
    auctionId: f.auctionId,
    bidder: bidder.address,
  });

  /** Fails if `signer` sends any transaction while `fn` runs. */
  async function expectNoTransaction(signer: { address: string }, fn: () => Promise<unknown>, message: RegExp) {
    const nonce = await ethers.provider.getTransactionCount(signer.address);
    await expect(fn()).to.be.rejectedWith(message);
    expect(await ethers.provider.getTransactionCount(signer.address)).to.equal(nonce);
  }

  describe("revertName (reading custom errors)", function () {
    it("reads the error from the in-process network and from the shape an HTTP node returns", async function () {
      const f = await loadFixture(auctionCreatedFixture);
      // In-process network (what the other tests use).
      const local = await f.auction.getBid(f.auctionId, f.alice.address).catch((e: unknown) => e);
      expect(revertName(f.auction, local)).to.equal("BidNotFound");

      // `npm run node` over HTTP returns a ProviderError with the revert data one level deeper.
      // The in-process network never produces this, so it is built here exactly as observed.
      const selector = f.auction.interface.getError("BidNotFound")!.selector;
      const http = {
        name: "ProviderError",
        code: -32603,
        data: {
          message: "Error: VM Exception while processing transaction: reverted with custom error 'BidNotFound()'",
          data: selector,
        },
      };
      expect(revertName(f.auction, http)).to.equal("BidNotFound");

      expect(revertName(f.auction, new Error("network down"))).to.equal(undefined);
      expect(revertName(f.auction, { data: { data: "0xdeadbeef" } })).to.equal(undefined);
    });
  });

  describe("bid", function () {
    it("saves value + secret to one file per bid and sends the matching hash", async function () {
      const f = await loadFixture(auctionCreatedFixture);
      const auction = f.auction.connect(f.alice);

      const placed = await placeBid(auction, f.alice, f.auctionId, eth("3"), eth("5"), dir);

      const key = await keyOf(f, f.alice);
      expect(placed.file).to.equal(bidFilePath(key, dir));
      const saved = readBidFile(key, dir);
      expect(saved).to.include({
        chainId: 31337,
        contract: f.auctionAddress,
        auctionId: "0",
        bidder: f.alice.address,
        value: eth("3").toString(),
        deposit: eth("5").toString(),
      });
      expect(saved.secret).to.match(/^0x[0-9a-f]{64}$/);
      // The file reproduces the hash on chain, so it can reveal later.
      const onChain = await f.auction.getBid(f.auctionId, f.alice.address);
      expect(computeCommitment(BigInt(saved.value), saved.secret, f.alice.address)).to.equal(onChain.commitment);
      expect(saved.commitment).to.equal(onChain.commitment);
      expect(onChain.deposit).to.equal(eth("5"));
      expect(placed.warnings).to.deep.equal([]);
      expect(placed.replacedFile).to.equal(false);
      // No temp file left behind.
      expect(readdirSync(dir)).to.deep.equal([path.basename(placed.file)]);
    });

    it("writes the file BEFORE sending: a failed send leaves the file, and a retry replaces it with a new secret", async function () {
      const f = await loadFixture(auctionCreatedFixture);
      const auction = f.auction.connect(f.alice);
      const key = await keyOf(f, f.alice);

      // More ETH than the wallet holds → the transaction fails when it is sent.
      await expect(placeBid(auction, f.alice, f.auctionId, eth("1"), eth("1000000"), dir)).to.be.rejected;
      const first = readBidFile(key, dir); // the file was already on disk
      expect((await f.auction.getAuction(f.auctionId)).bidCount).to.equal(0n); // and no bid on chain

      const placed = await placeBid(auction, f.alice, f.auctionId, eth("1"), eth("1"), dir);
      expect(placed.replacedFile).to.equal(true);
      const second = readBidFile(key, dir);
      expect(second.secret).to.not.equal(first.secret); // a new secret for every attempt (design.md 12번)
      expect(second.commitment).to.equal((await f.auction.getBid(f.auctionId, f.alice.address)).commitment);
    });

    it("uses a new random secret for every bid", async function () {
      const f = await loadFixture(auctionCreatedFixture);
      await placeBid(f.auction.connect(f.alice), f.alice, f.auctionId, eth("1"), eth("1"), dir);
      await placeBid(f.auction.connect(f.bob), f.bob, f.auctionId, eth("1"), eth("1"), dir);
      const a = readBidFile(await keyOf(f, f.alice), dir);
      const b = readBidFile(await keyOf(f, f.bob), dir);
      expect(a.secret).to.not.equal(b.secret);
    });

    it("warns but still bids when deposit < value (invalid bid, Q3-1)", async function () {
      const f = await loadFixture(auctionCreatedFixture);
      const placed = await placeBid(f.auction.connect(f.carol), f.carol, f.auctionId, eth("3"), eth("2"), dir);
      expect(placed.warnings).to.have.length(1);
      expect(placed.warnings[0]).to.match(/무효 입찰/);
      expect((await f.auction.getBid(f.auctionId, f.carol.address)).deposit).to.equal(eth("2"));
    });

    it("refuses a second bid without sending and without touching the saved secret", async function () {
      const f = await loadFixture(auctionCreatedFixture);
      const auction = f.auction.connect(f.alice);
      await placeBid(auction, f.alice, f.auctionId, eth("1"), eth("1"), dir);
      const before = readBidFile(await keyOf(f, f.alice), dir);

      await expectNoTransaction(
        f.alice,
        () => placeBid(auction, f.alice, f.auctionId, eth("2"), eth("2"), dir),
        /경매 0번에 이미 입찰한 지갑입니다/,
      );
      expect(readBidFile(await keyOf(f, f.alice), dir)).to.deep.equal(before);
    });

    it("refuses outside the bidding phase and for an unknown auction", async function () {
      const f = await loadFixture(auctionCreatedFixture);
      const auction = f.auction.connect(f.alice);
      await expectNoTransaction(f.alice, () => placeBid(auction, f.alice, 99n, eth("1"), eth("1"), dir), /경매 99번이 없습니다/);
      await time.increaseTo(f.biddingEnd);
      await expectNoTransaction(
        f.alice,
        () => placeBid(auction, f.alice, f.auctionId, eth("1"), eth("1"), dir),
        /경매 0번은 입찰 기간이 아닙니다 \(현재: revealing\)/,
      );
      expect(readdirSync(dir)).to.deep.equal([]); // nothing saved for a refused bid
    });
  });

  describe("reveal", function () {
    async function bidThenRevealPhase() {
      const f = await auctionCreatedFixture();
      await placeBid(f.auction.connect(f.alice), f.alice, f.auctionId, eth("3"), eth("5"), dir);
      await placeBid(f.auction.connect(f.carol), f.carol, f.auctionId, eth("3"), eth("2"), dir); // invalid
      await time.increaseTo(f.biddingEnd);
      return f;
    }

    it("reveals from the file: valid and invalid bids are judged by the contract", async function () {
      const f = await bidThenRevealPhase();

      expect(await revealFromFile(f.auction.connect(f.alice), f.alice, f.auctionId, dir)).to.deep.equal({
        value: eth("3"),
        valid: true,
      });
      expect(await revealFromFile(f.auction.connect(f.carol), f.carol, f.auctionId, dir)).to.deep.equal({
        value: eth("3"),
        valid: false,
      });
      expect((await f.auction.getAuction(f.auctionId)).highestBidder).to.equal(f.alice.address);
      expect(await f.auction.pendingWithdrawals(f.carol.address)).to.equal(eth("2"));
    });

    it("refuses a damaged secret file before sending", async function () {
      const f = await bidThenRevealPhase();
      const file = bidFilePath(await keyOf(f, f.alice), dir);
      const saved = readBidFile(await keyOf(f, f.alice), dir);
      writeFileSync(file, JSON.stringify({ ...saved, secret: "0x" + "00".repeat(32) }));

      await expectNoTransaction(
        f.alice,
        () => revealFromFile(f.auction.connect(f.alice), f.alice, f.auctionId, dir),
        /secret 파일이 체인의 입찰과 맞지 않습니다/,
      );
    });

    it("explains that the deposit is forfeited when the secret file is missing", async function () {
      const f = await bidThenRevealPhase();
      rmSync(bidFilePath(await keyOf(f, f.alice), dir));
      await expectNoTransaction(
        f.alice,
        () => revealFromFile(f.auction.connect(f.alice), f.alice, f.auctionId, dir),
        /secret 파일이 없습니다.*몰수/,
      );
    });

    it("refuses outside the reveal phase, without a bid, and a second reveal", async function () {
      const f = await auctionCreatedFixture();
      await placeBid(f.auction.connect(f.alice), f.alice, f.auctionId, eth("3"), eth("5"), dir);
      const reveal = (who: typeof f.alice) => revealFromFile(f.auction.connect(who), who, f.auctionId, dir);

      await expectNoTransaction(f.alice, () => reveal(f.alice), /경매 0번은 공개 기간이 아닙니다 \(현재: bidding\)/);
      await time.increaseTo(f.biddingEnd);
      await expectNoTransaction(f.bob, () => reveal(f.bob), /경매 0번에 입찰하지 않은 지갑입니다/);
      await reveal(f.alice);
      await expectNoTransaction(f.alice, () => reveal(f.alice), /경매 0번에서 이미 공개한 입찰입니다/);
      await time.increaseTo(f.revealEnd);
      await expectNoTransaction(f.alice, () => reveal(f.alice), /공개 기간이 아닙니다 \(현재: awaiting_finalize\)/);
    });
  });
});
