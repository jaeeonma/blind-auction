import { ZeroAddress, type Signer } from "ethers";
import type { BlindAuction } from "../../typechain-types";
import { phaseOf } from "./bid";
import { formatTime } from "./units";

export interface FinalizedAuction {
  /** null when there was no valid bid (the NFT went back to the seller, design.md 4번 Q7). */
  winner: string | null;
  winningBid: bigint;
  forfeited: bigint;
}

/** 종료 (design.md 12번). Anyone may call it once the reveal phase is over (Q8). */
export async function finalizeAuction(auction: BlindAuction, auctionId: bigint): Promise<FinalizedAuction> {
  const phase = await phaseOf(auction, auctionId);
  if (phase === "finalized") throw new Error(`경매 ${auctionId}번은 이미 종료됐습니다`);
  if (phase !== "awaiting_finalize") {
    const { revealEnd } = await auction.getAuction(auctionId);
    throw new Error(`경매 ${auctionId}번은 아직 종료할 수 없습니다 (현재: ${phase}). 공개 마감: ${formatTime(revealEnd)}`);
  }

  const receipt = await (await auction.finalize(auctionId)).wait();
  for (const log of receipt!.logs) {
    const parsed = auction.interface.parseLog(log);
    if (parsed?.name === "AuctionFinalized") {
      return {
        winner: parsed.args.winner === ZeroAddress ? null : parsed.args.winner,
        winningBid: parsed.args.winningBid,
        forfeited: parsed.args.forfeited,
      };
    }
  }
  throw new Error("트랜잭션에서 AuctionFinalized 이벤트를 찾지 못했습니다");
}

/**
 * 출금 (design.md 12번): the whole ledger balance of `account` (Pull payment, design.md 13번).
 * `auction` must be connected to `account`. Returns the amount paid out.
 */
export async function withdrawAll(auction: BlindAuction, account: Signer): Promise<bigint> {
  const address = await account.getAddress();
  const pending = await auction.pendingWithdrawals(address);
  if (pending === 0n) throw new Error(`출금할 금액이 없는 지갑입니다: ${address}`);

  const receipt = await (await auction.withdraw()).wait();
  for (const log of receipt!.logs) {
    const parsed = auction.interface.parseLog(log);
    if (parsed?.name === "Withdrawn") return parsed.args.amount;
  }
  throw new Error("트랜잭션에서 Withdrawn 이벤트를 찾지 못했습니다");
}
