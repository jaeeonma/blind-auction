import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
  BIDDING_DURATION,
  MAX_BIDDING_DURATION,
  MAX_REVEAL_DURATION,
  MIN_BIDDING_DURATION,
  MIN_REVEAL_DURATION,
  Phase,
  REVEAL_DURATION,
  auctionCreatedFixture,
  deployFixture,
} from "./fixtures";

describe("BlindAuction: createAuction", function () {
  it("moves the NFT into escrow and emits AuctionCreated", async function () {
    const { nft, auction, seller } = await loadFixture(deployFixture);
    const nftAddress = await nft.getAddress();

    const tx = await auction.connect(seller).createAuction(nftAddress, 1n, BIDDING_DURATION, REVEAL_DURATION);
    const now = BigInt(await time.latest());
    const biddingEnd = now + BIDDING_DURATION;
    const revealEnd = biddingEnd + REVEAL_DURATION;

    await expect(tx)
      .to.emit(auction, "AuctionCreated")
      .withArgs(0n, seller.address, nftAddress, 1n, biddingEnd, revealEnd);
    expect(await nft.ownerOf(1n)).to.equal(await auction.getAddress());

    const a = await auction.getAuction(0n);
    expect(a.seller).to.equal(seller.address);
    expect(a.nft).to.equal(nftAddress);
    expect(a.tokenId).to.equal(1n);
    expect(a.biddingEnd).to.equal(biddingEnd);
    expect(a.revealEnd).to.equal(revealEnd);
    expect(a.highestBidder).to.equal(ethers.ZeroAddress);
    expect(a.bidCount).to.equal(0n);
    expect(a.finalized).to.equal(false);
  });

  it("issues sequential auction ids", async function () {
    const { nft, auction, seller } = await loadFixture(deployFixture);
    const nftAddress = await nft.getAddress();
    await nft.mint(seller.address); // tokenId 2
    await nft.connect(seller).setApprovalForAll(await auction.getAddress(), true);

    await auction.connect(seller).createAuction(nftAddress, 1n, BIDDING_DURATION, REVEAL_DURATION);
    await expect(auction.connect(seller).createAuction(nftAddress, 2n, BIDDING_DURATION, REVEAL_DURATION))
      .to.emit(auction, "AuctionCreated")
      .withArgs(1n, seller.address, nftAddress, 2n, (v: bigint) => v > 0n, (v: bigint) => v > 0n);
    expect(await auction.nextAuctionId()).to.equal(2n);
  });

  it("fails without approval", async function () {
    const { nft, auction, seller } = await loadFixture(deployFixture);
    await nft.mint(seller.address); // tokenId 2, not approved

    await expect(
      auction.connect(seller).createAuction(await nft.getAddress(), 2n, BIDDING_DURATION, REVEAL_DURATION),
    ).to.be.revertedWithCustomError(nft, "ERC721InsufficientApproval");
  });

  it("fails when the caller is not the NFT owner", async function () {
    const { nft, auction, alice } = await loadFixture(deployFixture);

    // Token 1 is owned by seller and approved to the auction, but alice calls.
    await expect(
      auction.connect(alice).createAuction(await nft.getAddress(), 1n, BIDDING_DURATION, REVEAL_DURATION),
    ).to.be.revertedWithCustomError(nft, "ERC721IncorrectOwner");
  });

  describe("durations (bidding 10 minutes to 5 days, reveal 1 to 2 days)", function () {
    const cases: Array<[string, bigint, bigint]> = [
      ["bidding < 10 minutes", MIN_BIDDING_DURATION - 1n, MIN_REVEAL_DURATION],
      ["bidding > 5 days", MAX_BIDDING_DURATION + 1n, MIN_REVEAL_DURATION],
      ["reveal < 1 day", MIN_BIDDING_DURATION, MIN_REVEAL_DURATION - 1n],
      ["reveal > 2 days", MIN_BIDDING_DURATION, MAX_REVEAL_DURATION + 1n],
    ];

    for (const [name, bidding, reveal] of cases) {
      it(`reverts with InvalidDuration when ${name}`, async function () {
        const { nft, auction, seller } = await loadFixture(deployFixture);
        await expect(
          auction.connect(seller).createAuction(await nft.getAddress(), 1n, bidding, reveal),
        ).to.be.revertedWithCustomError(auction, "InvalidDuration");
      });
    }

    it("accepts the exact minimum and maximum durations", async function () {
      const { nft, auction, seller } = await loadFixture(deployFixture);
      await nft.mint(seller.address); // tokenId 2
      await nft.connect(seller).setApprovalForAll(await auction.getAddress(), true);
      const nftAddress = await nft.getAddress();

      await expect(
        auction.connect(seller).createAuction(nftAddress, 1n, MIN_BIDDING_DURATION, MIN_REVEAL_DURATION),
      ).to.emit(auction, "AuctionCreated");
      await expect(
        auction.connect(seller).createAuction(nftAddress, 2n, MAX_BIDDING_DURATION, MAX_REVEAL_DURATION),
      ).to.emit(auction, "AuctionCreated");
    });
  });

  describe("phaseOf", function () {
    it("moves Bidding -> Reveal -> AwaitingFinalize by block.timestamp", async function () {
      const { auction, auctionId, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);

      expect(await auction.phaseOf(auctionId)).to.equal(Phase.Bidding);

      await time.increaseTo(biddingEnd - 1n);
      expect(await auction.phaseOf(auctionId)).to.equal(Phase.Bidding);

      await time.increaseTo(biddingEnd);
      expect(await auction.phaseOf(auctionId)).to.equal(Phase.Reveal);

      await time.increaseTo(revealEnd - 1n);
      expect(await auction.phaseOf(auctionId)).to.equal(Phase.Reveal);

      await time.increaseTo(revealEnd);
      expect(await auction.phaseOf(auctionId)).to.equal(Phase.AwaitingFinalize);
    });

    it("reverts with AuctionNotFound for an unknown id", async function () {
      const { auction } = await loadFixture(auctionCreatedFixture);
      await expect(auction.phaseOf(99n)).to.be.revertedWithCustomError(auction, "AuctionNotFound");
      await expect(auction.getAuction(99n)).to.be.revertedWithCustomError(auction, "AuctionNotFound");
    });
  });
});
