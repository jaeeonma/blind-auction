import { readFileSync } from "node:fs";
import {
  AbiCoder,
  Contract,
  ContractFactory,
  JsonRpcProvider,
  hexlify,
  keccak256,
  parseEther,
  randomBytes,
  type InterfaceAbi,
  type JsonRpcSigner,
} from "ethers";

export const eth = (v: string) => parseEther(v);

export const BIDDING_DURATION = 10 * 60; // minimum: 10 minutes (design.md 4번 Q2)
export const REVEAL_DURATION = 24 * 60 * 60; // minimum: 1 day

function artifact(name: string): { abi: InterfaceAbi; bytecode: string } {
  const url = new URL(`../../contracts/artifacts/contracts/${name}.sol/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

/**
 * A provider for tests. Same fixed-network setup as indexer/main.ts (Hardhat chain id 31337).
 * cacheTimeout -1: always ask the node, so a just-mined block is seen at once.
 */
export function testProvider(rpcUrl: string): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
}

/** A read-only handle on an already deployed BlindAuction (for comparing the API with the contract). */
export function attachAuction(provider: JsonRpcProvider, address: string): Contract {
  return new Contract(address, artifact("BlindAuction").abi, provider);
}

export interface Chain {
  provider: JsonRpcProvider;
  seller: JsonRpcSigner;
  /** Four bidder wallets, as in the design.md 7번 example (A, B, C, D). */
  bidders: [JsonRpcSigner, JsonRpcSigner, JsonRpcSigner, JsonRpcSigner];
  nft: Contract;
  auction: Contract;
  auctionAddress: string;
  deployBlock: number;
}

/** Deploys a fresh MockNFT and BlindAuction on the test node. */
export async function deployContracts(rpcUrl: string): Promise<Chain> {
  const provider = testProvider(rpcUrl);
  const [seller, a, b, c, d] = await Promise.all([0, 1, 2, 3, 4].map((i) => provider.getSigner(i)));

  const nftArtifact = artifact("MockNFT");
  const nftDeployed = await new ContractFactory(nftArtifact.abi, nftArtifact.bytecode, seller!).deploy();
  await nftDeployed.waitForDeployment();

  const auctionArtifact = artifact("BlindAuction");
  const auctionDeployed = await new ContractFactory(auctionArtifact.abi, auctionArtifact.bytecode, seller!).deploy();
  const receipt = await auctionDeployed.deploymentTransaction()!.wait();
  const auctionAddress = await auctionDeployed.getAddress();

  return {
    provider,
    seller: seller!,
    bidders: [a!, b!, c!, d!],
    nft: new Contract(await nftDeployed.getAddress(), nftArtifact.abi, seller!),
    auction: new Contract(auctionAddress, auctionArtifact.abi, seller!),
    auctionAddress,
    deployBlock: receipt!.blockNumber,
  };
}

async function send(tx: Promise<{ wait(): Promise<unknown> }>) {
  await (await tx).wait();
}

const as = (chain: Chain, signer: JsonRpcSigner) => chain.auction.connect(signer) as Contract;

/** Mints a token to the seller and creates an auction with the minimum durations. Returns the auction id. */
export async function createAuction(chain: Chain): Promise<bigint> {
  const tokenId: bigint = await chain.nft.getFunction("nextTokenId")();
  await send(chain.nft.getFunction("mint")(await chain.seller.getAddress()));
  await send(chain.nft.getFunction("approve")(chain.auctionAddress, tokenId));
  const auctionId: bigint = await chain.auction.getFunction("nextAuctionId")();
  await send(chain.auction.getFunction("createAuction")(await chain.nft.getAddress(), tokenId, BIDDING_DURATION, REVEAL_DURATION));
  return auctionId;
}

export interface PlacedBid {
  bidder: JsonRpcSigner;
  value: bigint;
  secret: string;
}

/** Hash = value + secret + bidder (design.md 4번 Q11), same encoding as the contract. */
export function commitment(value: bigint, secret: string, bidder: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "address"], [value, secret, bidder]));
}

export async function placeBid(
  chain: Chain,
  auctionId: bigint,
  bidder: JsonRpcSigner,
  value: bigint,
  deposit: bigint,
): Promise<PlacedBid> {
  const secret = hexlify(randomBytes(32));
  await send(as(chain, bidder).getFunction("bid")(auctionId, commitment(value, secret, await bidder.getAddress()), { value: deposit }));
  return { bidder, value, secret };
}

export async function revealBid(chain: Chain, auctionId: bigint, bid: PlacedBid) {
  await send(as(chain, bid.bidder).getFunction("reveal")(auctionId, bid.value, bid.secret));
}

export async function finalize(chain: Chain, auctionId: bigint) {
  await send(chain.auction.getFunction("finalize")(auctionId));
}

/** Mines a block at `timestamp` (moves the node's block time forward). */
export async function mineAt(chain: Chain, timestamp: bigint | number) {
  await chain.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
  await chain.provider.send("evm_mine", []);
}

export async function auctionTimes(chain: Chain, auctionId: bigint) {
  const a = await chain.auction.getFunction("getAuction")(auctionId);
  return { biddingEnd: a.biddingEnd as bigint, revealEnd: a.revealEnd as bigint };
}
