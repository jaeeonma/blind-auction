import type { Signer } from "ethers";
import type { BlindAuction } from "../../typechain-types";
import { bidFileExists, bidsDir, readBidFile, writeBidFile, type BidKey } from "./bid-files";
import { computeCommitment, randomSecret } from "./commitment";

// Phase enum in BlindAuction.sol
export const PHASE_NAMES = ["bidding", "revealing", "awaiting_finalize", "finalized"] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

/**
 * Name of the custom error a contract call reverted with (e.g. "BidNotFound"), if any.
 * The error looks different depending on how the node is reached:
 *   - in-process Hardhat network (tests): ethers decodes it → err.revert.name
 *   - HTTP node (npm run node):           ProviderError → err.data = { message, data: "0x<selector>…" }
 */
export function revertName(contract: Pick<BlindAuction, "interface">, err: unknown): string | undefined {
  type Nested = { data?: unknown; error?: unknown; revert?: { name?: string } };
  const e = err as Nested | undefined;
  if (e?.revert?.name) return e.revert.name;

  const candidates: unknown[] = [];
  for (const level of [e, e?.error as Nested | undefined]) {
    candidates.push(level?.data, (level?.data as Nested | undefined)?.data);
  }
  for (const data of candidates) {
    if (typeof data !== "string" || !data.startsWith("0x")) continue;
    try {
      const name = contract.interface.parseError(data)?.name;
      if (name) return name;
    } catch {
      // not one of this contract's errors
    }
  }
  return undefined;
}

/** Current phase, or a clear error for an auction id that does not exist. */
export async function phaseOf(auction: BlindAuction, auctionId: bigint): Promise<PhaseName> {
  try {
    return PHASE_NAMES[Number(await auction.phaseOf(auctionId))]!;
  } catch (err) {
    if (revertName(auction, err) === "AuctionNotFound") throw new Error(`경매 ${auctionId}번이 없습니다`);
    throw err;
  }
}

/** The bidder's bid, or null when the wallet has not bid in this auction. */
export async function findBid(auction: BlindAuction, auctionId: bigint, bidder: string) {
  try {
    return await auction.getBid(auctionId, bidder);
  } catch (err) {
    if (revertName(auction, err) === "BidNotFound") return null;
    throw err;
  }
}

async function bidKey(auction: BlindAuction, bidder: Signer, auctionId: bigint): Promise<BidKey> {
  return {
    chainId: Number((await bidder.provider!.getNetwork()).chainId),
    contract: await auction.getAddress(),
    auctionId,
    bidder: await bidder.getAddress(),
  };
}

export interface PlacedBid {
  file: string;
  commitment: string;
  /** A previous file existed but the wallet had no bid on chain (the earlier send failed). */
  replacedFile: boolean;
  warnings: string[];
}

/**
 * 입찰 (design.md 12번). `auction` must be connected to `bidder`.
 *   1. secret을 새로 만들고 해시를 계산한다.
 *   2. 입찰가와 secret을 파일에 저장한다 (디스크에 다 쓴 뒤 다음 단계로).
 *   3. 해시와 보증금을 보낸다.
 * 2와 3의 순서가 중요하다: 보낸 뒤에 저장하면, 트랜잭션은 성공했는데 그 직후 프로그램이 죽었을 때
 * secret이 사라져 공개할 수 없고 보증금이 몰수된다 (design.md 8번).
 */
export async function placeBid(
  auction: BlindAuction,
  bidder: Signer,
  auctionId: bigint,
  value: bigint,
  deposit: bigint,
  dir = bidsDir(),
): Promise<PlacedBid> {
  const bidderAddress = await bidder.getAddress();

  const phase = await phaseOf(auction, auctionId);
  if (phase !== "bidding") throw new Error(`경매 ${auctionId}번은 입찰 기간이 아닙니다 (현재: ${phase})`);
  if (await findBid(auction, auctionId, bidderAddress)) {
    // The existing file (if any) is left untouched: it holds the secret of the bid on chain.
    throw new Error(`경매 ${auctionId}번에 이미 입찰한 지갑입니다 (지갑당 한 번, design.md 4번 Q10): ${bidderAddress}`);
  }

  const warnings: string[] = [];
  if (deposit < value) {
    warnings.push(
      "보증금이 입찰가보다 적어서 공개하면 무효 입찰이 되고 보증금만 돌려받습니다 (design.md 4번 Q3-1). " +
        `보증금: ${deposit} wei, 입찰가: ${value} wei`,
    );
  }

  // A new secret for every bid (design.md 12번). If a file already exists here, the wallet has no bid
  // on chain (checked above), so the earlier send failed and the old secret is worthless.
  const key = await bidKey(auction, bidder, auctionId);
  const replacedFile = bidFileExists(key, dir);
  const secret = randomSecret();
  const commitment = computeCommitment(value, secret, bidderAddress);

  const file = writeBidFile(
    {
      chainId: key.chainId,
      contract: key.contract,
      auctionId: auctionId.toString(),
      bidder: bidderAddress,
      value: value.toString(),
      secret,
      deposit: deposit.toString(),
      commitment,
      createdAt: new Date().toISOString(),
    },
    dir,
  );

  await (await auction.bid(auctionId, commitment, { value: deposit })).wait();
  return { file, commitment, replacedFile, warnings };
}

export interface RevealedBid {
  value: bigint;
  valid: boolean;
}

/** 공개: 저장한 파일에서 입찰가와 secret을 읽어 공개한다 (design.md 12번). `auction` must be connected to `bidder`. */
export async function revealFromFile(
  auction: BlindAuction,
  bidder: Signer,
  auctionId: bigint,
  dir = bidsDir(),
): Promise<RevealedBid> {
  const bidderAddress = await bidder.getAddress();

  const phase = await phaseOf(auction, auctionId);
  if (phase !== "revealing") throw new Error(`경매 ${auctionId}번은 공개 기간이 아닙니다 (현재: ${phase})`);
  const onChain = await findBid(auction, auctionId, bidderAddress);
  if (!onChain) throw new Error(`경매 ${auctionId}번에 입찰하지 않은 지갑입니다: ${bidderAddress}`);
  if (onChain.revealed) throw new Error(`경매 ${auctionId}번에서 이미 공개한 입찰입니다: ${bidderAddress}`);

  const saved = readBidFile(await bidKey(auction, bidder, auctionId), dir);
  const value = BigInt(saved.value);
  // Check the file against the hash on chain before sending. A wrong or damaged file is reported
  // here instead of as a CommitmentMismatch revert that costs gas.
  if (computeCommitment(value, saved.secret, bidderAddress) !== onChain.commitment) {
    throw new Error("secret 파일이 체인의 입찰과 맞지 않습니다 (잘못되거나 손상된 파일). 공개를 보내지 않았습니다");
  }

  const receipt = await (await auction.reveal(auctionId, value, saved.secret)).wait();
  for (const log of receipt!.logs) {
    const parsed = auction.interface.parseLog(log);
    if (parsed?.name === "BidRevealed") return { value, valid: parsed.args.valid };
  }
  throw new Error("트랜잭션에서 BidRevealed 이벤트를 찾지 못했습니다");
}
