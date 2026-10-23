// Browser ↔ local Hardhat node (design.md 17번 B). Writes go from here straight to the contract, never
// through the API (design.md 3번). No DOM in this file, so the same code runs in the Node tests.
import { Contract, Interface, JsonRpcProvider } from "ethers";

/** The local node of README 빠른 시작. Another node can be given with ?rpc=http://… in the page URL. */
export const DEFAULT_RPC_URL = "http://127.0.0.1:8545";

/**
 * Only the parts of BlindAuction the screens use, written out like indexer/events.ts so the browser
 * needs no build output. A test compares every entry with the compiled contract.
 */
export const AUCTION_ABI = [
  "function nextAuctionId() view returns (uint256)",
  "function MIN_BIDDING_DURATION() view returns (uint64)",
  "function MAX_BIDDING_DURATION() view returns (uint64)",
  "function MIN_REVEAL_DURATION() view returns (uint64)",
  "function MAX_REVEAL_DURATION() view returns (uint64)",
  "function phaseOf(uint256 auctionId) view returns (uint8)",
  "function getAuction(uint256 auctionId) view returns (tuple(address seller, address nft, uint256 tokenId, uint64 biddingEnd, uint64 revealEnd, address highestBidder, uint256 highestBid, uint256 highestBidSeq, uint256 totalDeposits, uint256 revealedDeposits, uint32 bidCount, bool finalized))",
  "function getBid(uint256 auctionId, address bidder) view returns (tuple(bytes32 commitment, uint256 deposit, uint256 seq, bool revealed))",
  "function pendingWithdrawals(address account) view returns (uint256)",
  "function createAuction(address nft, uint256 tokenId, uint64 biddingDuration, uint64 revealDuration) returns (uint256)",
  "function bid(uint256 auctionId, bytes32 commitment) payable",
  "function reveal(uint256 auctionId, uint256 value, bytes32 secret)",
  "function finalize(uint256 auctionId)",
  "function withdraw()",
  "event AuctionCreated(uint256 indexed auctionId, address indexed seller, address indexed nft, uint256 tokenId, uint64 biddingEnd, uint64 revealEnd)",
  "event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint256 value, bool valid)",
  "event AuctionFinalized(uint256 indexed auctionId, address indexed winner, uint256 winningBid, uint256 forfeited)",
  "event Withdrawn(address indexed account, uint256 amount)",
  "error AuctionNotFound()",
  "error InvalidDuration()",
  "error InvalidPhase()",
  "error AlreadyBid()",
  "error BidNotFound()",
  "error AlreadyRevealed()",
  "error CommitmentMismatch()",
  "error NothingToWithdraw()",
  "error TransferFailed()",
];

export const NFT_ABI = [
  "function nextTokenId() view returns (uint256)",
  "function mint(address to) returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

export const auctionInterface = new Interface(AUCTION_ABI);
export const nftInterface = new Interface(NFT_ABI);

/**
 * ?rpc=… from the page URL, or the default local node.
 * @param {string} search location.search
 * @returns {string}
 */
export function rpcUrlFrom(search) {
  const value = new URLSearchParams(search).get("rpc");
  return value && /^https?:\/\/[^\s]+$/.test(value) ? value : DEFAULT_RPC_URL;
}

/**
 * @typedef {{ network: string, chainId: number, blindAuction: string, mockNft: string, deployBlock: number }} Deployment
 * @typedef {{ provider: JsonRpcProvider, chainId: number, deployment: Deployment, auction: Contract, nft: Contract }} Chain
 */

/** The page cannot take part: node unreachable or the deployment record does not match the node. */
export class ChainSetupError extends Error {}

/**
 * Connects to the node and checks that the deployment record still matches it. After a local node
 * restart the addresses hold no code; say so instead of failing later with "could not decode result
 * data" (same check and wording as the scripts, design.md 12번).
 * @param {string} rpcUrl
 * @param {Deployment} deployment
 * @returns {Promise<Chain>}
 */
export async function connect(rpcUrl, deployment) {
  // Fixed chain id: ethers does not run its own network-detection retry loop (design.md 9번).
  const provider = new JsonRpcProvider(rpcUrl, deployment.chainId, { staticNetwork: true, cacheTimeout: -1 });
  try {
    await provider.getBlockNumber();
  } catch {
    provider.destroy();
    throw new ChainSetupError(`노드에 연결할 수 없습니다. "cd contracts && npm run node"가 실행 중인지 확인하세요. 노드 주소: ${rpcUrl}`);
  }
  /** @type {Array<[string, string]>} */
  const contracts = [
    ["BlindAuction", deployment.blindAuction],
    ["MockNFT", deployment.mockNft],
  ];
  for (const [name, address] of contracts) {
    if ((await provider.getCode(address)) === "0x") {
      provider.destroy();
      throw new ChainSetupError(
        `배포 기록의 ${name} 주소에 컨트랙트가 없습니다. 노드를 다시 켰다면 "npm run deploy"를 먼저 실행하세요. 주소: ${address}`,
      );
    }
  }
  return {
    provider,
    chainId: deployment.chainId,
    deployment,
    auction: new Contract(deployment.blindAuction, AUCTION_ABI, provider),
    nft: new Contract(deployment.mockNft, NFT_ABI, provider),
  };
}

/**
 * The node's unlocked test accounts (Hardhat: 20) with their balances. Only a local test node has
 * these; a real network would need a wallet (design.md 16번).
 * @param {JsonRpcProvider} provider
 * @param {number} [count]
 * @returns {Promise<Array<{ index: number, address: string, balance: bigint }>>}
 */
export async function testAccounts(provider, count = 10) {
  /** @type {string[]} */
  const addresses = await provider.send("eth_accounts", []);
  return Promise.all(
    addresses.slice(0, count).map(async (address, index) => ({ index, address, balance: await provider.getBalance(address) })),
  );
}

/**
 * Name of the custom error a contract call reverted with (e.g. "BidNotFound"), if any.
 * Over HTTP the revert data may sit one or two levels deep (same handling as the scripts).
 * @param {unknown} err
 * @returns {string | undefined}
 */
export function revertName(err) {
  /** @type {any} */
  const e = err;
  if (e?.revert?.name) return e.revert.name;
  for (const data of [e?.data, e?.data?.data, e?.error?.data, e?.error?.data?.data, e?.info?.error?.data]) {
    if (typeof data !== "string" || !data.startsWith("0x")) continue;
    try {
      const name = auctionInterface.parseError(data)?.name;
      if (name) return name;
    } catch {
      // not one of BlindAuction's errors
    }
  }
  return undefined;
}

/**
 * The first event `name` in a transaction receipt, decoded with `iface`.
 * @param {import("ethers").TransactionReceipt | null} receipt
 * @param {Interface} iface
 * @param {string} name
 */
export function findEvent(receipt, iface, name) {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === name) return parsed;
    } catch {
      // a log of another contract
    }
  }
  throw new Error(`트랜잭션에서 ${name} 이벤트를 찾지 못했습니다`);
}
