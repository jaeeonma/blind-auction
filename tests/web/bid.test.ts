import { Wallet } from "ethers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { computeCommitment, findBid, keyFor, parseEthAmount, placeBid, revealFromStore } from "../../web/js/actions.js";
import { connect, type Chain } from "../../web/js/chain.js";
import { SecretStore, bidKey } from "../../web/js/secrets.js";
import { auctionTimes, commitment, createAuction, deployContracts, eth, mineAt, type Chain as TestChain } from "../helpers/chain.js";

// Bid and reveal from the browser (design.md 17번 B): the secret is saved in the browser before the
// bid is sent, and a reveal uses only what was saved. Same rules and messages as the scripts (12번).

/** localStorage stand-in. `failWrites` makes setItem throw like a full or blocked storage. */
class MemoryStorage {
  map = new Map<string, string>();
  failWrites = false;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe("web: bid and reveal with the browser's secret store", () => {
  let t: TestChain;
  let c: Chain;
  let storage: MemoryStorage;
  let store: SecretStore;
  let auctionId: bigint;

  const signer = (i: number) => c.provider.getSigner(i);
  const nonceOf = async (i: number) => c.provider.getTransactionCount(await (await signer(i)).getAddress());
  const toReveal = async () => mineAt(t, (await auctionTimes(t, auctionId)).biddingEnd);

  beforeEach(async () => {
    t = await deployContracts(inject("rpcUrl"));
    c = await connect(inject("rpcUrl"), {
      network: "localhost",
      chainId: 31337,
      blindAuction: t.auctionAddress,
      mockNft: await t.nft.getAddress(),
      deployBlock: t.deployBlock,
    });
    storage = new MemoryStorage();
    store = new SecretStore(storage);
    auctionId = await createAuction(t);
    return () => c.provider.destroy();
  });

  it("reads ETH amounts like the scripts (0 is allowed, design.md 4번)", () => {
    expect(parseEthAmount(" 0.5 ")).toBe(eth("0.5"));
    expect(parseEthAmount("0")).toBe(0n);
    expect(() => parseEthAmount("-1")).toThrow('알 수 없는 ETH 금액입니다 (예: 3, 0.5). 입력: "-1"');
    expect(() => parseEthAmount("1e18")).toThrow("알 수 없는 ETH 금액입니다");
  });

  it("uses the same key as the scripts' secret file name", () => {
    expect(bidKey({ chainId: 31337, contract: "0xABCdef", auctionId: 2n, bidder: "0xA1B2" })).toBe("31337-0xabcdef-2-0xa1b2");
  });

  it("saves value and secret before sending, with the commitment that is on chain", async () => {
    const s = await signer(1);
    const bidder = await s.getAddress();
    const r = await placeBid(c, s, store, auctionId, eth("5"), eth("6"));
    expect(r.replaced).toBe(false);
    expect(r.warnings).toEqual([]);

    const saved = store.load(keyFor(c, auctionId, bidder))!;
    expect(saved).toMatchObject({ chainId: 31337, contract: t.auctionAddress, auctionId: auctionId.toString(), bidder, value: eth("5").toString(), deposit: eth("6").toString() });
    expect(saved.secret).toMatch(/^0x[0-9a-f]{64}$/);
    // Same hash as the contract's encoding (the test helper mirrors BlindAuction.sol).
    expect(saved.commitment).toBe(commitment(eth("5"), saved.secret, bidder));
    expect(computeCommitment(eth("5"), saved.secret, bidder)).toBe(saved.commitment);
    const onChain = await findBid(c, auctionId, bidder);
    expect(onChain).toEqual({ commitment: saved.commitment, deposit: eth("6"), revealed: false });
  });

  it("warns when the deposit is below the value (the bid will be invalid)", async () => {
    const r = await placeBid(c, await signer(1), store, auctionId, eth("3"), eth("2"));
    expect(r.warnings).toEqual(["보증금이 입찰가보다 적어서 공개하면 무효 입찰이 되고 보증금만 돌려받습니다 (design.md 4번 Q3-1)."]);
  });

  it("keeps the saved secret when the send fails, and a retry replaces it", async () => {
    const s = await signer(1);
    const bidder = await s.getAddress();
    const key = keyFor(c, auctionId, bidder);
    // More than the account holds: the node refuses the transaction after the secret was saved.
    await expect(placeBid(c, s, store, auctionId, eth("1"), eth("1000000"))).rejects.toThrow();
    const first = store.load(key)!;
    expect(first.deposit).toBe(eth("1000000").toString());
    expect(await findBid(c, auctionId, bidder)).toBeNull();

    const r = await placeBid(c, s, store, auctionId, eth("1"), eth("2"));
    expect(r.replaced).toBe(true);
    const second = store.load(key)!;
    expect(second.secret).not.toBe(first.secret);
    expect((await findBid(c, auctionId, bidder))?.commitment).toBe(second.commitment);
  });

  it("does not send when the browser cannot save the secret", async () => {
    storage.failWrites = true;
    const before = await nonceOf(1);
    await expect(placeBid(c, await signer(1), store, auctionId, eth("1"), eth("1"))).rejects.toThrow(
      "브라우저 저장소에 secret을 저장하지 못해서 입찰을 보내지 않았습니다: QuotaExceededError",
    );
    expect(await nonceOf(1)).toBe(before);
  });

  it("refuses a second bid of the wallet without sending and keeps the saved secret", async () => {
    const s = await signer(1);
    const bidder = await s.getAddress();
    await placeBid(c, s, store, auctionId, eth("1"), eth("1"));
    const saved = store.load(keyFor(c, auctionId, bidder));
    const before = await nonceOf(1);
    await expect(placeBid(c, s, store, auctionId, eth("2"), eth("2"))).rejects.toThrow(
      `경매 ${auctionId}번에 이미 입찰한 지갑입니다 (지갑당 한 번, design.md 4번 Q10): ${bidder}`,
    );
    expect(await nonceOf(1)).toBe(before);
    expect(store.load(keyFor(c, auctionId, bidder))).toEqual(saved);
  });

  it("refuses a bid outside the bidding period and an unknown auction without sending", async () => {
    await toReveal();
    const before = await nonceOf(1);
    await expect(placeBid(c, await signer(1), store, auctionId, eth("1"), eth("1"))).rejects.toThrow(
      `경매 ${auctionId}번은 입찰 기간이 아닙니다 (현재: revealing)`,
    );
    await expect(placeBid(c, await signer(1), store, 99n, eth("1"), eth("1"))).rejects.toThrow("경매 99번이 없습니다");
    expect(await nonceOf(1)).toBe(before);
    expect(storage.length).toBe(0);
  });

  it("reveals with the saved value and secret", async () => {
    const s = await signer(1);
    await placeBid(c, s, store, auctionId, eth("5"), eth("6"));
    await toReveal();
    const r = await revealFromStore(c, s, store, auctionId);
    expect(r).toMatchObject({ value: eth("5"), valid: true });
    expect((await findBid(c, auctionId, await s.getAddress()))?.revealed).toBe(true);

    await expect(revealFromStore(c, s, store, auctionId)).rejects.toThrow(`경매 ${auctionId}번에서 이미 공개한 입찰입니다: ${await s.getAddress()}`);
  });

  it("refuses a reveal before the reveal period, without a bid, or without the saved secret", async () => {
    const s = await signer(1);
    await placeBid(c, s, store, auctionId, eth("5"), eth("6"));
    await expect(revealFromStore(c, s, store, auctionId)).rejects.toThrow(`경매 ${auctionId}번은 공개 기간이 아닙니다 (현재: bidding)`);
    await toReveal();

    const other = await signer(2);
    await expect(revealFromStore(c, other, store, auctionId)).rejects.toThrow(`경매 ${auctionId}번에 입찰하지 않은 지갑입니다: ${await other.getAddress()}`);

    const before = await nonceOf(1);
    await expect(revealFromStore(c, s, new SecretStore(new MemoryStorage()), auctionId)).rejects.toThrow(
      `이 브라우저에 경매 ${auctionId}번 입찰의 secret이 없습니다`,
    );
    expect(await nonceOf(1)).toBe(before);
  });

  it("refuses a damaged or altered saved secret without sending", async () => {
    const s = await signer(1);
    const key = keyFor(c, auctionId, await s.getAddress());
    await placeBid(c, s, store, auctionId, eth("5"), eth("6"));
    await toReveal();
    const original = storage.getItem(`blind-auction:bid:${key}`)!;
    const before = await nonceOf(1);

    storage.setItem(`blind-auction:bid:${key}`, "{not json");
    await expect(revealFromStore(c, s, store, auctionId)).rejects.toThrow("브라우저 저장소의 secret이 손상되었습니다");
    expect(store.list()).toEqual([]);

    storage.setItem(`blind-auction:bid:${key}`, JSON.stringify({ ...JSON.parse(original), secret: Wallet.createRandom().privateKey }));
    await expect(revealFromStore(c, s, store, auctionId)).rejects.toThrow(
      "저장된 secret이 체인의 입찰과 맞지 않습니다 (잘못되거나 손상된 값). 공개를 보내지 않았습니다",
    );
    expect(await nonceOf(1)).toBe(before);

    storage.setItem(`blind-auction:bid:${key}`, original);
    await expect(revealFromStore(c, s, store, auctionId)).resolves.toMatchObject({ valid: true });
  });

  it("lists and exports every saved bid, newest first", async () => {
    await placeBid(c, await signer(1), store, auctionId, eth("1"), eth("1"));
    await placeBid(c, await signer(2), store, auctionId, eth("2"), eth("2"));
    storage.setItem("blind-auction:account", "2"); // other settings are not bids
    const list = store.list();
    expect(list.map((b) => b.value)).toEqual([eth("2").toString(), eth("1").toString()]);
    expect(JSON.parse(store.exportJson())).toEqual(list);
  });
});
