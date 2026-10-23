// Transactions of the participation screens (design.md 17번 B). Same checks and messages as the
// scripts (contracts/scripts/lib, design.md 12번): what the contract would reject is refused before
// sending, so the user sees why and pays no gas. The contract still enforces every rule.
import { AbiCoder, hexlify, keccak256 } from "ethers";
import { auctionInterface, findEvent, revertName } from "./chain.js";
import { bidKey } from "./secrets.js";

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

// ── bid and reveal ──────────────────────────────────────────────────

/** Phase enum of BlindAuction.sol, by the API's status codes. */
export const PHASE_NAMES = ["bidding", "revealing", "awaiting_finalize", "finalized"];

/**
 * 해시 = 입찰가 + secret + 입찰자 주소 (design.md 4번 Q11). Same encoding as the contract and the
 * scripts; if it differed, even the bidder could not reveal.
 * @param {bigint} value
 * @param {string} secret
 * @param {string} bidder
 */
export function computeCommitment(value, secret, bidder) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "address"], [value, secret, bidder]));
}

/** A new 32-byte secret for every bid (design.md 12번), from the browser's cryptographic random source. */
export function randomSecret() {
  return hexlify(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * @param {Chain} chain
 * @param {bigint} auctionId
 * @returns {Promise<string>}
 */
export async function phaseOf(chain, auctionId) {
  try {
    return /** @type {string} */ (PHASE_NAMES[Number(await chain.auction.getFunction("phaseOf")(auctionId))]);
  } catch (err) {
    if (revertName(err) === "AuctionNotFound") throw new Error(`경매 ${auctionId}번이 없습니다`);
    throw err;
  }
}

/**
 * The bidder's bid on chain, or null when this wallet has not bid in the auction.
 * @param {Chain} chain
 * @param {bigint} auctionId
 * @param {string} bidder
 */
export async function findBid(chain, auctionId, bidder) {
  try {
    const b = await chain.auction.getFunction("getBid")(auctionId, bidder);
    return { commitment: /** @type {string} */ (b.commitment), deposit: /** @type {bigint} */ (b.deposit), revealed: /** @type {boolean} */ (b.revealed) };
  } catch (err) {
    if (revertName(err) === "BidNotFound") return null;
    throw err;
  }
}

/**
 * The key of this bidder's saved bid in this auction.
 * @param {Chain} chain
 * @param {bigint | string} auctionId
 * @param {string} bidder
 */
export const keyFor = (chain, auctionId, bidder) =>
  bidKey({ chainId: chain.chainId, contract: chain.deployment.blindAuction, auctionId, bidder });

/**
 * 입찰 (design.md 12·17번):
 *   1. 입찰 기간인지, 이미 입찰한 지갑인지 확인한다.
 *   2. secret을 새로 만들고 해시를 계산한다.
 *   3. 입찰가와 secret을 브라우저 저장소에 저장한다 (다시 읽어 확인).
 *   4. 해시와 보증금을 보낸다.
 * @param {Chain} chain
 * @param {Signer} signer
 * @param {import("./secrets.js").SecretStore} store
 * @param {bigint} auctionId
 * @param {bigint} value
 * @param {bigint} deposit
 */
export async function placeBid(chain, signer, store, auctionId, value, deposit) {
  const bidder = await signer.getAddress();
  const phase = await phaseOf(chain, auctionId);
  if (phase !== "bidding") throw new Error(`경매 ${auctionId}번은 입찰 기간이 아닙니다 (현재: ${phase})`);
  if (await findBid(chain, auctionId, bidder)) {
    // The saved entry (if any) is left untouched: it holds the secret of the bid on chain.
    throw new Error(`경매 ${auctionId}번에 이미 입찰한 지갑입니다 (지갑당 한 번, design.md 4번 Q10): ${bidder}`);
  }

  /** @type {string[]} */
  const warnings = [];
  if (deposit < value) {
    warnings.push("보증금이 입찰가보다 적어서 공개하면 무효 입찰이 되고 보증금만 돌려받습니다 (design.md 4번 Q3-1).");
  }

  // An entry here without a bid on chain (checked above) is from a send that failed: replace it.
  const key = keyFor(chain, auctionId, bidder);
  const replaced = store.has(key);
  const secret = randomSecret();
  const commitment = computeCommitment(value, secret, bidder);
  store.save({
    chainId: chain.chainId,
    contract: chain.deployment.blindAuction,
    auctionId: auctionId.toString(),
    bidder,
    value: value.toString(),
    secret,
    deposit: deposit.toString(),
    commitment,
    createdAt: new Date().toISOString(),
  });

  const receipt = await (await auctionAs(chain, signer).getFunction("bid")(auctionId, commitment, { value: deposit })).wait();
  return { key, commitment, replaced, warnings, blockNumber: /** @type {number} */ (receipt?.blockNumber) };
}

/**
 * 공개: the value and secret saved in this browser (design.md 12·17번).
 * @param {Chain} chain
 * @param {Signer} signer
 * @param {import("./secrets.js").SecretStore} store
 * @param {bigint} auctionId
 */
export async function revealFromStore(chain, signer, store, auctionId) {
  const bidder = await signer.getAddress();
  const phase = await phaseOf(chain, auctionId);
  if (phase !== "revealing") throw new Error(`경매 ${auctionId}번은 공개 기간이 아닙니다 (현재: ${phase})`);
  const onChain = await findBid(chain, auctionId, bidder);
  if (!onChain) throw new Error(`경매 ${auctionId}번에 입찰하지 않은 지갑입니다: ${bidder}`);
  if (onChain.revealed) throw new Error(`경매 ${auctionId}번에서 이미 공개한 입찰입니다: ${bidder}`);

  const saved = store.load(keyFor(chain, auctionId, bidder));
  if (!saved) {
    throw new Error(
      `이 브라우저에 경매 ${auctionId}번 입찰의 secret이 없습니다. 입찰할 때와 같은 주소로 접속했는지 확인하세요. ` +
        "secret이 없으면 공개할 수 없고 보증금은 몰수됩니다 (design.md 4번 Q4).",
    );
  }
  const value = BigInt(saved.value);
  // Check the saved values against the hash on chain before sending (no gas for a doomed reveal).
  if (computeCommitment(value, saved.secret, bidder) !== onChain.commitment) {
    throw new Error("저장된 secret이 체인의 입찰과 맞지 않습니다 (잘못되거나 손상된 값). 공개를 보내지 않았습니다");
  }

  const receipt = await (await auctionAs(chain, signer).getFunction("reveal")(auctionId, value, saved.secret)).wait();
  const event = findEvent(receipt, auctionInterface, "BidRevealed");
  return { value, valid: /** @type {boolean} */ (event.args.valid), blockNumber: /** @type {number} */ (receipt?.blockNumber) };
}
