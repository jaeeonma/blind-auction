import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { BlindAuction } from "../typechain-types";
import {
  InvalidReason,
  auctionCreatedFixture,
  placeBid,
  randomSalt,
  revealBid,
  type SecretBid,
} from "./fixtures";

const eth = (v: string) => ethers.parseEther(v);

describe("BlindAuction: reveal", function () {
  describe("hash verification and access", function () {
    it("reveals a valid bid, sets the highest bid and credits the excess deposit", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      await time.increaseTo(biddingEnd);

      const tx = revealBid(auction, auctionId, s);
      await expect(tx).to.emit(auction, "HighestBidUpdated").withArgs(auctionId, alice.address, eth("3"));
      await expect(tx)
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, 0n, eth("3"), false, InvalidReason.None, eth("2"));
      // reveal only credits pendingWithdrawals; no ETH leaves the contract (Pull payment).
      await expect(tx).to.changeEtherBalances([alice, auction], [0n, 0n]);

      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(alice.address);
      expect(a.highestBid).to.equal(eth("3"));
      expect(a.highestBidSeq).to.equal(1n);
      expect(a.revealedDeposits).to.equal(eth("5"));
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("2"));
      expect((await auction.getBid(auctionId, alice.address, 0n)).revealed).to.equal(true);
    });

    it("reverts with CommitmentMismatch when value, fake, salt or bidIndex differ", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      await placeBid(auction, auctionId, alice, eth("1"), eth("1")); // bidIndex 1
      await time.increaseTo(biddingEnd);

      const wrong: Array<Partial<SecretBid>> = [
        { value: eth("4") },
        { fake: true },
        { salt: randomSalt() },
        { bidIndex: 1n },
      ];
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
      const s = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
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

      // bob has no bids: his own bid list is empty.
      await expect(revealBid(auction, auctionId, { ...aliceBid, bidder: bob })).to.be.revertedWithCustomError(
        auction,
        "BidNotFound",
      );

      expect((await auction.getBid(auctionId, alice.address, 0n)).revealed).to.equal(false);
      await expect(revealBid(auction, auctionId, aliceBid)).to.emit(auction, "BidRevealed");
    });

    it("bob copying alice's commitment cannot reveal it with alice's values (CommitmentMismatch)", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const aliceBid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      const copied = (await auction.getBid(auctionId, alice.address, 0n)).commitment;

      // bob submits the exact same commitment (visible on-chain) with his own deposit.
      await auction.connect(bob).bid(auctionId, copied, { value: eth("5") });
      await time.increaseTo(biddingEnd);

      // Even with alice's value/fake/salt, the hash is computed with msg.sender = bob.
      await expect(revealBid(auction, auctionId, { ...aliceBid, bidder: bob })).to.be.revertedWithCustomError(
        auction,
        "CommitmentMismatch",
      );

      // alice's own reveal is unaffected.
      await expect(revealBid(auction, auctionId, aliceBid))
        .to.emit(auction, "HighestBidUpdated")
        .withArgs(auctionId, alice.address, eth("3"));
    });
  });

  describe("validity (design.md 2.3)", function () {
    const cases: Array<{ name: string; value: bigint; deposit: bigint; fake: boolean; reason: bigint }> = [
      { name: "fake bid", value: eth("3"), deposit: eth("5"), fake: true, reason: InvalidReason.Fake },
      {
        name: "deposit < value",
        value: eth("3"),
        deposit: eth("2"),
        fake: false,
        reason: InvalidReason.InsufficientDeposit,
      },
    ];

    for (const c of cases) {
      it(`${c.name} → invalid, full deposit credited, highest bid unchanged`, async function () {
        const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
        const s = await placeBid(auction, auctionId, alice, c.value, c.deposit, c.fake);
        await time.increaseTo(biddingEnd);

        const tx = revealBid(auction, auctionId, s);
        await expect(tx)
          .to.emit(auction, "BidRevealed")
          .withArgs(auctionId, alice.address, 0n, c.value, c.fake, c.reason, c.deposit);
        await expect(tx).not.to.emit(auction, "HighestBidUpdated");

        const a = await auction.getAuction(auctionId);
        expect(a.highestBidder).to.equal(ethers.ZeroAddress);
        expect(a.highestBid).to.equal(0n);
        expect(await auction.pendingWithdrawals(alice.address)).to.equal(c.deposit);
      });
    }

    it("value = 0 is valid (no reserve price) and becomes the first highest bid", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, 0n, eth("1"));
      await time.increaseTo(biddingEnd);

      await expect(revealBid(auction, auctionId, s))
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, 0n, 0n, false, InvalidReason.None, eth("1"));
      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(alice.address);
      expect(a.highestBid).to.equal(0n);
    });

    it("deposit = value is valid", async function () {
      const { auction, auctionId, alice, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const s = await placeBid(auction, auctionId, alice, eth("1"), eth("1"));
      await time.increaseTo(biddingEnd);

      await expect(revealBid(auction, auctionId, s))
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, 0n, eth("1"), false, InvalidReason.None, 0n);
    });
  });

  describe("highest bid updates", function () {
    it("a lower valid bid does not replace the highest bid and gets its full deposit back", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const bobBid = await placeBid(auction, auctionId, bob, eth("4"), eth("4"));
      const aliceBid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      await time.increaseTo(biddingEnd);

      await revealBid(auction, auctionId, bobBid);
      const tx = revealBid(auction, auctionId, aliceBid);
      await expect(tx)
        .to.emit(auction, "BidRevealed")
        .withArgs(auctionId, alice.address, 0n, eth("3"), false, InvalidReason.None, eth("5"));
      await expect(tx).not.to.emit(auction, "HighestBidUpdated");

      expect((await auction.getAuction(auctionId)).highestBidder).to.equal(bob.address);
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("5"));
      expect(await auction.pendingWithdrawals(bob.address)).to.equal(0n);
    });

    it("a higher bid replaces the highest bid; the previous amount is credited to the previous bidder", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const aliceBid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      const bobBid = await placeBid(auction, auctionId, bob, eth("4"), eth("4"));
      await time.increaseTo(biddingEnd);

      await revealBid(auction, auctionId, aliceBid);
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("2"));

      await expect(revealBid(auction, auctionId, bobBid))
        .to.emit(auction, "HighestBidUpdated")
        .withArgs(auctionId, bob.address, eth("4"));

      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(bob.address);
      expect(a.highestBid).to.equal(eth("4"));
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("5")); // 2 excess + 3 displaced
      expect(await auction.pendingWithdrawals(bob.address)).to.equal(0n);
    });

    describe("tie: the earlier commit (smaller seq) wins regardless of reveal order", function () {
      async function tieFixture() {
        const f = await auctionCreatedFixture();
        const aliceBid = await placeBid(f.auction, f.auctionId, f.alice, eth("2"), eth("2")); // seq 1
        const bobBid = await placeBid(f.auction, f.auctionId, f.bob, eth("2"), eth("3")); // seq 2
        await time.increaseTo(f.biddingEnd);
        return { ...f, aliceBid, bobBid };
      }

      it("larger seq revealed first, smaller seq revealed later → smaller seq becomes highest", async function () {
        const { auction, auctionId, alice, bob, aliceBid, bobBid } = await loadFixture(tieFixture);

        await revealBid(auction, auctionId, bobBid);
        expect((await auction.getAuction(auctionId)).highestBidder).to.equal(bob.address);

        await expect(revealBid(auction, auctionId, aliceBid))
          .to.emit(auction, "HighestBidUpdated")
          .withArgs(auctionId, alice.address, eth("2"));

        const a = await auction.getAuction(auctionId);
        expect(a.highestBidder).to.equal(alice.address);
        expect(a.highestBid).to.equal(eth("2"));
        expect(a.highestBidSeq).to.equal(1n);
        expect(await auction.pendingWithdrawals(bob.address)).to.equal(eth("3")); // 1 excess + 2 displaced
        expect(await auction.pendingWithdrawals(alice.address)).to.equal(0n);
      });

      it("smaller seq revealed first → the later tie does not replace it", async function () {
        const { auction, auctionId, alice, bob, aliceBid, bobBid } = await loadFixture(tieFixture);

        await revealBid(auction, auctionId, aliceBid);
        await expect(revealBid(auction, auctionId, bobBid)).not.to.emit(auction, "HighestBidUpdated");

        const a = await auction.getAuction(auctionId);
        expect(a.highestBidder).to.equal(alice.address);
        expect(a.highestBidSeq).to.equal(1n);
        expect(await auction.pendingWithdrawals(bob.address)).to.equal(eth("3"));
        expect(await auction.pendingWithdrawals(alice.address)).to.equal(0n);
      });
    });

    it("the same bidder's two valid bids becoming highest in turn are credited exactly", async function () {
      const { auction, auctionId, alice, bob, biddingEnd } = await loadFixture(auctionCreatedFixture);
      const a1 = await placeBid(auction, auctionId, alice, eth("2"), eth("3"));
      const a2 = await placeBid(auction, auctionId, alice, eth("4"), eth("5"));
      const b1 = await placeBid(auction, auctionId, bob, eth("5"), eth("5"));
      await time.increaseTo(biddingEnd);

      await revealBid(auction, auctionId, a1);
      // excess of a1: 3 - 2
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("1"));

      await expect(revealBid(auction, auctionId, a2))
        .to.emit(auction, "HighestBidUpdated")
        .withArgs(auctionId, alice.address, eth("4"));
      // + a1 displaced (2) + excess of a2 (5 - 4)
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("4"));
      let a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(alice.address);
      expect(a.highestBid).to.equal(eth("4"));
      expect(a.highestBidSeq).to.equal(2n); // a2 was the second commit overall

      await revealBid(auction, auctionId, b1);
      // + a2 displaced (4) → alice gets back all 8 ETH she deposited
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("8"));
      expect(await auction.pendingWithdrawals(bob.address)).to.equal(0n);
      a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(bob.address);
      expect(a.highestBid).to.equal(eth("5"));
    });
  });

  describe("balance invariant", function () {
    /**
     * contract ETH balance
     *   = sum of all pendingWithdrawals + current highest bid + deposits not yet revealed
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

      // The contract's counters agree with the test's own bookkeeping.
      expect(a.totalDeposits - a.revealedDeposits).to.equal(unrevealedSum);
      expect(balance).to.equal(pending + a.highestBid + unrevealedSum);
    }

    it("holds after every reveal (design.md 2.6 example + tie + invalid bids)", async function () {
      const { auction, auctionId, seller, alice, bob, carol, other, biddingEnd } =
        await loadFixture(auctionCreatedFixture);
      const accounts = [seller, alice, bob, carol, other];

      const aliceValid = await placeBid(auction, auctionId, alice, eth("3"), eth("5"));
      const bobFake = await placeBid(auction, auctionId, bob, eth("0"), eth("2"), true);
      const bobValid = await placeBid(auction, auctionId, bob, eth("4"), eth("4"));
      const carolHidden = await placeBid(auction, auctionId, carol, eth("2"), eth("2")); // never revealed
      const otherTie = await placeBid(auction, auctionId, other, eth("4"), eth("6")); // ties bob, later seq
      const aliceLow = await placeBid(auction, auctionId, alice, eth("0.5"), eth("1")); // valid but lower
      const carolShort = await placeBid(auction, auctionId, carol, eth("3"), eth("1")); // deposit < value

      const unrevealed = [aliceValid, bobFake, bobValid, carolHidden, otherTie, aliceLow, carolShort];
      await time.increaseTo(biddingEnd);
      await expectInvariant(auction, auctionId, accounts, unrevealed);

      const order = [aliceValid, bobFake, otherTie, bobValid, aliceLow, carolShort];
      for (const s of order) {
        await revealBid(auction, auctionId, s);
        unrevealed.splice(unrevealed.indexOf(s), 1);
        await expectInvariant(auction, auctionId, accounts, unrevealed);
      }

      // Final state: bob wins the tie against `other` with the earlier seq.
      const a = await auction.getAuction(auctionId);
      expect(a.highestBidder).to.equal(bob.address);
      expect(a.highestBid).to.equal(eth("4"));
      expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("6")); // 2 + 3 + 1
      expect(await auction.pendingWithdrawals(bob.address)).to.equal(eth("2")); // fake 2 + excess 0
      expect(await auction.pendingWithdrawals(other.address)).to.equal(eth("6")); // 2 + 4 displaced
      expect(await auction.pendingWithdrawals(carol.address)).to.equal(eth("1")); // short bid refund
      expect(unrevealed).to.deep.equal([carolHidden]); // 2 ETH to be forfeited at finalize
    });
  });
});
