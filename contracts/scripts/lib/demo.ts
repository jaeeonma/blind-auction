import { formatEther, parseEther, type Signer } from "ethers";
import type { BlindAuction, MockNFT } from "../../typechain-types";
import { createAuction, mintNft } from "./auction";
import { placeBid, revealFromFile } from "./bid";
import { bidsDir } from "./bid-files";
import { finalizeAuction, withdrawAll } from "./settle";
import { moveTimeTo, type DevProvider } from "./time";

// 시연 전체 실행 (design.md 12번): the design.md 7번 example, using the same functions as the
// individual scripts. Every run mints a new NFT and creates a new auction.
//
// | bidder | deposit | value  | result          | ledger |
// | A      | 5       | 3      | displaced by B  | 5      |
// | B      | 4       | 4      | wins            | 0      |
// | C      | 2       | 3      | invalid         | 2      |
// | D      | 3       | hidden | forfeited       | -      |
// | seller |         |        |                 | 4 + 3  |

const eth = (v: string) => parseEther(v);
const fmt = (wei: bigint) => `${formatEther(wei)} ETH`;

export const EXAMPLE = {
  bids: [
    { name: "A", value: eth("3"), deposit: eth("5"), reveal: true },
    { name: "B", value: eth("4"), deposit: eth("4"), reveal: true },
    { name: "C", value: eth("3"), deposit: eth("2"), reveal: true },
    { name: "D", value: eth("1"), deposit: eth("3"), reveal: false },
  ],
  /** Ledger credited by THIS auction (design.md 7번). */
  ledger: { seller: eth("7"), A: eth("5"), B: 0n, C: eth("2"), D: 0n } as Record<string, bigint>,
  winner: "B",
  winningBid: eth("4"),
  forfeited: eth("3"),
  totalDeposits: eth("14"),
} as const;

export interface DemoAccounts {
  seller: Signer;
  /** A, B, C, D */
  bidders: [Signer, Signer, Signer, Signer];
}

export interface DemoResult {
  auctionId: bigint;
  tokenId: bigint;
  /** Ledger left over from earlier auctions, per name (not part of this auction). */
  leftover: Record<string, bigint>;
  /** Ledger credited by this auction, per name. */
  ledger: Record<string, bigint>;
  /** Paid out by withdraw, per name (= leftover + ledger). */
  withdrawn: Record<string, bigint>;
}

class DemoCheckFailed extends Error {}

function check(ok: boolean, what: string) {
  if (!ok) throw new DemoCheckFailed(`demo check failed: ${what}`);
}

export async function runExample(
  auction: BlindAuction,
  nft: MockNFT,
  provider: DevProvider & { getBalance(address: string): Promise<bigint> },
  accounts: DemoAccounts,
  options: { bidsDir?: string; log?: (line: string) => void } = {},
): Promise<DemoResult> {
  const log = options.log ?? console.log;
  const dir = options.bidsDir ?? bidsDir();
  const as = (s: Signer) => auction.connect(s) as BlindAuction;
  const named: Array<[string, Signer]> = [
    ["seller", accounts.seller],
    ...EXAMPLE.bids.map((b, i) => [b.name, accounts.bidders[i]!] as [string, Signer]),
  ];
  const addresses = Object.fromEntries(await Promise.all(named.map(async ([n, s]) => [n, await s.getAddress()])));
  const pendingOf = async () =>
    Object.fromEntries(
      await Promise.all(named.map(async ([n]) => [n, await auction.pendingWithdrawals(addresses[n]!)] as const)),
    ) as Record<string, bigint>;

  // The ledger is per wallet, not per auction: money an earlier auction credited and nobody withdrew
  // sits in the same slot. Record it first so this auction's numbers can be told apart.
  const leftover = await pendingOf();
  const leftoverNames = Object.keys(leftover).filter((n) => leftover[n]! > 0n);
  if (leftoverNames.length > 0) {
    log("Ledger left over from earlier auctions (kept apart from this demo, paid out together at withdraw):");
    for (const n of leftoverNames) log(`  ${n.padEnd(6)} ${fmt(leftover[n]!)}`);
  }
  const contractAddress = await auction.getAddress();
  const balanceBefore = await provider.getBalance(contractAddress);

  log("\n1. Create: mint a new NFT and open a new auction (bidding 10m, reveal 1d)");
  const sellerNft = nft.connect(accounts.seller) as MockNFT;
  const tokenId = await mintNft(sellerNft, addresses.seller!);
  const created = await createAuction(as(accounts.seller), sellerNft, accounts.seller, tokenId, 600n, 86400n);
  const auctionId = created.auctionId;
  log(`   token ${tokenId} → auction ${auctionId}`);

  log("2. Bid: A, B, C, D (value and secret saved before each bid is sent)");
  for (const [i, b] of EXAMPLE.bids.entries()) {
    const signer = accounts.bidders[i]!;
    await placeBid(as(signer), signer, auctionId, b.value, b.deposit, dir);
    log(`   ${b.name}: deposit ${fmt(b.deposit)}, value hidden`);
  }

  log("3. Reveal: A → B → C (D never reveals)");
  await moveTimeTo(provider, created.biddingEnd);
  for (const [i, b] of EXAMPLE.bids.entries()) {
    if (!b.reveal) continue;
    const signer = accounts.bidders[i]!;
    const r = await revealFromFile(as(signer), signer, auctionId, dir);
    log(`   ${b.name}: ${fmt(r.value)} ${r.valid ? "valid" : "INVALID (deposit < value)"}`);
  }

  log("4. Finalize (called by D, who is neither seller nor winner)");
  await moveTimeTo(provider, created.revealEnd);
  const fin = await finalizeAuction(as(accounts.bidders[3]), auctionId);
  log(`   winner ${fin.winner} at ${fmt(fin.winningBid)}, forfeited ${fmt(fin.forfeited)}`);
  check(fin.winner === addresses[EXAMPLE.winner], `winner should be ${EXAMPLE.winner}`);
  check(fin.winningBid === EXAMPLE.winningBid, "winning bid should be 4 ETH");
  check(fin.forfeited === EXAMPLE.forfeited, "forfeited should be 3 ETH (D's deposit)");
  check((await nft.ownerOf(tokenId)) === addresses[EXAMPLE.winner], "the NFT should belong to the winner");

  log("5. Ledger credited by this auction (design.md 7번)");
  const after = await pendingOf();
  const ledger: Record<string, bigint> = {};
  for (const [n] of named) {
    ledger[n] = after[n]! - leftover[n]!;
    log(`   ${n.padEnd(6)} ${fmt(ledger[n]!).padEnd(10)} (expected ${fmt(EXAMPLE.ledger[n]!)})`);
    check(ledger[n] === EXAMPLE.ledger[n], `${n}'s ledger from this auction`);
  }
  const ledgerTotal = Object.values(ledger).reduce((s, v) => s + v, 0n);
  log(`   total  ${fmt(ledgerTotal)} = deposits ${fmt(EXAMPLE.totalDeposits)}`);
  check(ledgerTotal === EXAMPLE.totalDeposits, "ledger total should equal the deposit total");

  log("6. Withdraw");
  const withdrawn: Record<string, bigint> = {};
  for (const [n, signer] of named) {
    const expected = leftover[n]! + ledger[n]!;
    if (expected === 0n) {
      withdrawn[n] = 0n;
      log(`   ${n.padEnd(6)} nothing to withdraw`);
      continue;
    }
    withdrawn[n] = await withdrawAll(as(signer), signer);
    const note = leftover[n]! > 0n ? ` (this auction ${fmt(ledger[n]!)} + left over ${fmt(leftover[n]!)})` : "";
    log(`   ${n.padEnd(6)} withdrew ${fmt(withdrawn[n]!)}${note}`);
    check(withdrawn[n] === expected, `${n} should withdraw ${fmt(expected)}`);
  }

  // Other auctions may hold money in the same contract, so the check is "this auction left nothing
  // behind": everything deposited here went out again, plus the leftovers that were paid out.
  const leftoverTotal = Object.values(leftover).reduce((s, v) => s + v, 0n);
  const balanceAfter = await provider.getBalance(contractAddress);
  check(balanceAfter === balanceBefore - leftoverTotal, "this auction should leave no ETH in the contract");
  log("\nAll checks passed: the result matches design.md 7번, and this auction left no ETH in the contract.");

  return { auctionId, tokenId, leftover, ledger, withdrawn };
}
