import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAuction, mintNft } from "../../scripts/lib/auction";
import { placeBid, revealFromFile } from "../../scripts/lib/bid";
import { EXAMPLE, runExample, type DemoAccounts } from "../../scripts/lib/demo";
import { deployFixture } from "../fixtures";

const eth = (v: string) => ethers.parseEther(v);
const NONE = { seller: 0n, A: 0n, B: 0n, C: 0n, D: 0n };

describe("scripts: demo (design.md 7번 example)", function () {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bids-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup() {
    const f = await deployFixture(); // accounts 0-4: seller, alice (A), bob (B), carol (C), other (D)
    const accounts: DemoAccounts = { seller: f.seller, bidders: [f.alice, f.bob, f.carol, f.other] };
    const lines: string[] = [];
    const run = () => runExample(f.auction, f.nft, ethers.provider, accounts, { bidsDir: dir, log: (l) => lines.push(l) });
    return { ...f, accounts, lines, run };
  }

  it("runs the example twice in a row: new NFT and auction each time, same numbers each time", async function () {
    const { run, lines } = await loadFixture(setup);

    const first = await run();
    const second = await run();

    expect([first.auctionId, second.auctionId]).to.deep.equal([0n, 1n]);
    expect(second.tokenId).to.not.equal(first.tokenId);
    for (const r of [first, second]) {
      expect(r.leftover).to.deep.equal(NONE);
      expect(r.ledger).to.deep.equal(EXAMPLE.ledger);
      expect(r.withdrawn).to.deep.equal({ seller: eth("7"), A: eth("5"), B: 0n, C: eth("2"), D: 0n });
    }
    expect(lines.filter((l) => l.includes("모든 검사 통과"))).to.have.length(2);
    expect(lines.some((l) => l.includes("남은 장부") || l.includes("이전에 남은 금액"))).to.equal(false);
  });

  it("keeps a ledger left over from an earlier auction apart and shows it separately", async function () {
    const f = await loadFixture(setup);
    const { auction, nft, seller, alice, carol } = f;

    // An earlier auction where A's invalid bid was revealed but A never withdrew → 1 ETH left on A's ledger.
    // C's bid in it is never revealed or finalized, so that auction still holds C's deposit in the contract.
    const tokenId = await mintNft(nft, seller.address);
    const earlier = await createAuction(auction, nft, seller, tokenId, 600n, 86400n);
    await placeBid(auction.connect(alice), alice, earlier.auctionId, eth("2"), eth("1"), dir); // invalid
    await placeBid(auction.connect(carol), carol, earlier.auctionId, eth("1"), eth("1"), dir);
    await time.increaseTo(earlier.biddingEnd);
    await revealFromFile(auction.connect(alice), alice, earlier.auctionId, dir);
    expect(await auction.pendingWithdrawals(alice.address)).to.equal(eth("1"));
    const otherAuctionHeld = eth("1"); // C's deposit, still in the contract

    const r = await f.run();

    expect(r.leftover).to.deep.equal({ ...NONE, A: eth("1") });
    expect(r.ledger).to.deep.equal(EXAMPLE.ledger); // this auction's numbers are unaffected
    expect(r.withdrawn.A).to.equal(eth("6")); // 5 from this auction + 1 left over
    expect(f.lines).to.include.members([
      "이전 경매에서 출금하지 않고 남은 장부 (이번 demo와 따로 보고, 출금할 때 함께 나감):",
    ]);
    expect(f.lines.some((l) => l.includes("출금 6.0 ETH (이번 경매 5.0 ETH + 이전에 남은 금액 1.0 ETH)"))).to.equal(true);
    // The contract still holds the other auction's money, and only that.
    expect(await ethers.provider.getBalance(await auction.getAddress())).to.equal(otherAuctionHeld);
  });
});
