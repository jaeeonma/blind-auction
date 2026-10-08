import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { BlindAuction } from "../typechain-types";
import { auctionCreatedFixture, placeBid, randomSecret, revealBid, type SecretBid } from "./fixtures";

const eth = (v: string) => ethers.parseEther(v);

describe("BlindAuction: reveal", function () {
  describe("hash verification and access", function () {
    it("reveals a valid bid: it becomes the highest bid and nothing is credited yet", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      await time.increaseTo(biddingEnd);

      const tx = revealBid(auction, auctionId, s);
      await expect(tx).to.emit(auction, "BidRevealed").withArgs(auctionId, alice.address, eth("3"), true);
      // reveal only writes to the ledger; no ETH leaves the contract (Pull payment).
      await expect(tx).to.changeEtherBalances([alice, auction], [0n, 0n]);

      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(alice.address);
      expect(a.highestBid).to.equal(eth("3"));
      expect(a.highestBidSeq).to.equal(1n);
      expect(a.revealedDeposits).to.equal(eth("5"));
      // The highest bidder's deposit stays in the contract; the excess is credited at finalize (design.md 7번).
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(0n);
      expect((await auction.getBid(auctionId, alice.address)).revealed).to.equal(true);
    });

    it("reverts with CommitmentMismatch when the value or secret differ", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      await time.increaseTo(biddingEnd);

      const wrong: Array<Partial<SecretBid>> = [{ value: eth("4") }, { value: eth("2") }, { secret: randomSecret() }];
      for (const w of wrong) {
        await expect(revealBid(auction, auctionId, { ...s, ...w })).to.be.revertedWithCustomError(
          auction,
          "CommitmentMismatch",
        );
      }
      // A failed attempt changes nothing, so the correct values still work.
      await expect(revealBid(auction, auctionId, s)).to.emit(auction, "BidRevealed");
    });

    it("reverts with AlreadyRevealed on a second reveal", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("3"), eth("2")); // invalid → credited 2
      await time.increaseTo(biddingEnd);

      await revealBid(auction, auctionId, s);
      await expect(revealBid(auction, auctionId, s)).to.be.revertedWithCustomError(auction, "AlreadyRevealed");
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("2"));
    });

    it("reverts with InvalidPhase before and after the reveal phase", async function () {
      const { auction, auctionId, alice, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));

      await time.setNextBlockTimestamp(biddingEnd - 1n);
      await expect(revealBid(auction, auctionId, s)).to.be.revertedWithCustomError(auction, "InvalidPhase");

      await time.setNextBlockTimestamp(revealEnd);
      await expect(revealBid(auction, auctionId, s)).to.be.revertedWithCustomError(auction, "InvalidPhase");
    });

    it("accepts a reveal in the first and last second of the reveal phase", async function () {
      const { auction, auctionId, alice, bob, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);
      const s1 = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      const s2 = await placeBid(auction, auctionId, bob, eth("2"), eth("2"));

      await time.setNextBlockTimestamp(biddingEnd);
      await expect(revealBid(auction, auctionId, s1)).to.emit(auction, "BidRevealed");
      await time.setNextBlockTimestamp(revealEnd - 1n);
      await expect(revealBid(auction, auctionId, s2)).to.emit(auction, "BidRevealed");
    });

    it("cannot reveal someone else's bid (lookup and hash both use msg.sender)", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const aliceBid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      await time.increaseTo(biddingEnd);

      // bob has no bid in this auction.
      await expect(revealBid(auction, auctionId, { ...aliceBid, bidder: bob })).to.be.revertedWithCustomError(
        auction,
        "BidNotFound",
      );

      expect((await auction.getBid(auctionId, alice.address)).revealed).to.equal(false);
      await expect(revealBid(auction, auctionId, aliceBid)).to.emit(auction, "BidRevealed");
    });

    it("bob copying alice's hash cannot reveal it even with alice's value and secret (CommitmentMismatch)", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const aliceBid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      const copied = (await auction.getBid(auctionId, alice.address)).commitment;

      // bob submits the exact same hash (visible on-chain) with his own deposit.
      await auction.connect(bob).bid(auctionId, copied, { value: eth("5") });
      await time.increaseTo(biddingEnd);

      // Even with alice's value and secret, the hash is computed with msg.sender = bob.
      await expect(revealBid(auction, auctionId, { ...aliceBid, bidder: bob })).to.be.revertedWithCustomError(
        auction,
        "CommitmentMismatch",
      );

      // alice's own reveal is unaffected.
      await revealBid(auction, auctionId, aliceBid);
      expect((await auction.getAuction(auctionId)).highestBidder).to.equal(alice.address);
    });
  });

  describe("validity (deposit >= value, design.md 4번 Q3)", function () {
    it("deposit < value → invalid, full deposit credited, highest bid unchanged (Q3-1)", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("3"), eth("2"));
      await time.increaseTo(biddingEnd);

      await expect(revealBid(auction, auctionId, s))
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, eth("3"), false);

      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(ethers.ZeroAddress);
      expect(a.highestBid).to.equal(0n);
      expect(a.revealedDeposits).to.equal(eth("2"));
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("2"));
    });

    it("an invalid bid does not displace the current highest bid", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const aliceBid = await placeBid(auction, auctionId, alice, eth("1"), eth("1"));
      const bobBid = await placeBid(auction, auctionId, bob, eth("9"), eth("2")); // higher value, but invalid
      await time.increaseTo(biddingEnd);

      await revealBid(auction, auctionId, aliceBid);
      await revealBid(auction, auctionId, bobBid);

      expect((await auction.getAuction(auctionId)).highestBidder).to.equal(alice.address);
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(0n);
      expect(await auction.pendingWithdrawals(bob.address)).to.equal(eth("2"));
    });

    it("deposit = value is valid", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("1"), eth("1"));
      await time.increaseTo(biddingEnd);

      await expect(revealBid(auction, auctionId, s))
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, eth("1"), true);
      expect((await auction.getAuction(auctionId)).highestBidder).to.equal(alice.address);
    });

    it("value = 0 is valid (no reserve price) and becomes the first highest bid", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, 0n, eth("1"));
      await time.increaseTo(biddingEnd);

      await expect(revealBid(auction, auctionId, s))
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, 0n, true);
      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(alice.address);
      expect(a.highestBid).to.equal(0n);
    });

    it("value = 0 with deposit = 0 is valid", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, 0n, 0n);
      await time.increaseTo(biddingEnd);

      await expect(revealBid(auction, auctionId, s))
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, 0n, true);
      expect((await auction.getAuction(auctionId)).highestBidder).to.equal(alice.address);
    });
  });

  describe("ledger on reveal (design.md 7번 table)", function () {
    it("valid but lower → its full deposit is credited, highest bid unchanged", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const bobBid = await placeBid(auction, auctionId, bob, eth("4"), eth("4"));
      const aliceBid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      await time.increaseTo(biddingEnd);

      await revealBid(auction, auctionId, bobBid);
      await expect(revealBid(auction, auctionId, aliceBid))
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, eth("3"), true);

      expect((await auction.getAuction(auctionId)).highestBidder).to.equal(bob.address);
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("5"));
      expect(await auction.pendingWithdrawals(bob.address)).to.equal(0n);
    });

    it("valid and higher → becomes highest; the displaced bidder gets the full deposit back", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const aliceBid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      const bobBid = await placeBid(auction, auctionId, bob, eth("4"), eth("4"));
      await time.increaseTo(biddingEnd);

      await revealBid(auction, auctionId, aliceBid);
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(0n);

      await revealBid(auction, auctionId, bobBid);

      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(bob.address);
      expect(a.highestBid).to.equal(eth("4"));
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("5")); // full deposit
      expect(await auction.pendingWithdrawals(bob.address)).to.equal(0n);
    });

    describe("tie: the earlier bid (smaller seq) wins regardless of reveal order (Q5)", function () {
      async function tieFixture() {
        const f = await auctionCreatedFixture();
        const aliceBid = await placeBid(f.auction, f.auctionId, f.alice, eth("2"), eth("2")); // seq 1
        const bobBid = await placeBid(f.auction, f.auctionId, f.bob, eth("2"), eth("3")); // seq 2
        await time.increaseTo(f.biddingEnd);
        return { ...f, aliceBid, bobBid };
      }

      it("later bid revealed first, earlier bid revealed later → the earlier bid becomes highest", async function () {
        const { auction, auctionId, alice, bob, aliceBid, bobBid } = await loadFixture(tieFixture);

        await revealBid(auction, auctionId, bobBid);
        expect((await auction.getAuction(auctionId)).highestBidder).to.equal(bob.address);

        await revealBid(auction, auctionId, aliceBid);

        const a = await auction.getAuction(auctionId);
        expect(a.highestBidder).to.equal(alice.address);
        expect(a.highestBid).to.equal(eth("2"));
        expect(a.highestBidSeq).to.equal(1n);
        expect(await auction.pendingWithdrawals(bob.address)).to.equal(eth("3")); // displaced, full deposit
        expect(await auction.pendingWithdrawals(alice.address)).to.equal(0n);
      });

      it("earlier bid revealed first → the later tie does not replace it", async function () {
        const { auction, auctionId, alice, bob, aliceBid, bobBid } = await loadFixture(tieFixture);

        await revealBid(auction, auctionId, aliceBid);
        await revealBid(auction, auctionId, bobBid);

        const a = await auction.getAuction(auctionId);
        expect(a.highestBidder).to.equal(alice.address);
        expect(a.highestBidSeq).to.equal(1n);
        expect(await auction.pendingWithdrawals(bob.address)).to.equal(eth("3")); // lost, full deposit
        expect(await auction.pendingWithdrawals(alice.address)).to.equal(0n);
      });
    });
  });

  describe("balance invariant", function () {
    /**
     * contract ETH balance
     *   = sum of all pendingWithdrawals + highest bidder's deposit + deposits not yet revealed
     */
    async function expectInvariant(
      auction: BlindAuction,
      auctionId: bigint,
      accounts: HardhatEthersSigner[],
      unrevealed: SecretBid[],
    ) {
      const balance = await ethers.provider.getBalance(await auction.getAddress());
      let pending = 0n;
      for (const acc of accounts) pending += await auction.pendingWithdrawals(acc.address);
      const unrevealedSum = unrevealed.reduce((sum, s) => sum + s.deposit, 0n);
      const a = await auction.getAuction(auctionId);
      const held = a.highestBidder === ethers.ZeroAddress ? 0n : (await auction.getBid(auctionId, a.highestBidder)).deposit;

      // The contract's counters agree with the test's own bookkeeping.
      expect(a.totalDeposits - a.revealedDeposits).to.equal(unrevealedSum);
      expect(balance).to.equal(pending + held + unrevealedSum);
    }

    it("holds after every reveal (tie + invalid bids + an unrevealed bid)", async function () {
      const { auction, auctionId, seller, biddingEnd } = await loadFixture(auctionCreatedFixture);
      // One bid per wallet, so each case uses its own signer (fixture uses signers 0-4).
      const [w1, w2, w3, w4, w5, w6, w7] = (await ethers.getSigners()).slice(5, 12);
      const accounts = [seller, w1, w2, w3, w4, w5, w6, w7];

      const first = await placeBid(auction, auctionId, w1, eth("3"), eth("5")); // seq 1
      const short = await placeBid(auction, auctionId, w2, eth("3"), eth("2")); // seq 2, deposit < value
      const winner = await placeBid(auction, auctionId, w3, eth("4"), eth("4")); // seq 3
      const hidden = await placeBid(auction, auctionId, w4, eth("2"), eth("2")); // seq 4, never revealed
      const tie = await placeBid(auction, auctionId, w5, eth("4"), eth("6")); // seq 5, ties w3
      const low = await placeBid(auction, auctionId, w6, eth("0.5"), eth("1")); // valid but lower
      const zero = await placeBid(auction, auctionId, w7, 0n, 0n); // valid, lowest

      const unrevealed = [first, short, winner, hidden, tie, low, zero];
      await time.increaseTo(biddingEnd);
      await expectInvariant(auction, auctionId, accounts, unrevealed);

      const order = [first, short, tie, winner, low, zero];
      for (const s of order) {
        await revealBid(auction, auctionId, s);
        unrevealed.splice(unrevealed.indexOf(s), 1);
        await expectInvariant(auction, auctionId, accounts, unrevealed);
      }

      // Final state: w3 wins the tie against w5 with the earlier seq.
      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(w3.address);
      expect(a.highestBid).to.equal(eth("4"));
      expect(await auction.pendingWithdrawals(w1.address)).to.equal(eth("5")); // displaced by w5
      expect(await auction.pendingWithdrawals(w2.address)).to.equal(eth("2")); // invalid
      expect(await auction.pendingWithdrawals(w3.address)).to.equal(0n); // highest, settled at finalize
      expect(await auction.pendingWithdrawals(w5.address)).to.equal(eth("6")); // displaced by w3
      expect(await auction.pendingWithdrawals(w6.address)).to.equal(eth("1")); // lower
      expect(await auction.pendingWithdrawals(w7.address)).to.equal(0n); // lower, deposit 0
      expect(unrevealed).to.deep.equal([hidden]); // 2 ETH to be forfeited at finalize
    });
  });
});
