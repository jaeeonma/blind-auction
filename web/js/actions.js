// Transactions of the participation screens (design.md 17번 B). Same checks and messages as the
// scripts (contracts/scripts/lib, design.md 12번): what the contract would reject is refused before
// sending, so the user sees why and pays no gas. The contract still enforces every rule.
import { auctionInterface, findEvent } from "./chain.js";

/** @typedef {import("./chain.js").Chain} Chain */
/** @typedef {import("ethers").Signer} Signer */

/**
 * @param {Chain} chain
 * @param {Signer} signer
 */
export const auctionAs = (chain, signer) => /** @type {import("ethers").Contract} */ (chain.auction.connect(signer));

/**
 * What this account can withdraw right now (the ledger, design.md 7번).
 * @param {Chain} chain
 * @param {string} address
 * @returns {Promise<bigint>}
 */
export async function pendingOf(chain, address) {
  return chain.auction.getFunction("pendingWithdrawals")(address);
}

/**
 * 출금: the whole ledger balance (Pull payment, design.md 13번).
 * @param {Chain} chain
 * @param {Signer} signer
 * @returns {Promise<{ amount: bigint, blockNumber: number }>}
 */
export async function withdrawAll(chain, signer) {
  const address = await signer.getAddress();
  if ((await pendingOf(chain, address)) === 0n) throw new Error(`출금할 금액이 없는 지갑입니다: ${address}`);
  const receipt = await (await auctionAs(chain, signer).getFunction("withdraw")()).wait();
  const event = findEvent(receipt, auctionInterface, "Withdrawn");
  return { amount: event.args.amount, blockNumber: /** @type {number} */ (receipt?.blockNumber) };
}
