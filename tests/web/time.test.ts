import { beforeEach, describe, expect, inject, it } from "vitest";
import { auctionEnds, latestBlockTime, moveTimeTo, phaseOf } from "../../web/js/actions.js";
import { connect, type Chain } from "../../web/js/chain.js";
import { createAuction, deployContracts, type Chain as TestChain } from "../helpers/chain.js";

// Demo time buttons (design.md 17번 B): move the local node's block time to an auction's end.

describe("web: demo time on the local node", () => {
  let t: TestChain;
  let c: Chain;
  let auctionId: bigint;

  beforeEach(async () => {
    t = await deployContracts(inject("rpcUrl"));
    c = await connect(inject("rpcUrl"), {
      network: "localhost",
      chainId: 31337,
      blindAuction: t.auctionAddress,
      mockNft: await t.nft.getAddress(),
      deployBlock: t.deployBlock,
    });
    auctionId = await createAuction(t);
    return () => c.provider.destroy();
  });

  it("moves block time exactly to the bidding end, then to the reveal end", async () => {
    const { biddingEnd, revealEnd } = await auctionEnds(c, auctionId);
    const r = await moveTimeTo(c, biddingEnd);
    expect(r).toMatchObject({ moved: true, time: biddingEnd });
    expect(r.blockNumber).toBe(await c.provider.getBlockNumber());
    expect(await phaseOf(c, auctionId)).toBe("revealing");

    expect(await moveTimeTo(c, revealEnd)).toMatchObject({ moved: true, time: revealEnd });
    expect(await phaseOf(c, auctionId)).toBe("awaiting_finalize");
  });

  it("never moves time backwards", async () => {
    const { biddingEnd } = await auctionEnds(c, auctionId);
    await moveTimeTo(c, biddingEnd + 100n);
    const block = await c.provider.getBlockNumber();
    const r = await moveTimeTo(c, biddingEnd);
    expect(r.moved).toBe(false);
    expect(r.time).toBe(await latestBlockTime(c));
    expect(await c.provider.getBlockNumber()).toBe(block);
  });
});
