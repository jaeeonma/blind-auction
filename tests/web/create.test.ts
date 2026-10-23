import { beforeEach, describe, expect, inject, it } from "vitest";
import { createAuction, finalizeAuction, mintNft, ownedTokens, parseDuration, phaseOf } from "../../web/js/actions.js";
import { connect, type Chain } from "../../web/js/chain.js";
import { auctionTimes, deployContracts, eth, mineAt, placeBid, revealBid, type Chain as TestChain } from "../helpers/chain.js";

// Create (with the test NFT) and finalize from the browser (design.md 17번 B). Same checks and
// messages as the scripts (design.md 12번); refused cases send no transaction.

const TEN_MINUTES = 600n;
const ONE_DAY = 86400n;

describe("web: create and finalize an auction", () => {
  let t: TestChain;
  let c: Chain;

  const signer = (i: number) => c.provider.getSigner(i);
  const nonceOf = async (i: number) => c.provider.getTransactionCount(await (await signer(i)).getAddress());

  beforeEach(async () => {
    t = await deployContracts(inject("rpcUrl"));
    c = await connect(inject("rpcUrl"), {
      network: "localhost",
      chainId: 31337,
      blindAuction: t.auctionAddress,
      mockNft: await t.nft.getAddress(),
      deployBlock: t.deployBlock,
    });
    return () => c.provider.destroy();
  });

  it("reads durations like the scripts", () => {
    expect(parseDuration("10m")).toBe(600n);
    expect(parseDuration(" 1d ")).toBe(86400n);
    expect(parseDuration("90")).toBe(90n);
    expect(() => parseDuration("1w")).toThrow('알 수 없는 기간입니다. 숫자 뒤에 s, m, h, d를 붙이세요 (예: 10m, 1d). 입력: "1w"');
  });

  it("mints a test NFT to the account and lists the tokens it owns", async () => {
    const s = await signer(2);
    const a = await mintNft(c, s);
    const b = await mintNft(c, s);
    await mintNft(c, await signer(3));
    expect(b.tokenId).toBe(a.tokenId + 1n);
    expect(await ownedTokens(c, await s.getAddress())).toEqual([a.tokenId, b.tokenId]);
  });

  it("approves and creates the auction; a second create of the token is refused without sending", async () => {
    const s = await signer(2);
    const { tokenId } = await mintNft(c, s);
    const r = await createAuction(c, s, tokenId, TEN_MINUTES, ONE_DAY);
    expect(r.approved).toBe(true);
    expect(r.auctionId).toBe(0n);
    expect(r.revealEnd - r.biddingEnd).toBe(ONE_DAY);
    expect(await phaseOf(c, r.auctionId)).toBe("bidding");
    expect(await ownedTokens(c, await s.getAddress())).toEqual([]);

    const before = await nonceOf(2);
    await expect(createAuction(c, s, tokenId, TEN_MINUTES, ONE_DAY)).rejects.toThrow(
      `토큰 ${tokenId}번은 이미 경매 중입니다 (경매 컨트랙트가 보관하고 있음)`,
    );
    expect(await nonceOf(2)).toBe(before);
  });

  it("refuses a token of someone else, an unknown token and out-of-range durations without sending", async () => {
    const owner = await signer(2);
    const other = await signer(3);
    const { tokenId } = await mintNft(c, owner);
    const before = [await nonceOf(2), await nonceOf(3)];

    await expect(createAuction(c, other, tokenId, TEN_MINUTES, ONE_DAY)).rejects.toThrow(
      `토큰 ${tokenId}번의 주인이 아닙니다. 주인: ${await owner.getAddress()}, 호출한 계정: ${await other.getAddress()}`,
    );
    await expect(createAuction(c, owner, 99n, TEN_MINUTES, ONE_DAY)).rejects.toThrow("토큰 99번이 없습니다");
    await expect(createAuction(c, owner, tokenId, TEN_MINUTES - 1n, ONE_DAY)).rejects.toThrow(
      "입찰 기간은 600~432000초(10m~5d) 사이여야 합니다. 입력: 599초",
    );
    await expect(createAuction(c, owner, tokenId, TEN_MINUTES, 3n * ONE_DAY)).rejects.toThrow(
      "공개 기간은 86400~172800초(1d~2d) 사이여야 합니다. 입력: 259200초",
    );
    expect([await nonceOf(2), await nonceOf(3)]).toEqual(before);
  });

  it("finalize: refused before the reveal end, then anyone can finalize once", async () => {
    const s = await signer(2);
    const { tokenId } = await mintNft(c, s);
    const { auctionId } = await createAuction(c, s, tokenId, TEN_MINUTES, ONE_DAY);
    const bid = await placeBid(t, auctionId, t.bidders[0], eth("5"), eth("6"));
    const { biddingEnd, revealEnd } = await auctionTimes(t, auctionId);
    await mineAt(t, biddingEnd);
    await revealBid(t, auctionId, bid);

    const anyone = await signer(5);
    const before = await nonceOf(5);
    await expect(finalizeAuction(c, anyone, auctionId)).rejects.toThrow(
      `경매 ${auctionId}번은 아직 종료할 수 없습니다 (현재: revealing). 공개 마감: ${new Date(Number(revealEnd) * 1000).toISOString()} (${revealEnd})`,
    );
    expect(await nonceOf(5)).toBe(before);

    await mineAt(t, revealEnd);
    const r = await finalizeAuction(c, anyone, auctionId);
    expect(r).toMatchObject({ winner: await t.bidders[0].getAddress(), winningBid: eth("5"), forfeited: 0n });
    await expect(finalizeAuction(c, anyone, auctionId)).rejects.toThrow(`경매 ${auctionId}번은 이미 종료됐습니다`);
  });

  it("finalize without a valid bid reports no winner", async () => {
    const s = await signer(2);
    const { tokenId } = await mintNft(c, s);
    const { auctionId } = await createAuction(c, s, tokenId, TEN_MINUTES, ONE_DAY);
    await placeBid(t, auctionId, t.bidders[0], eth("5"), eth("6")); // never revealed: forfeited
    await mineAt(t, (await auctionTimes(t, auctionId)).revealEnd);
    expect(await finalizeAuction(c, s, auctionId)).toMatchObject({ winner: null, winningBid: 0n, forfeited: eth("6") });
    expect(await ownedTokens(c, await s.getAddress())).toEqual([tokenId]);
  });
});
