import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { auctionCreatedFixture, computeCommitment, placeBid, randomSecret, revealBid } from "./fixtures";

const eth = (v: string) => ethers.parseEther(v);

// ReentrantBidder.Mode
const Mode = { Swallow: 0n, Bubble: 1n } as const;

describe("BlindAuction: withdraw", function () {
  /** alice's invalid bid is revealed, so 2 ETH is on her ledger during the reveal phase. */
  async function creditedFixture() {
    const f = await auctionCreatedFixture();
    const aliceBid = await placeBid(f.auction, f.auctionId, f.alice, eth("3"), eth("2"));
    await time.increaseTo(f.biddingEnd);
    await revealBid(f.auction, f.auctionId, aliceBid);
    return f;
  }

  it("pays out the ledger amount, zeroes it and emits Withdrawn (any time, here in the reveal phase)", async function () {
    const { auction, alice } = await loadFixture(creditedFixture);

    const tx = auction.connect(alice).withdraw();
    await expect(tx).to.emit(auction, "Withdrawn").withArgs(alice.address, eth("2"));
    await expect(tx).to.changeEtherBalances([alice, auction], [eth("2"), -eth("2")]);
    expect(await auction.pendingWithdrawals(alice.address)).to.equal(0n);
  });

  it("reverts with NothingToWithdraw on a second withdraw", async function () {
    const { auction, alice } = await loadFixture(creditedFixture);
    await auction.connect(alice).withdraw();

    await expect(auction.connect(alice).withdraw()).to.be.revertedWithCustomError(auction, "NothingToWithdraw");
  });

  it("reverts with NothingToWithdraw for an account with an empty ledger", async function () {
    const { auction, bob } = await loadFixture(creditedFixture);
    await expect(auction.connect(bob).withdraw()).to.be.revertedWithCustomError(auction, "NothingToWithdraw");
  });

  it("the winner and the seller withdraw their shares after finalize", async function () {
    const { auction, auctionId, seller, alice, bob, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);
    const aliceBid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
    await placeBid(auction, auctionId, bob, eth("1"), eth("1")); // never revealed → forfeited
    await time.increaseTo(biddingEnd);
    await revealBid(auction, auctionId, aliceBid);
    await time.increaseTo(revealEnd);
    await auction.finalize(auctionId);

    await expect(auction.connect(alice).withdraw()).to.changeEtherBalance(alice, eth("2")); // 5 − 3
    await expect(auction.connect(seller).withdraw()).to.changeEtherBalance(seller, eth("4")); // 3 + 1
    expect(await ethers.provider.getBalance(await auction.getAddress())).to.equal(0n);
  });

  describe("reentrancy (design.md 13번)", function () {
    /** alice has 2 ETH and the attacker contract 1 ETH on the ledger; the contract holds 3 ETH. */
    async function attackFixture() {
      const f = await creditedFixture();
      const attacker = await ethers.deployContract("ReentrantBidder", [await f.auction.getAddress()]);
      return { ...f, attacker };
    }

    async function creditAttacker(f: Awaited<ReturnType<typeof attackFixture>>) {
      // The attacker has to bid during the bidding phase, so use a second auction.
      const { nft, auction, seller } = f;
      await nft.mint(seller.address); // tokenId 2
      await nft.connect(seller).approve(await auction.getAddress(), 2n);
      await auction.connect(seller).createAuction(await nft.getAddress(), 2n, 10n * 60n, 24n * 60n * 60n);
      const auctionId = 1n;
      const attackerAddress = await f.attacker.getAddress();

      const secret = randomSecret();
      const value = eth("3"); // deposit 1 < value 3 → invalid → full deposit credited at reveal
      await f.attacker.bid(auctionId, computeCommitment(value, secret, attackerAddress), { value: eth("1") });
      await time.increaseTo((await auction.getAuction(auctionId)).biddingEnd);
      await f.attacker.reveal(auctionId, value, secret);
      expect(await auction.pendingWithdrawals(attackerAddress)).to.equal(eth("1"));
      return attackerAddress;
    }

    it("a reentrant withdraw is blocked: the attacker gets its own amount exactly once", async function () {
      const f = await loadFixture(attackFixture);
      const { auction, alice, attacker } = f;
      const attackerAddress = await creditAttacker(f);
      const auctionAddress = await auction.getAddress();
      expect(await ethers.provider.getBalance(auctionAddress)).to.equal(eth("3"));

      await attacker.setMode(Mode.Swallow);
      await expect(attacker.attack()).to.changeEtherBalances([attacker, auction], [eth("1"), -eth("1")]);

      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentryBlocked()).to.equal(true);
      // Blocked by the reentrancy guard (nonReentrant).
      expect(await attacker.reentryError()).to.equal(
        auction.interface.encodeErrorResult("ReentrancyGuardReentrantCall", []),
      );
      // alice's money is still there.
      expect(await auction.pendingWithdrawals(attackerAddress)).to.equal(0n);
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("2"));
      expect(await ethers.provider.getBalance(auctionAddress)).to.equal(eth("2"));
    });

    it("if the receiver reverts, withdraw fails with TransferFailed and the ledger is kept; others are unaffected", async function () {
      const f = await loadFixture(attackFixture);
      const { auction, alice, attacker } = f;
      const attackerAddress = await creditAttacker(f);

      await attacker.setMode(Mode.Bubble);
      await expect(attacker.attack()).to.be.revertedWithCustomError(auction, "TransferFailed");
      // The whole transaction reverted, so zeroing the ledger was undone too.
      expect(await auction.pendingWithdrawals(attackerAddress)).to.equal(eth("1"));

      // Pull payment: one receiver refusing ETH does not block anyone else (design.md 13번 "자산 전송").
      await expect(auction.connect(alice).withdraw()).to.changeEtherBalance(alice, eth("2"));
    });
  });
});
