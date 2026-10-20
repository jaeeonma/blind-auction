import type { Signer } from "ethers";
import type { BlindAuction, MockNFT } from "../../typechain-types";

// Script actions (design.md 12번). Each one checks what the contract would reject BEFORE sending,
// so the user gets a clear reason and pays no gas for a transaction that would revert.
// The contract still enforces every rule; these checks are only for usability.

/** 시연용 테스트 NFT 발행. Returns the new token id (read from the Transfer event). */
export async function mintNft(nft: MockNFT, to: string): Promise<bigint> {
  const receipt = await (await nft.mint(to)).wait();
  for (const log of receipt!.logs) {
    const parsed = nft.interface.parseLog(log);
    if (parsed?.name === "Transfer") return parsed.args.tokenId as bigint;
  }
  throw new Error("발행 트랜잭션에서 Transfer 이벤트를 찾지 못했습니다");
}

export interface CreatedAuction {
  auctionId: bigint;
  biddingEnd: bigint;
  revealEnd: bigint;
  approved: boolean; // whether an approve transaction was needed
}

/**
 * 경매 생성: approve 후 createAuction (design.md 12번).
 * `auction` and `nft` must be connected to the seller.
 */
export async function createAuction(
  auction: BlindAuction,
  nft: MockNFT,
  seller: Signer,
  tokenId: bigint,
  biddingDuration: bigint,
  revealDuration: bigint,
): Promise<CreatedAuction> {
  const sellerAddress = await seller.getAddress();
  const auctionAddress = await auction.getAddress();

  // Only the NFT owner can create the auction (design.md 13번).
  const owner = await nft.ownerOf(tokenId).catch(() => null);
  if (owner === null) throw new Error(`토큰 ${tokenId}번이 없습니다`);
  if (owner.toLowerCase() === auctionAddress.toLowerCase()) {
    throw new Error(`토큰 ${tokenId}번은 이미 경매 중입니다 (경매 컨트랙트가 보관하고 있음)`);
  }
  if (owner.toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error(`토큰 ${tokenId}번의 주인이 아닙니다. 주인: ${owner}, 호출한 계정: ${sellerAddress}`);
  }

  // Durations: bidding 10 minutes to 5 days, reveal 1 to 2 days (design.md 4번 Q2). Read from the contract.
  const [minBid, maxBid, minReveal, maxReveal] = await Promise.all([
    auction.MIN_BIDDING_DURATION(),
    auction.MAX_BIDDING_DURATION(),
    auction.MIN_REVEAL_DURATION(),
    auction.MAX_REVEAL_DURATION(),
  ]);
  if (biddingDuration < minBid || biddingDuration > maxBid) {
    throw new Error(`입찰 기간은 ${minBid}~${maxBid}초(10m~5d) 사이여야 합니다. 입력: ${biddingDuration}초`);
  }
  if (revealDuration < minReveal || revealDuration > maxReveal) {
    throw new Error(`공개 기간은 ${minReveal}~${maxReveal}초(1d~2d) 사이여야 합니다. 입력: ${revealDuration}초`);
  }

  // The contract pulls the NFT with transferFrom, so it needs approval first.
  let approved = false;
  const alreadyApproved =
    (await nft.getApproved(tokenId)).toLowerCase() === auctionAddress.toLowerCase() ||
    (await nft.isApprovedForAll(sellerAddress, auctionAddress));
  if (!alreadyApproved) {
    await (await nft.approve(auctionAddress, tokenId)).wait();
    approved = true;
  }

  const receipt = await (await auction.createAuction(await nft.getAddress(), tokenId, biddingDuration, revealDuration)).wait();
  for (const log of receipt!.logs) {
    const parsed = auction.interface.parseLog(log);
    if (parsed?.name === "AuctionCreated") {
      return {
        auctionId: parsed.args.auctionId,
        biddingEnd: parsed.args.biddingEnd,
        revealEnd: parsed.args.revealEnd,
        approved,
      };
    }
  }
  throw new Error("트랜잭션에서 AuctionCreated 이벤트를 찾지 못했습니다");
}
