import { Interface } from "ethers";

/**
 * The five BlindAuction events (design.md 6번 이벤트 항목).
 * Written out here instead of importing the Hardhat build output, so the Indexer runs without
 * compiling contracts/. The integration tests index a really deployed contract, so a mismatch
 * with BlindAuction.sol fails there.
 */
export const auctionEvents = new Interface([
  "event AuctionCreated(uint256 indexed auctionId, address indexed seller, address indexed nft, uint256 tokenId, uint64 biddingEnd, uint64 revealEnd)",
  "event BidCommitted(uint256 indexed auctionId, address indexed bidder, bytes32 commitment, uint256 deposit)",
  "event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint256 value, bool valid)",
  "event AuctionFinalized(uint256 indexed auctionId, address indexed winner, uint256 winningBid, uint256 forfeited)",
  "event Withdrawn(address indexed account, uint256 amount)",
]);
