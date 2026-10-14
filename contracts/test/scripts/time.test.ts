import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { phaseOf } from "../../scripts/lib/bid";
import { increaseTime, latestBlockTime, moveTimeTo } from "../../scripts/lib/time";
import { auctionCreatedFixture } from "../fixtures";

describe("scripts: time-travel (design.md 12번)", function () {
  it("increaseTime moves block time forward by at least the given seconds", async function () {
    await loadFixture(auctionCreatedFixture);
    const before = BigInt(await time.latest());
    const after = await increaseTime(ethers.provider, 600n);
    // Hardhat adds the offset to the wall clock, so real seconds that passed are included too.
    expect(after >= before + 600n && after <= before + 610n, `moved to +${after - before}s`).to.equal(true);
    expect(await latestBlockTime(ethers.provider)).to.equal(after);
    await expect(increaseTime(ethers.provider, 0n)).to.be.rejectedWith("Seconds must be positive");
  });

  it("moveTimeTo lands exactly on bidding end and reveal end, so the phase changes right there", async function () {
    const { auction, auctionId, biddingEnd, revealEnd } = await loadFixture(auctionCreatedFixture);
    expect(await phaseOf(auction, auctionId)).to.equal("bidding");

    expect(await moveTimeTo(ethers.provider, biddingEnd)).to.deep.equal({ moved: true, time: biddingEnd });
    expect(await phaseOf(auction, auctionId)).to.equal("revealing");

    expect(await moveTimeTo(ethers.provider, revealEnd)).to.deep.equal({ moved: true, time: revealEnd });
    expect(await phaseOf(auction, auctionId)).to.equal("awaiting_finalize");
  });

  it("never moves time backwards", async function () {
    const { biddingEnd } = await loadFixture(auctionCreatedFixture);
    await time.increaseTo(biddingEnd + 100n);
    const blockBefore = await ethers.provider.getBlockNumber();

    expect(await moveTimeTo(ethers.provider, biddingEnd)).to.deep.equal({ moved: false, time: biddingEnd + 100n });
    expect(await ethers.provider.getBlockNumber()).to.equal(blockBefore); // no block mined
  });
});
