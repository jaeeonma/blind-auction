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
  throw new Error("Transfer event not found in the mint transaction");
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
  if (owner === null) throw new Error(`Token ${tokenId} does not exist`);
  if (owner.toLowerCase() === auctionAddress.toLowerCase()) {
    throw new Error(`Token ${tokenId} is already in an auction (the auction contract holds it)`);
  }
  if (owner.toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error(`Token ${tokenId} is owned by ${owner}, not by ${sellerAddress}`);
  }

  // Durations: bidding 10 minutes to 5 days, reveal 1 to 2 days (design.md 4번 Q2). Read from the contract.
  const [minBid, maxBid, minReveal, maxReveal] = await Promise.all([
    auction.MIN_BIDDING_DURATION(),
    auction.MAX_BIDDING_DURATION(),
    auction.MIN_REVEAL_DURATION(),
    auction.MAX_REVEAL_DURATION(),
  ]);
  if (biddingDuration < minBid || biddingDuration > maxBid) {
    throw new Error(`Bidding duration must be ${minBid}-${maxBid} seconds (10m-5d), got ${biddingDuration}`);
  }
  if (revealDuration < minReveal || revealDuration > maxReveal) {
    throw new Error(`Reveal duration must be ${minReveal}-${maxReveal} seconds (1d-2d), got ${revealDuration}`);
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
  throw new Error("AuctionCreated event not found in the transaction");
}
