import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { BlindAuction } from "../typechain-types";

export const RESERVE_PRICE = ethers.parseEther("1");
export const BIDDING_DURATION = 24n * 60n * 60n; // 1 day
export const REVEAL_DURATION = 24n * 60n * 60n; // 1 day

// Phase enum values in BlindAuction.sol
export const Phase = {
  Bidding: 0n,
  Reveal: 1n,
  AwaitingFinalize: 2n,
  Settled: 3n,
  NoWinner: 4n,
  Cancelled: 5n,
} as const;

// InvalidReason enum values in BlindAuction.sol
export const InvalidReason = {
  None: 0n,
  Fake: 1n,
  InsufficientDeposit: 2n,
  BelowReserve: 3n,
} as const;

/** Same encoding as design.md 2.2 — must match the contract's reveal check. */
export function computeCommitment(
  contract: string,
  auctionId: bigint,
  bidder: string,
  value: bigint,
  fake: boolean,
  salt: string,
): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "address", "uint256", "bool", "bytes32"],
      [contract, auctionId, bidder, value, fake, salt],
    ),
  );
}

export function randomSalt(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}

/** A committed bid together with the secret values the bidder keeps locally. */
export interface SecretBid {
  bidder: HardhatEthersSigner;
  bidIndex: bigint;
  value: bigint;
  fake: boolean;
  salt: string;
  deposit: bigint;
}

export async function placeBid(
  auction: BlindAuction,
  auctionId: bigint,
  bidder: HardhatEthersSigner,
  value: bigint,
  deposit: bigint,
  fake = false,
): Promise<SecretBid> {
  const salt = randomSalt();
  const bidIndex = await auction.bidCountOf(auctionId, bidder.address);
  const commitment = computeCommitment(
    await auction.getAddress(),
    auctionId,
    bidder.address,
    value,
    fake,
    salt,
  );
  await auction.connect(bidder).bid(auctionId, commitment, { value: deposit });
  return { bidder, bidIndex, value, fake, salt, deposit };
}

export function revealBid(auction: BlindAuction, auctionId: bigint, s: SecretBid) {
  return auction.connect(s.bidder).reveal(auctionId, s.bidIndex, s.value, s.fake, s.salt);
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

/** deployFixture + auction 0 created with the default reserve price and durations. */
export async function auctionCreatedFixture() {
  const base = await deployFixture();
  const { nft, auction, seller } = base;

  await auction
    .connect(seller)
    .createAuction(await nft.getAddress(), 1n, RESERVE_PRICE, BIDDING_DURATION, REVEAL_DURATION);
  const created = await auction.getAuction(0n);

  return {
    ...base,
    auctionId: 0n,
    auctionAddress: await auction.getAddress(),
    biddingEnd: created.biddingEnd,
    revealEnd: created.revealEnd,
  };
}
