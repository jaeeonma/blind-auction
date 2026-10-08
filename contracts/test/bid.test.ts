import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  BIDDING_DURATION,
  REVEAL_DURATION,
  auctionCreatedFixture,
  computeCommitment,
  randomSalt,
} from "./fixtures";

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

    await expect(tx).to.emit(auction, "BidCommitted").withArgs(auctionId, alice.address, commitment, deposit);
    // The deposit moves from the bidder to the contract.
    await expect(tx).to.changeEtherBalances([alice, auction], [-deposit, deposit]);

    const a = await auction.getAuction(auctionId);
    expect(a.totalDeposits).to.equal(deposit);
    expect(a.revealedDeposits).to.equal(0n);
    expect(a.bidCount).to.equal(1n);

    const b = await auction.getBid(auctionId, alice.address);
    expect(b.commitment).to.equal(commitment);
    expect(b.deposit).to.equal(deposit);
    expect(b.seq).to.equal(1n);
    expect(b.revealed).to.equal(false);
  });

  it("records the bid order per auction, starting at 1", async function () {
    const { nft, auction, auctionId, seller, alice, bob, carol } = await loadFixture(auctionCreatedFixture);

    await auction.connect(alice).bid(auctionId, ethers.id("alice"), { value: ethers.parseEther("2") });
    await auction.connect(bob).bid(auctionId, ethers.id("bob"), { value: ethers.parseEther("4") });
    await auction.connect(carol).bid(auctionId, ethers.id("carol"), { value: ethers.parseEther("1") });

    expect((await auction.getBid(auctionId, alice.address)).seq).to.equal(1n);
    expect((await auction.getBid(auctionId, bob.address)).seq).to.equal(2n);
    expect((await auction.getBid(auctionId, carol.address)).seq).to.equal(3n);
    const a = await auction.getAuction(auctionId);
    expect(a.bidCount).to.equal(3n);
    expect(a.totalDeposits).to.equal(ethers.parseEther("7"));

    // A second auction counts its own order from 1.
    await nft.mint(seller.address); // tokenId 2
    await nft.connect(seller).approve(await auction.getAddress(), 2n);
    await auction.connect(seller).createAuction(await nft.getAddress(), 2n, BIDDING_DURATION, REVEAL_DURATION);
    await auction.connect(bob).bid(1n, ethers.id("bob-2"), { value: 1n });
    expect((await auction.getBid(1n, bob.address)).seq).to.equal(1n);
  });

  it("reverts with AlreadyBid on a second bid from the same wallet", async function () {
    const { auction, auctionId, alice } = await loadFixture(auctionCreatedFixture);
    await auction.connect(alice).bid(auctionId, ethers.id("first"), { value: 1n });

    await expect(
      auction.connect(alice).bid(auctionId, ethers.id("second"), { value: 1n }),
    ).to.be.revertedWithCustomError(auction, "AlreadyBid");
    expect((await auction.getBid(auctionId, alice.address)).commitment).to.equal(ethers.id("first"));
  });

  it("accepts a zero-deposit bid, which still counts as the wallet's one bid", async function () {
    const { auction, auctionId, alice } = await loadFixture(auctionCreatedFixture);

    await expect(auction.connect(alice).bid(auctionId, ethers.id("x")))
      .to.emit(auction, "BidCommitted")
      .withArgs(auctionId, alice.address, ethers.id("x"), 0n);
    await expect(auction.connect(alice).bid(auctionId, ethers.id("y"))).to.be.revertedWithCustomError(
      auction,
      "AlreadyBid",
    );
  });

  it("allows the seller to bid", async function () {
    const { auction, auctionId, seller } = await loadFixture(auctionCreatedFixture);
    await expect(auction.connect(seller).bid(auctionId, ethers.id("x"), { value: 1n })).to.emit(
      auction,
      "BidCommitted",
    );
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

  it("getBid reverts with BidNotFound for a wallet that has not bid", async function () {
    const { auction, auctionId, alice } = await loadFixture(auctionCreatedFixture);
    await expect(auction.getBid(auctionId, alice.address)).to.be.revertedWithCustomError(auction, "BidNotFound");
  });
});
