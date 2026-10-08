import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { BlindAuction } from "../typechain-types";

export const MINUTE = 60n;
export const DAY = 24n * 60n * 60n;

// Duration limits in BlindAuction.sol (design.md 4번 Q2)
export const MIN_BIDDING_DURATION = 10n * MINUTE;
export const MAX_BIDDING_DURATION = 5n * DAY;
export const MIN_REVEAL_DURATION = 1n * DAY;
export const MAX_REVEAL_DURATION = 2n * DAY;

export const BIDDING_DURATION = 1n * DAY;
export const REVEAL_DURATION = 1n * DAY;

// Phase enum values in BlindAuction.sol
export const Phase = {
  Bidding: 0n,
  Reveal: 1n,
  AwaitingFinalize: 2n,
  Finalized: 3n,
} as const;

/** Hash = value + secret + bidder (design.md 4번 Q11) — must match the contract's reveal check. */
export function computeCommitment(value: bigint, secret: string, bidder: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "address"], [value, secret, bidder]),
  );
}

export function randomSecret(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

/** A committed bid together with the values the bidder keeps locally. */
export interface SecretBid {
  bidder: HardhatEthersSigner;
  value: bigint;
  secret: string;
  deposit: bigint;
}

export async function placeBid(
  auction: BlindAuction,
  auctionId: bigint,
  bidder: HardhatEthersSigner,
  value: bigint,
  deposit: bigint,
): Promise<SecretBid> {
  const secret = randomSecret();
  const commitment = computeCommitment(value, secret, bidder.address);
  await auction.connect(bidder).bid(auctionId, commitment, { value: deposit });
  return { bidder, value, secret, deposit };
}

export function revealBid(auction: BlindAuction, auctionId: bigint, s: SecretBid) {
  return auction.connect(s.bidder).reveal(auctionId, s.value, s.secret);
}

/** Contracts deployed; seller owns token 1 and has approved the auction contract. */
export async function deployFixture() {
  const [seller, alice, bob, carol, other] = await ethers.getSigners();
  const nft = await ethers.deployContract("MockNFT");
  const auction = await ethers.deployContract("BlindAuction");

  await nft.mint(seller.address); // tokenId 1
  await nft.connect(seller).approve(await auction.getAddress(), 1n);

  return { nft, auction, seller, alice, bob, carol, other };
}

/** deployFixture + auction 0 created with the default durations. */
export async function auctionCreatedFixture() {
  const base = await deployFixture();
  const { nft, auction, seller } = base;

  await auction.connect(seller).createAuction(await nft.getAddress(), 1n, BIDDING_DURATION, REVEAL_DURATION);
  const created = await auction.getAuction(0n);

  return {
    ...base,
    auctionId: 0n,
    auctionAddress: await auction.getAddress(),
    biddingEnd: created.biddingEnd,
    revealEnd: created.revealEnd,
  };
}
