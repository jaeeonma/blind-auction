import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { placeBid, revealFromFile } from "../../scripts/lib/bid";
import { finalizeAuction, withdrawAll } from "../../scripts/lib/settle";
import { auctionCreatedFixture } from "../fixtures";

const eth = (v: string) => ethers.parseEther(v);

describe("scripts: finalize, withdraw (design.md 12번)", function () {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bids-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function expectNoTransaction(signer: { address: string }, fn: () => Promise<unknown>, message: RegExp) {
    const nonce = await ethers.provider.getTransactionCount(signer.address);
    await expect(fn()).to.be.rejectedWith(message);
    expect(await ethers.provider.getTransactionCount(signer.address)).to.equal(nonce);
  }

  /** design.md 7번 example through the script functions, up to the end of the reveal phase. */
  async function exampleRevealed() {
    const f = await auctionCreatedFixture();
    const [A, B, C, D] = [f.alice, f.bob, f.carol, f.other];
    const bid = (who: typeof A, value: string, deposit: string) =>
      placeBid(f.auction.connect(who), who, f.auctionId, eth(value), eth(deposit), dir);
    await bid(A, "3", "5");
    await bid(B, "4", "4");
    await bid(C, "3", "2");
    await bid(D, "1", "3");
    await time.increaseTo(f.biddingEnd);
    for (const who of [A, B, C]) await revealFromFile(f.auction.connect(who), who, f.auctionId, dir);
    return { ...f, A, B, C, D };
  }

  it("finalize (by anyone) reports the winner, price and forfeited deposits", async function () {
    const f = await exampleRevealed();
    await time.increaseTo(f.revealEnd);

    // `other` (D) is not the seller: anyone can finalize (Q8).
    expect(await finalizeAuction(f.auction.connect(f.D), f.auctionId)).to.deep.equal({
      winner: f.B.address,
      winningBid: eth("4"),
      forfeited: eth("3"),
    });
    expect(await f.nft.ownerOf(1n)).to.equal(f.B.address);
  });

  it("finalize with no valid bid reports winner null", async function () {
    const f = await loadFixture(auctionCreatedFixture);
    await time.increaseTo(f.revealEnd);
    expect(await finalizeAuction(f.auction, f.auctionId)).to.deep.equal({ winner: null, winningBid: 0n, forfeited: 0n });
  });

  it("refuses to finalize before the reveal phase ends, twice, or an unknown auction", async function () {
    const f = await loadFixture(auctionCreatedFixture);
    await expectNoTransaction(f.seller, () => finalizeAuction(f.auction, f.auctionId), /경매 0번은 아직 종료할 수 없습니다 \(현재: bidding\)\. 공개 마감: /);
    await time.increaseTo(f.biddingEnd);
    await expectNoTransaction(f.seller, () => finalizeAuction(f.auction, f.auctionId), /현재: revealing/);
    await expectNoTransaction(f.seller, () => finalizeAuction(f.auction, 99n), /경매 99번이 없습니다/);

    await time.increaseTo(f.revealEnd);
    await finalizeAuction(f.auction, f.auctionId);
    await expectNoTransaction(f.seller, () => finalizeAuction(f.auction, f.auctionId), /경매 0번은 이미 종료됐습니다/);
  });

  it("withdraw pays out each ledger: A 5, C 2, seller 7 (design.md 7번)", async function () {
    const f = await exampleRevealed();
    await time.increaseTo(f.revealEnd);
    await finalizeAuction(f.auction, f.auctionId);

    for (const [who, amount] of [
      [f.A, "5"],
      [f.C, "2"],
      [f.seller, "7"],
    ] as const) {
      const before = await ethers.provider.getBalance(who.address);
      const tx = withdrawAll(f.auction.connect(who), who);
      await expect(tx).to.eventually.equal(eth(amount));
      // Balance grew by the amount minus gas; at least amount − 0.01 ETH.
      expect((await ethers.provider.getBalance(who.address)) - before).to.be.greaterThan(eth(amount) - eth("0.01"));
    }
    expect(await ethers.provider.getBalance(await f.auction.getAddress())).to.equal(0n);
  });

  it("refuses to withdraw with an empty ledger, and a second withdraw", async function () {
    const f = await exampleRevealed();
    // B is the current highest bidder: nothing credited before finalize.
    await expectNoTransaction(f.B, () => withdrawAll(f.auction.connect(f.B), f.B), /출금할 금액이 없는 지갑입니다/);

    // A was displaced by B, so A can withdraw already during the reveal phase.
    expect(await withdrawAll(f.auction.connect(f.A), f.A)).to.equal(eth("5"));
    await expectNoTransaction(f.A, () => withdrawAll(f.auction.connect(f.A), f.A), /출금할 금액이 없는 지갑입니다/);
  });
});
