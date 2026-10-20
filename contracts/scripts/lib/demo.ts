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
  if (!ok) throw new DemoCheckFailed(`demo 검사 실패: ${what}`);
}

/** Name shown on screen for a ledger key (the keys themselves stay "seller", "A"…"D"). */
const label = (name: string) => (name === "seller" ? "판매자" : name);

/**
 * Pads to a width in terminal columns. Hangul takes two columns, so String.padEnd (which counts
 * characters) would leave the Korean rows misaligned.
 */
function padColumns(text: string, columns: number): string {
  let width = 0;
  for (const ch of text) width += /[\u1100-\u115F\u3130-\u318F\uAC00-\uD7A3]/.test(ch) ? 2 : 1;
  return text + " ".repeat(Math.max(0, columns - width));
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
    log("이전 경매에서 출금하지 않고 남은 장부 (이번 demo와 따로 보고, 출금할 때 함께 나감):");
    for (const n of leftoverNames) log(`  ${padColumns(label(n), 6)} ${fmt(leftover[n]!)}`);
  }
  const contractAddress = await auction.getAddress();
  const balanceBefore = await provider.getBalance(contractAddress);

  log("\n1. 생성: 새 NFT를 발행하고 새 경매를 연다 (입찰 10m, 공개 1d)");
  const sellerNft = nft.connect(accounts.seller) as MockNFT;
  const tokenId = await mintNft(sellerNft, addresses.seller!);
  const created = await createAuction(as(accounts.seller), sellerNft, accounts.seller, tokenId, 600n, 86400n);
  const auctionId = created.auctionId;
  log(`   토큰 ${tokenId}번 → 경매 ${auctionId}번`);

  log("2. 입찰: A, B, C, D (입찰마다 입찰가와 secret을 먼저 저장한 뒤 보냄)");
  for (const [i, b] of EXAMPLE.bids.entries()) {
    const signer = accounts.bidders[i]!;
    await placeBid(as(signer), signer, auctionId, b.value, b.deposit, dir);
    log(`   ${b.name}: 보증금 ${fmt(b.deposit)}, 입찰가는 비밀`);
  }

  log("3. 공개: A → B → C (D는 공개하지 않음)");
  await moveTimeTo(provider, created.biddingEnd);
  for (const [i, b] of EXAMPLE.bids.entries()) {
    if (!b.reveal) continue;
    const signer = accounts.bidders[i]!;
    const r = await revealFromFile(as(signer), signer, auctionId, dir);
    log(`   ${b.name}: ${fmt(r.value)} ${r.valid ? "유효" : "무효(보증금 < 입찰가)"}`);
  }

  log("4. 종료 (판매자도 낙찰자도 아닌 D가 호출)");
  await moveTimeTo(provider, created.revealEnd);
  const fin = await finalizeAuction(as(accounts.bidders[3]), auctionId);
  log(`   낙찰가 ${fmt(fin.winningBid)}, 몰수금 ${fmt(fin.forfeited)}`);
  log(`   낙찰자: ${fin.winner}`);
  check(fin.winner === addresses[EXAMPLE.winner], "낙찰자는 B여야 한다");
  check(fin.winningBid === EXAMPLE.winningBid, "낙찰가는 4 ETH여야 한다");
  check(fin.forfeited === EXAMPLE.forfeited, "몰수금은 D의 보증금 3 ETH여야 한다");
  check((await nft.ownerOf(tokenId)) === addresses[EXAMPLE.winner], "NFT는 낙찰자에게 가야 한다");

  log("5. 이번 경매가 장부에 적은 금액 (design.md 7번)");
  const after = await pendingOf();
  const ledger: Record<string, bigint> = {};
  for (const [n] of named) {
    ledger[n] = after[n]! - leftover[n]!;
    log(`   ${padColumns(label(n), 6)} ${fmt(ledger[n]!).padEnd(10)} (기대값 ${fmt(EXAMPLE.ledger[n]!)})`);
    check(ledger[n] === EXAMPLE.ledger[n], `${label(n)}의 이번 경매 장부가 7번 예시와 같아야 한다`);
  }
  const ledgerTotal = Object.values(ledger).reduce((s, v) => s + v, 0n);
  log(`   ${padColumns("합계", 6)} ${fmt(ledgerTotal)} = 보증금 합계 ${fmt(EXAMPLE.totalDeposits)}`);
  check(ledgerTotal === EXAMPLE.totalDeposits, "장부 합계는 보증금 합계와 같아야 한다");

  log("6. 출금");
  const withdrawn: Record<string, bigint> = {};
  for (const [n, signer] of named) {
    const expected = leftover[n]! + ledger[n]!;
    if (expected === 0n) {
      withdrawn[n] = 0n;
      log(`   ${padColumns(label(n), 6)} 출금할 금액 없음`);
      continue;
    }
    withdrawn[n] = await withdrawAll(as(signer), signer);
    const note = leftover[n]! > 0n ? ` (이번 경매 ${fmt(ledger[n]!)} + 이전에 남은 금액 ${fmt(leftover[n]!)})` : "";
    log(`   ${padColumns(label(n), 6)} 출금 ${fmt(withdrawn[n]!)}${note}`);
    check(withdrawn[n] === expected, `${label(n)}의 출금액이 기대값과 같아야 한다 (기대값: ${fmt(expected)})`);
  }

  // Other auctions may hold money in the same contract, so the check is "this auction left nothing
  // behind": everything deposited here went out again, plus the leftovers that were paid out.
  const leftoverTotal = Object.values(leftover).reduce((s, v) => s + v, 0n);
  const balanceAfter = await provider.getBalance(contractAddress);
  check(balanceAfter === balanceBefore - leftoverTotal, "이번 경매가 컨트랙트에 남긴 ETH는 0이어야 한다");
  log("\n모든 검사 통과: 결과가 design.md 7번과 같고, 이번 경매가 컨트랙트에 남긴 ETH는 0이다.");

  return { auctionId, tokenId, leftover, ledger, withdrawn };
}
