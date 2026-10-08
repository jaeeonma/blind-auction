import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { Phase, auctionCreatedFixture, placeBid, revealBid } from "./fixtures";

const eth = (v: string) => ethers.parseEther(v);

describe("BlindAuction: finalize", function () {
  /** alice wins (3 of 5), bob loses (2 of 2), carol never reveals (4 forfeited). */
  async function revealedFixture() {
    const f = await auctionCreatedFixture();
    const aliceBid = await placeBid(f.auction, f.auctionId, f.alice, eth("3"), eth("5"));
    const bobBid = await placeBid(f.auction, f.auctionId, f.bob, eth("2"), eth("2"));
    await placeBid(f.auction, f.auctionId, f.carol, eth("1"), eth("4"));
    await time.increaseTo(f.biddingEnd);
    await revealBid(f.auction, f.auctionId, aliceBid);
    await revealBid(f.auction, f.auctionId, bobBid);
    return f;
  }

  it("anyone can finalize after revealEnd: NFT to the winner, winner and seller credited", async function () {
    const { nft, auction, auctionId, seller, alice, bob, other, revealEnd } = await loadFixture(revealedFixture);
    await time.increaseTo(revealEnd);

    // `other` is neither the seller nor a bidder (design.md 4번 Q8).
    const tx = auction.connect(other).finalize(auctionId);
    await expect(tx).to.emit(auction, "AuctionFinalized").withArgs(auctionId, alice.address, eth("3"), eth("4"));
    // finalize only writes to the ledger; ETH leaves only through withdraw (Pull payment).
    await expect(tx).to.changeEtherBalances([auction, seller, alice], [0n, 0n, 0n]);

    expect(await nft.ownerOf(1n)).to.equal(alice.address);
    expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("2")); // deposit 5 − price 3
    expect(await auction.pendingWithdrawals(bob.address)).to.equal(eth("2")); // credited at reveal
    expect(await auction.pendingWithdrawals(seller.address)).to.equal(eth("7")); // price 3 + forfeited 4
    expect(await auction.phaseOf(auctionId)).to.equal(Phase.Finalized);
    expect((await auction.getAuction(auctionId)).finalized).to.equal(true);
  });

  it("after finalize the ledger holds every deposit exactly", async function () {
    const { auction, auctionId, seller, alice, bob, carol, revealEnd } = await loadFixture(revealedFixture);
    await time.increaseTo(revealEnd);
    await auction.finalize(auctionId);

    let ledger = 0n;
    for (const acc of [seller, alice, bob, carol]) ledger += await auction.pendingWithdrawals(acc.address);
    expect(ledger).to.equal(eth("11")); // 5 + 2 + 4
    expect(ledger).to.equal(await ethers.provider.getBalance(await auction.getAddress()));
  });

  it("reverts with InvalidPhase before revealEnd", async function () {
    const { auction, auctionId, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);

    await expect(auction.finalize(auctionId)).to.be.revertedWithCustomError(auction, "InvalidPhase");
    await time.increaseTo(biddingEnd);
    await expect(auction.finalize(auctionId)).to.be.revertedWithCustomError(auction, "InvalidPhase");
    await time.setNextBlockTimestamp(revealEnd - 1n);
    await expect(auction.finalize(auctionId)).to.be.revertedWithCustomError(auction, "InvalidPhase");
  });

  it("reverts with InvalidPhase on a second finalize, and the ledger is not credited twice", async function () {
    const { auction, auctionId, seller, alice, revealEnd } = await loadFixture(revealedFixture);
    await time.increaseTo(revealEnd);
    await auction.finalize(auctionId);

    await expect(auction.finalize(auctionId)).to.be.revertedWithCustomError(auction, "InvalidPhase");
    expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("2"));
    expect(await auction.pendingWithdrawals(seller.address)).to.equal(eth("7"));
  });

  it("reverts with AuctionNotFound for an unknown auction", async function () {
    const { auction } = await loadFixture(auctionCreatedFixture);
    await expect(auction.finalize(99n)).to.be.revertedWithCustomError(auction, "AuctionNotFound");
  });

  describe("no valid bid (design.md 4번 Q7)", function () {
    it("no bids at all → NFT back to the seller, nothing credited", async function () {
      const { nft, auction, auctionId, seller, revealEnd } = await loadFixture(auctionCreatedFixture);
      await time.increaseTo(revealEnd);

      await expect(auction.finalize(auctionId))
        .to.emit(auction, "AuctionFinalized")
        .withArgs(auctionId, ethers.ZeroAddress, 0n, 0n);
      expect(await nft.ownerOf(1n)).to.equal(seller.address);
      expect(await auction.pendingWithdrawals(seller.address)).to.equal(0n);
      expect(await auction.phaseOf(auctionId)).to.equal(Phase.Finalized);
    });

    it("only invalid and unrevealed bids → NFT back to the seller, seller gets the forfeited deposits only", async function () {
      const { nft, auction, auctionId, seller, alice, bob, biddingEnd, revealEnd } =
        await loadFixture(auctionCreatedFixture);
      const invalid = await placeBid(auction, auctionId, alice, eth("3"), eth("2")); // deposit < value
      await placeBid(auction, auctionId, bob, eth("1"), eth("1")); // never revealed
      await time.increaseTo(biddingEnd);
      await revealBid(auction, auctionId, invalid);
      await time.increaseTo(revealEnd);

      await expect(auction.finalize(auctionId))
        .to.emit(auction, "AuctionFinalized")
        .withArgs(auctionId, ethers.ZeroAddress, 0n, eth("1"));
      expect(await nft.ownerOf(1n)).to.equal(seller.address);
      expect(await auction.pendingWithdrawals(seller.address)).to.equal(eth("1"));
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("2"));
    });
  });

  it("a winning bid of 0 → NFT to the winner, full deposit back, seller gets 0", async function () {
    const { nft, auction, auctionId, seller, alice, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);
    const s = await placeBid(auction, auctionId, alice, 0n, eth("1"));
    await time.increaseTo(biddingEnd);
    await revealBid(auction, auctionId, s);
    await time.increaseTo(revealEnd);

    await expect(auction.finalize(auctionId))
      .to.emit(auction, "AuctionFinalized")
      .withArgs(auctionId, alice.address, 0n, 0n);
    expect(await nft.ownerOf(1n)).to.equal(alice.address);
    expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("1"));
    expect(await auction.pendingWithdrawals(seller.address)).to.equal(0n);
  });

  it("reveal is no longer possible after revealEnd, so a late reveal cannot change the result", async function () {
    const { auction, auctionId, carol, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);
    const s = await placeBid(auction, auctionId, carol, eth("9"), eth("9"));
    await time.increaseTo(biddingEnd);
    await time.increaseTo(revealEnd);
    await auction.finalize(auctionId);

    await expect(revealBid(auction, auctionId, s)).to.be.revertedWithCustomError(auction, "InvalidPhase");
  });
});
