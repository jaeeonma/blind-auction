import { hexlify, randomBytes } from "ethers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { importBids, keyFor, revealFromStore } from "../../web/js/actions.js";
import { connect, type Chain } from "../../web/js/chain.js";
import { SecretStore } from "../../web/js/secrets.js";
import { auctionTimes, commitment, createAuction, deployContracts, eth, mineAt, type Chain as TestChain } from "../helpers/chain.js";

// (선택, design.md 17번) Import the scripts' .bids/ files or this page's export, then reveal in the browser.

class MemoryStorage {
  map = new Map<string, string>();
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
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe("web: import saved bids", () => {
  let t: TestChain;
  let c: Chain;
  let store: SecretStore;
  let auctionId: bigint;

  /** A bid sent like `npm run bid`, and its secret file as the script writes it (bid-files.ts). */
  async function scriptBid(i: number, value: bigint, deposit: bigint) {
    const signer = await c.provider.getSigner(i);
    const bidder = await signer.getAddress();
    const secret = hexlify(randomBytes(32));
    const hash = commitment(value, secret, bidder);
    await (await (t.auction.connect(signer) as typeof t.auction).getFunction("bid")(auctionId, hash, { value: deposit })).wait();
    const file = { chainId: 31337, contract: t.auctionAddress, auctionId: auctionId.toString(), bidder, value: value.toString(), secret, deposit: deposit.toString(), commitment: hash, createdAt: new Date().toISOString() };
    return { signer, file, name: `31337-${t.auctionAddress.toLowerCase()}-${auctionId}-${bidder.toLowerCase()}.json`, text: JSON.stringify(file, null, 2) + "\n" };
  }

  beforeEach(async () => {
    t = await deployContracts(inject("rpcUrl"));
    c = await connect(inject("rpcUrl"), {
      network: "localhost",
      chainId: 31337,
      blindAuction: t.auctionAddress,
      mockNft: await t.nft.getAddress(),
      deployBlock: t.deployBlock,
    });
    store = new SecretStore(new MemoryStorage());
    auctionId = await createAuction(t);
    return () => c.provider.destroy();
  });

  it("imports a script's secret file and reveals with it", async () => {
    const a = await scriptBid(1, eth("3"), eth("5"));
    const r = importBids(c, store, [{ name: a.name, text: a.text }]);
    expect(r).toEqual({ added: [`${a.name}: 경매 ${auctionId}번 (입찰자 ${a.file.bidder})`], skipped: [] });
    await mineAt(t, (await auctionTimes(t, auctionId)).biddingEnd);
    await expect(revealFromStore(c, a.signer, store, auctionId)).resolves.toMatchObject({ value: eth("3"), valid: true });
  });

  it("imports this page's export (a list) and skips what is already there", async () => {
    const a = await scriptBid(1, eth("3"), eth("5"));
    const b = await scriptBid(2, eth("4"), eth("4"));
    const exported = JSON.stringify([a.file, b.file]);
    expect(importBids(c, store, [{ name: "backup.json", text: exported }]).added).toHaveLength(2);
    expect(importBids(c, store, [{ name: "backup.json", text: exported }])).toEqual({
      added: [],
      skipped: [`backup.json: 경매 ${auctionId}번: 이미 저장되어 있습니다`, `backup.json: 경매 ${auctionId}번: 이미 저장되어 있습니다`],
    });
  });

  it("never overwrites a different saved value, and refuses damaged or foreign files", async () => {
    const a = await scriptBid(1, eth("3"), eth("5"));
    const other = { ...a.file, value: eth("9").toString(), commitment: commitment(eth("9"), a.file.secret, a.file.bidder) };
    importBids(c, store, [{ name: "a.json", text: a.text }]);
    const r = importBids(c, store, [
      { name: "other.json", text: JSON.stringify(other) },
      { name: "tampered.json", text: JSON.stringify({ ...a.file, value: eth("1").toString() }) },
      { name: "old-node.json", text: JSON.stringify({ ...a.file, contract: "0x" + "11".repeat(20) }) },
      { name: "notes.txt", text: "hello" },
      { name: "wrong.json", text: JSON.stringify({ hello: 1 }) },
    ]);
    expect(r.added).toEqual([]);
    expect(r.skipped).toEqual([
      `other.json: 경매 ${auctionId}번: 이 브라우저에 다른 값이 저장되어 있어 덮어쓰지 않았습니다`,
      `tampered.json: 경매 ${auctionId}번: 입찰가와 secret이 해시와 맞지 않습니다 (손상된 파일)`,
      `old-node.json: 경매 ${auctionId}번: 지금 노드의 컨트랙트가 아닌 입찰입니다 (노드를 다시 켜기 전의 입찰일 수 있음). 컨트랙트: 0x${"11".repeat(20)}`,
      "notes.txt: JSON 파일이 아닙니다",
      "wrong.json: 경매 ?번: secret 파일 형식이 아닙니다",
    ]);
    expect(store.load(keyFor(c, auctionId, a.file.bidder))?.value).toBe(eth("3").toString());
  });
});
