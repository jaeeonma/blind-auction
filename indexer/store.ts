import { ZeroAddress, type LogDescription } from "ethers";
import type { ClientBase } from "pg";

// Every write below is idempotent: applying the same event again leaves the DB unchanged.
// That is what makes "reset the bookmark and read everything again" safe (design.md 9번).
//
// Conventions (design.md 10번): uint256 → decimal string (NUMERIC), addresses → lowercase.

const addr = (a: string) => a.toLowerCase();
const num = (n: bigint) => n.toString();

/** Writes one decoded BlindAuction event into the DB (design.md 6번 이벤트 항목). */
export async function applyEvent(client: ClientBase, event: LogDescription): Promise<void> {
  const a = event.args;
  switch (event.name) {
    case "AuctionCreated":
      // UNIQUE(auction_id): a second copy of the event is skipped.
      await client.query(
        `INSERT INTO auctions (auction_id, seller, nft_address, token_id, bidding_end, reveal_end)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [num(a.auctionId), addr(a.seller), addr(a.nft), num(a.tokenId), num(a.biddingEnd), num(a.revealEnd)],
      );
      return;

    case "BidCommitted":
      // UNIQUE(auction_id, bidder): one bid per wallet per auction, a second copy is skipped.
      await client.query(
        `INSERT INTO bids (auction_id, bidder, commitment, deposit)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [num(a.auctionId), addr(a.bidder), a.commitment.toLowerCase(), num(a.deposit)],
      );
      return;

    case "BidRevealed":
      // Only an unrevealed bid is updated. Without "AND NOT revealed", reading the events again after
      // finalize would turn a 'won'/'lost' result back into 'valid'.
      await client.query(
        `UPDATE bids
         SET revealed = TRUE, value = $3, result = CASE WHEN $4::boolean THEN 'valid' ELSE 'invalid' END
         WHERE auction_id = $1 AND bidder = $2 AND NOT revealed`,
        [num(a.auctionId), addr(a.bidder), num(a.value), a.valid],
      );
      return;

    case "AuctionFinalized": {
      // No valid bid → the contract emits the zero address; the DB keeps winner NULL (design.md 6번).
      const winner = a.winner === ZeroAddress ? null : addr(a.winner);
      await client.query(
        `UPDATE auctions
         SET finalized = TRUE, winner = $2, winning_bid = $3, forfeited = $4
         WHERE auction_id = $1 AND NOT finalized`,
        [num(a.auctionId), winner, num(a.winningBid), num(a.forfeited)],
      );
      // Valid bids become won/lost. Invalid and unrevealed (forfeited) bids keep their result.
      // Only rows still 'valid' change, so a repeated event changes nothing.
      // This loops over bids in the DB, not in the contract — the contract never iterates bidders.
      await client.query(
        `UPDATE bids
         SET result = CASE WHEN bidder = $2 THEN 'won' ELSE 'lost' END
         WHERE auction_id = $1 AND result = 'valid'`,
        [num(a.auctionId), winner],
      );
      return;
    }

    case "Withdrawn":
      // Not stored: no query in design.md 11번 needs it (design.md 10번).
      return;
  }
}
