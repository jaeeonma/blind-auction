import { beforeEach, describe, expect, inject, it } from "vitest";
import { mintNft, placeBid, revealFromStore, withdrawAll, finalizeAuction, moveTimeTo, auctionEnds } from "../../web/js/actions.js";
import { connect, testAccounts, type Chain } from "../../web/js/chain.js";
import { ROLES, cardFor, currentAuctionId, guide, loadStage, startAuction, type Person, type Stage } from "../../web/js/demo.js";
import { SecretStore } from "../../web/js/secrets.js";
import { deployContracts, eth, type Chain as TestChain } from "../helpers/chain.js";

// 경매 진행 화면 (design.md 17번 B): what to do next, which button each card shows and why it is off,
// the state read from the chain, and "새 경매 시작".

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

/** A person for the pure tests. */
const person = (index: number, extra: Partial<Person> = {}): Person => ({
  role: ROLES[index]!,
  address: `0x${String(index).repeat(40)}`,
  balance: eth("10000"),
  pending: 0n,
  bid: null,
  saved: null,
  savedError: "",
  ...extra,
});
const stage = (phase: string, people: Person[] = ROLES.map((r) => person(r.index)), storeAvailable = true): Stage => ({
  auctionId: phase === "none" ? null : 0n,
  phase,
  storeAvailable,
  people,
});
const bidOf = (deposit: string, revealed = false) => ({ commitment: "0x" + "ab".repeat(32), deposit: eth(deposit), revealed });

describe("web: 경매 진행 화면 (pure)", () => {
  it("prefills the design.md 7번 example and marks D as the one who does not reveal", () => {
    expect(ROLES.map((r) => [r.name, r.value, r.deposit])).toEqual([
      ["판매자", "", ""],
      ["A", "3", "5"],
      ["B", "4", "4"],
      ["C", "3", "2"],
      ["D", "1", "3"],
    ]);
    expect(ROLES[4]!.note).toContain("공개하지 않음");
  });

  it("tells what to do next and which time button to show, phase by phase", () => {
    expect(guide(stage("none"))).toEqual({ text: '아직 경매가 없습니다. "새 경매 시작"을 누르세요.', move: null, moveLabel: "" });

    const twoBids = stage("bidding", [person(0), person(1, { bid: bidOf("5") }), person(2, { bid: bidOf("4") }), person(3), person(4)]);
    expect(guide(twoBids)).toEqual({
      text: 'A~D가 카드에서 입찰합니다 (2/4명 입찰함). 다 입찰했으면 "입찰 마감으로"를 누르세요.',
      move: "reveal",
      moveLabel: "입찰 마감으로",
    });

    const oneRevealed = stage("revealing", [person(0), person(1, { bid: bidOf("5", true) }), person(2, { bid: bidOf("4") }), person(3), person(4)]);
    expect(guide(oneRevealed)).toMatchObject({ move: "end", moveLabel: "공개 마감으로" });
    expect(guide(oneRevealed).text).toContain("(1/2명 공개함)");

    expect(guide(stage("awaiting_finalize"))).toMatchObject({ move: null });
    expect(guide(stage("awaiting_finalize")).text).toContain('"종료"');
    expect(guide(stage("finalized")).text).toContain('"새 경매 시작"');
  });

  it("bidding: a bid button, off with the reason when the wallet already bid or nothing can be saved", () => {
    expect(cardFor(person(1), stage("bidding"))).toEqual({ status: "", action: { kind: "bid", label: "입찰", reason: "" }, withdraw: null });
    expect(cardFor(person(1, { bid: bidOf("5") }), stage("bidding")).action?.reason).toBe("이미 입찰했습니다 (지갑당 한 번)");
    expect(cardFor(person(1), stage("bidding", undefined, false)).action?.reason).toBe(
      "브라우저 저장소를 쓸 수 없어 secret을 저장할 곳이 없습니다",
    );
    // The seller does not bid in the example: no button, a status line instead.
    expect(cardFor(person(0), stage("bidding"))).toEqual({
      status: "입찰을 기다리는 중 (이 예시에서 판매자는 입찰하지 않음)",
      action: null,
      withdraw: null,
    });
  });

  it("revealing: a reveal button, off with the reason", () => {
    const saved = { value: eth("3").toString() } as Person["saved"];
    const reason = (p: Person) => cardFor(p, stage("revealing")).action?.reason;
    expect(reason(person(1, { bid: bidOf("5"), saved }))).toBe("");
    expect(reason(person(1))).toBe("입찰하지 않아서 공개할 것이 없습니다");
    expect(reason(person(1, { bid: bidOf("5", true), saved }))).toBe("이미 공개했습니다");
    expect(reason(person(1, { bid: bidOf("5") }))).toBe("이 브라우저에 secret이 없습니다 (아래 가져오기로 넣을 수 있음)");
    expect(reason(person(1, { bid: bidOf("5"), savedError: "손상" }))).toBe("이 브라우저에 저장된 secret이 손상되었습니다");
    expect(cardFor(person(1, { bid: bidOf("5"), saved }), stage("revealing")).status).toBe("입찰함 · 보증금 5 ETH · 이 브라우저에 저장된 입찰가 3 ETH");
    expect(cardFor(person(0), stage("revealing")).action).toBeNull();
  });

  it("awaiting finalize: everyone gets 종료; finalized: 출금, off when the ledger is empty", () => {
    for (const i of [0, 1, 4]) expect(cardFor(person(i), stage("awaiting_finalize")).action).toEqual({ kind: "finalize", label: "종료", reason: "" });
    expect(cardFor(person(0, { pending: eth("7") }), stage("finalized")).action).toEqual({ kind: "withdraw", label: "출금", reason: "" });
    expect(cardFor(person(2), stage("finalized")).action?.reason).toBe("장부에 받을 돈이 없습니다");
    expect(cardFor(person(1), stage("none")).action).toBeNull();
    // An unrevealed bid is shown as forfeited (design.md 4번 Q4), the revealed one as revealed.
    expect(cardFor(person(4, { bid: bidOf("3") }), stage("awaiting_finalize")).status).toBe("공개하지 않음 · 보증금 3 ETH는 종료하면 판매자에게 몰수");
    expect(cardFor(person(4, { bid: bidOf("3") }), stage("finalized")).status).toBe("공개하지 않아 보증금 3 ETH 몰수");
    expect(cardFor(person(1, { bid: bidOf("5", true) }), stage("finalized")).status).toBe("공개함 · 보증금 5 ETH");
  });

  it("shows 출금 in every phase while the ledger has money (withdraw is allowed any time, design.md 6번)", () => {
    const withdraw = { kind: "withdraw", label: "출금", reason: "" };
    // Money left from an earlier auction: 출금 sits next to the phase's own button, or alone.
    for (const phase of ["none", "bidding", "revealing", "awaiting_finalize"]) {
      for (const i of [0, 1]) {
        const card = cardFor(person(i, { pending: eth("7") }), stage(phase));
        expect(card.withdraw, `${phase}, card ${i}`).toEqual(withdraw);
      }
    }
    // The phase's button stays as it was.
    expect(cardFor(person(1, { pending: eth("2") }), stage("bidding")).action).toEqual({ kind: "bid", label: "입찰", reason: "" });
    expect(cardFor(person(0, { pending: eth("2") }), stage("bidding")).action).toBeNull();
    // Finalized: 출금 is the phase's button itself, not a second one.
    expect(cardFor(person(1, { pending: eth("5") }), stage("finalized"))).toMatchObject({ action: withdraw, withdraw: null });
    // An empty ledger adds nothing before the end (the finalized 출금 says why it is off, as before).
    for (const phase of ["none", "bidding", "revealing", "awaiting_finalize", "finalized"]) {
      expect(cardFor(person(1), stage(phase)).withdraw, phase).toBeNull();
    }
  });
});

describe("web: 경매 진행 화면 on the test node", () => {
  let t: TestChain;
  let c: Chain;
  let store: SecretStore;
  let addresses: string[];

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
    addresses = (await testAccounts(c.provider, 5)).map((a) => a.address);
    return () => c.provider.destroy();
  });

  it("starts with no auction, then 새 경매 시작 mints only when the seller has no unused NFT", async () => {
    const seller = await c.provider.getSigner(0);
    expect(await currentAuctionId(c)).toBeNull();
    expect((await loadStage(c, store, addresses)).phase).toBe("none");

    const first = await startAuction(c, seller);
    expect(first).toMatchObject({ auctionId: 0n, minted: true });
    expect(first.revealEnd - first.biddingEnd).toBe(86400n);
    expect(await currentAuctionId(c)).toBe(0n);

    // An NFT left over (e.g. a create that failed after the mint) is used instead of minting again.
    const { tokenId } = await mintNft(c, seller);
    const second = await startAuction(c, seller);
    expect(second).toMatchObject({ auctionId: 1n, tokenId, minted: false });
    expect(await currentAuctionId(c)).toBe(1n);
  });

  it("reads the phase and each account's bid, saved secret and ledger through the example", async () => {
    const signer = (i: number) => c.provider.getSigner(i);
    const { auctionId } = await startAuction(c, await signer(0));
    await placeBid(c, await signer(1), store, auctionId, eth("3"), eth("5"));
    await placeBid(c, await signer(4), store, auctionId, eth("1"), eth("3"));

    let s = await loadStage(c, store, addresses);
    expect(s.phase).toBe("bidding");
    expect(s.people.map((p) => Boolean(p.bid))).toEqual([false, true, false, false, true]);
    expect(s.people[1]!.saved?.value).toBe(eth("3").toString());
    expect(guide(s).text).toContain("(2/4명 입찰함)");

    const { biddingEnd, revealEnd } = await auctionEnds(c, auctionId);
    await moveTimeTo(c, biddingEnd);
    await revealFromStore(c, await signer(1), store, auctionId);
    await moveTimeTo(c, revealEnd);
    await finalizeAuction(c, await signer(4), auctionId);

    s = await loadStage(c, store, addresses);
    expect(s.phase).toBe("finalized");
    // A won at 3 with a deposit of 5: 2 back to A; the seller gets 3 plus D's forfeited 3.
    expect(s.people.map((p) => p.pending)).toEqual([eth("6"), eth("2"), 0n, 0n, 0n]);
    expect(cardFor(s.people[2]!, s).action?.reason).toBe("장부에 받을 돈이 없습니다");
    await withdrawAll(c, await signer(0));
    expect((await loadStage(c, store, addresses)).people[0]!.pending).toBe(0n);
  });

  it("after 새 경매 시작 without withdrawing, the ledger from the earlier auction can still be paid out", async () => {
    const signer = (i: number) => c.provider.getSigner(i);
    const first = await startAuction(c, await signer(0));
    await placeBid(c, await signer(1), store, first.auctionId, eth("3"), eth("5"));
    await moveTimeTo(c, first.biddingEnd);
    await revealFromStore(c, await signer(1), store, first.auctionId);
    await moveTimeTo(c, first.revealEnd);
    await finalizeAuction(c, await signer(1), first.auctionId);

    // Nobody withdrew; the next auction starts and is in its bidding phase.
    await startAuction(c, await signer(0));
    const s = await loadStage(c, store, addresses);
    expect(s.phase).toBe("bidding");
    expect(s.people.map((p) => p.pending)).toEqual([eth("3"), eth("2"), 0n, 0n, 0n]);
    expect(cardFor(s.people[0]!, s)).toMatchObject({ action: null, withdraw: { kind: "withdraw", reason: "" } });
    expect(cardFor(s.people[1]!, s)).toMatchObject({ action: { kind: "bid", reason: "" }, withdraw: { kind: "withdraw", reason: "" } });
    expect(cardFor(s.people[2]!, s).withdraw).toBeNull();

    await withdrawAll(c, await signer(0));
    await withdrawAll(c, await signer(1));
    const after = await loadStage(c, store, addresses);
    expect(after.people.every((p) => p.pending === 0n && cardFor(p, after).withdraw === null)).toBe(true);
  });
});
