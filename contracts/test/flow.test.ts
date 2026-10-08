import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { Phase, auctionCreatedFixture, placeBid, revealBid } from "./fixtures";

const eth = (v: string) => ethers.parseEther(v);

describe("BlindAuction: full flow (design.md 7번 example)", function () {
  /**
   * | bidder | deposit | value    | result          | ledger              |
   * |--------|---------|----------|-----------------|---------------------|
   * | A      | 5       | 3        | displaced by B  | 5 (when B reveals)  |
   * | B      | 4       | 4        | wins            | 0 (at finalize)     |
   * | C      | 2       | 3        | invalid         | 2 (when C reveals)  |
   * | D      | 3       | hidden   | forfeited       | -                   |
   * | seller |         |          |                 | 4 + 3 = 7 (finalize)|
   *
   * Reveal order A → B → C, D never reveals. Ledger total 14 = deposit total 14.
   */
  it("create → bid → reveal → finalize → withdraw; the ledger matches the deposits exactly", async function () {
    const { nft, auction, auctionId, seller, alice, bob, carol, other, biddingEnd, revealEnd } =
      await loadFixture(auctionCreatedFixture);
    const [A, B, C, D] = [alice, bob, carol, other];
    const auctionAddress = await auction.getAddress();

    // 1. Bid
    const a = await placeBid(auction, auctionId, A, eth("3"), eth("5"));
    const b = await placeBid(auction, auctionId, B, eth("4"), eth("4"));
    const c = await placeBid(auction, auctionId, C, eth("3"), eth("2"));
    await placeBid(auction, auctionId, D, eth("1"), eth("3")); // D never reveals
    expect(await ethers.provider.getBalance(auctionAddress)).to.equal(eth("14"));

    // 2. Reveal A → B → C
    await time.increaseTo(biddingEnd);
    expect(await auction.phaseOf(auctionId)).to.equal(Phase.Reveal);

    await revealBid(auction, auctionId, a);
    expect(await auction.pendingWithdrawals(A.address)).to.equal(0n); // A is the highest for now

    await revealBid(auction, auctionId, b);
    expect(await auction.pendingWithdrawals(A.address)).to.equal(eth("5")); // displaced by B

    await expect(revealBid(auction, auctionId, c))
      .to.emit(auction, "BidRevealed")
      .withArgs(auctionId, C.address, eth("3"), false);
    expect(await auction.pendingWithdrawals(C.address)).to.equal(eth("2")); // invalid

    // 3. Finalize
    await time.increaseTo(revealEnd);
    expect(await auction.phaseOf(auctionId)).to.equal(Phase.AwaitingFinalize);
    await expect(auction.finalize(auctionId))
      .to.emit(auction, "AuctionFinalized")
      .withArgs(auctionId, B.address, eth("4"), eth("3"));
    expect(await auction.phaseOf(auctionId)).to.equal(Phase.Finalized);
    expect(await nft.ownerOf(1n)).to.equal(B.address);

    const ledger = {
      A: await auction.pendingWithdrawals(A.address),
      B: await auction.pendingWithdrawals(B.address),
      C: await auction.pendingWithdrawals(C.address),
      D: await auction.pendingWithdrawals(D.address),
      seller: await auction.pendingWithdrawals(seller.address),
    };
    expect(ledger).to.deep.equal({ A: eth("5"), B: 0n, C: eth("2"), D: 0n, seller: eth("7") });
    // Ledger total = deposit total: nothing is left over or missing in the contract.
    const total = ledger.A + ledger.B + ledger.C + ledger.D + ledger.seller;
    expect(total).to.equal(eth("14"));
    expect(total).to.equal(await ethers.provider.getBalance(auctionAddress));

    // 4. Withdraw
    await expect(auction.connect(A).withdraw()).to.changeEtherBalance(A, eth("5"));
    await expect(auction.connect(C).withdraw()).to.changeEtherBalance(C, eth("2"));
    await expect(auction.connect(seller).withdraw()).to.changeEtherBalance(seller, eth("7"));
    await expect(auction.connect(B).withdraw()).to.be.revertedWithCustomError(auction, "NothingToWithdraw");
    await expect(auction.connect(D).withdraw()).to.be.revertedWithCustomError(auction, "NothingToWithdraw");

    expect(await ethers.provider.getBalance(auctionAddress)).to.equal(0n);
  });
});
