import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { auctionCreatedFixture, computeCommitment, randomSalt } from "./fixtures";

describe("BlindAuction: bid", function () {
  it("stores the commitment and deposit and emits BidCommitted", async function () {
    const { auction, auctionId, auctionAddress, alice } = await loadFixture(auctionCreatedFixture);
    const deposit = ethers.parseEther("5");
    const commitment = computeCommitment(
      auctionAddress,
      auctionId,
      alice.address,
      ethers.parseEther("3"),
      false,
      randomSalt(),
    );

    const tx = auction.connect(alice).bid(auctionId, commitment, { value: deposit });

    await expect(tx)
      .to.emit(auction, "BidCommitted")
      .withArgs(auctionId, alice.address, 0n, 1n, commitment, deposit);
    // The deposit moves from the bidder to the contract.
    await expect(tx).to.changeEtherBalances([alice, auction], [-deposit, deposit]);

    const a = await auction.getAuction(auctionId);
    expect(a.totalDeposits).to.equal(deposit);
    expect(a.revealedDeposits).to.equal(0n);
    expect(a.bidCount).to.equal(1n);

    const b = await auction.getBid(auctionId, alice.address, 0n);
    expect(b.commitment).to.equal(commitment);
    expect(b.deposit).to.equal(deposit);
    expect(b.seq).to.equal(1n);
    expect(b.revealed).to.equal(false);
  });

  it("allows one address to bid multiple times; seq is a global order across bidders", async function () {
    const { auction, auctionId, alice, bob } = await loadFixture(auctionCreatedFixture);
    const c1 = ethers.id("alice-1");
    const c2 = ethers.id("bob-1");
    const c3 = ethers.id("alice-2");

    await auction.connect(alice).bid(auctionId, c1, { value: ethers.parseEther("2") });
    await auction.connect(bob).bid(auctionId, c2, { value: ethers.parseEther("4") });
    await expect(auction.connect(alice).bid(auctionId, c3, { value: ethers.parseEther("1") }))
      .to.emit(auction, "BidCommitted")
      .withArgs(auctionId, alice.address, 1n, 3n, c3, ethers.parseEther("1"));

    expect(await auction.bidCountOf(auctionId, alice.address)).to.equal(2n);
    expect(await auction.bidCountOf(auctionId, bob.address)).to.equal(1n);
    expect((await auction.getBid(auctionId, alice.address, 0n)).seq).to.equal(1n);
    expect((await auction.getBid(auctionId, bob.address, 0n)).seq).to.equal(2n);
    expect((await auction.getBid(auctionId, alice.address, 1n)).seq).to.equal(3n);

    const a = await auction.getAuction(auctionId);
    expect(a.bidCount).to.equal(3n);
    expect(a.totalDeposits).to.equal(ethers.parseEther("7"));
  });

  it("reverts with ZeroDeposit when no ETH is sent", async function () {
    const { auction, auctionId, alice } = await loadFixture(auctionCreatedFixture);
    await expect(auction.connect(alice).bid(auctionId, ethers.id("x"))).to.be.revertedWithCustomError(
      auction,
      "ZeroDeposit",
    );
  });

  it("reverts with SellerCannotBid when the seller bids", async function () {
    const { auction, auctionId, seller } = await loadFixture(auctionCreatedFixture);
    await expect(
      auction.connect(seller).bid(auctionId, ethers.id("x"), { value: 1n }),
    ).to.be.revertedWithCustomError(auction, "SellerCannotBid");
  });

  it("accepts a bid in the last second of the bidding phase", async function () {
    const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
    await time.setNextBlockTimestamp(biddingEnd - 1n);
    await expect(auction.connect(alice).bid(auctionId, ethers.id("x"), { value: 1n })).to.emit(
      auction,
      "BidCommitted",
    );
  });

  it("reverts with InvalidPhase once biddingEnd is reached", async function () {
    const { auction, auctionId, alice, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);

    await time.setNextBlockTimestamp(biddingEnd);
    await expect(
      auction.connect(alice).bid(auctionId, ethers.id("x"), { value: 1n }),
    ).to.be.revertedWithCustomError(auction, "InvalidPhase");

    await time.increaseTo(revealEnd);
    await expect(
      auction.connect(alice).bid(auctionId, ethers.id("x"), { value: 1n }),
    ).to.be.revertedWithCustomError(auction, "InvalidPhase");
  });

  it("reverts with AuctionNotFound for an unknown auction", async function () {
    const { auction, alice } = await loadFixture(auctionCreatedFixture);
    await expect(
      auction.connect(alice).bid(99n, ethers.id("x"), { value: 1n }),
    ).to.be.revertedWithCustomError(auction, "AuctionNotFound");
  });

  it("getBid reverts with BidNotFound for a missing index", async function () {
    const { auction, auctionId, alice } = await loadFixture(auctionCreatedFixture);
    await expect(auction.getBid(auctionId, alice.address, 0n)).to.be.revertedWithCustomError(
      auction,
      "BidNotFound",
    );

    await auction.connect(alice).bid(auctionId, ethers.id("x"), { value: 1n });
    await expect(auction.getBid(auctionId, alice.address, 1n)).to.be.revertedWithCustomError(
      auction,
      "BidNotFound",
    );
  });
});
