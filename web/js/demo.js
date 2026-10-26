// 경매 진행 화면 (design.md 17번 B): the roles of the design.md 7번 example, what to do next, which
// button each card shows and why it is off, and the state of the current auction for the five demo
// accounts. No DOM here, so it runs in the Node tests like actions.js. Transactions stay in actions.js.
import { Contract } from "ethers";
import { createAuction, findBid, keyFor, mintNft, ownedTokens, pendingOf, phaseOf } from "./actions.js";
import { NFT_ABI } from "./chain.js";
import { formatEth, shortAddress } from "./format.js";

/** @typedef {import("./chain.js").Chain} Chain */

/**
 * @typedef {{ index: number, name: string, seller: boolean, value: string, deposit: string, note: string }} Role
 *   value/deposit: ETH prefilled in the bid form (design.md 7번 example, same as `npm run demo`)
 */

/** @type {Role[]} */
export const ROLES = [
  { index: 0, name: "판매자", seller: true, value: "", deposit: "", note: "" },
  { index: 1, name: "A", seller: false, value: "3", deposit: "5", note: "" },
  { index: 2, name: "B", seller: false, value: "4", deposit: "4", note: "" },
  { index: 3, name: "C", seller: false, value: "3", deposit: "2", note: "예시: 보증금이 입찰가보다 적어 공개하면 무효" },
  { index: 4, name: "D", seller: false, value: "1", deposit: "3", note: "예시: 공개하지 않음 → 보증금 몰수" },
];

/** "새 경매 시작" uses the shortest periods the contract allows (design.md 4번 Q2): 10 minutes, 1 day. */
export const DEMO_BIDDING_SECONDS = 600n;
export const DEMO_REVEAL_SECONDS = 86400n;

/**
 * @typedef {{
 *   role: Role,
 *   address: string,
 *   balance: bigint,
 *   pending: bigint,
 *   bid: { commitment: string, deposit: bigint, revealed: boolean } | null,
 *   saved: import("./secrets.js").SavedBid | null,
 *   savedError: string,
 * }} Person
 * @typedef {{ contract: string, tokenId: bigint, owner: string }} AuctionNft
 *   the auctioned NFT and its owner right now (ownerOf on the NFT contract)
 * @typedef {{ auctionId: bigint | null, phase: string, storeAvailable: boolean, people: Person[], nft: AuctionNft | null }} Stage
 *   phase: "none" when there is no auction yet, otherwise the contract's phase (bidding, revealing, ...)
 */

/**
 * The auction the screen runs: the newest one on this chain (design.md 17번), or null.
 * @param {Chain} chain
 * @returns {Promise<bigint | null>}
 */
export async function currentAuctionId(chain) {
  const next = /** @type {bigint} */ (await chain.auction.getFunction("nextAuctionId")());
  return next === 0n ? null : next - 1n;
}

/**
 * Everything the screen shows from the chain: phase, and for each demo account its balance, ledger,
 * bid on chain and the secret saved in this browser.
 * @param {Chain} chain
 * @param {import("./secrets.js").SecretStore | null} store
 * @param {string[]} addresses test accounts 0..4
 * @returns {Promise<Stage>}
 */
export async function loadStage(chain, store, addresses) {
  const auctionId = await currentAuctionId(chain);
  const phase = auctionId === null ? "none" : await phaseOf(chain, auctionId);
  const people = await Promise.all(
    ROLES.map(async (role) => {
      const address = /** @type {string} */ (addresses[role.index]);
      const [balance, pending, bid] = await Promise.all([
        chain.provider.getBalance(address),
        pendingOf(chain, address),
        auctionId === null ? null : findBid(chain, auctionId, address),
      ]);
      let saved = null;
      let savedError = "";
      if (auctionId !== null && store) {
        try {
          saved = store.load(keyFor(chain, auctionId, address));
        } catch (err) {
          savedError = err instanceof Error ? err.message : String(err);
        }
      }
      return { role, address, balance, pending, bid, saved, savedError };
    }),
  );
  const nft = auctionId === null ? null : await auctionNft(chain, auctionId);
  return { auctionId, phase, storeAvailable: store !== null, people, nft };
}

/**
 * Who holds the auctioned NFT now, read from the chain like the ledgers (not from the API): the
 * auction contract while the auction runs, the winner or the seller after finalize (design.md 4번).
 * @param {Chain} chain
 * @param {bigint} auctionId
 * @returns {Promise<AuctionNft>}
 */
export async function auctionNft(chain, auctionId) {
  const a = await chain.auction.getFunction("getAuction")(auctionId);
  const contract = /** @type {string} */ (a.nft);
  const tokenId = /** @type {bigint} */ (a.tokenId);
  // The demo creates auctions of the deployed MockNFT; an auction made by script with another ERC-721
  // is read through that contract.
  const nftContract =
    contract.toLowerCase() === chain.deployment.mockNft.toLowerCase() ? chain.nft : new Contract(contract, NFT_ABI, chain.provider);
  const owner = /** @type {string} */ (await nftContract.getFunction("ownerOf")(tokenId));
  return { contract, tokenId, owner };
}

/**
 * The NFT owner by name instead of address (design.md 17번): the auction contract, 판매자 (account 0),
 * A~D (accounts 1~4), or a short address for anyone else.
 * @param {string} owner
 * @param {string} auctionContract
 * @param {Person[]} people
 */
export function ownerName(owner, auctionContract, people) {
  const o = owner.toLowerCase();
  if (o === auctionContract.toLowerCase()) return "경매 컨트랙트 (보관 중)";
  const person = people.find((p) => p.address.toLowerCase() === o);
  if (person) return person.role.seller ? "판매자" : person.role.name;
  return shortAddress(owner);
}

/**
 * "다음에 할 일" and the time button of the top bar.
 * @param {Stage} s
 * @returns {{ text: string, move: "reveal" | "end" | null, moveLabel: string }}
 */
export function guide(s) {
  const bidders = s.people.filter((p) => !p.role.seller);
  const bidCount = bidders.filter((p) => p.bid).length;
  const revealedCount = bidders.filter((p) => p.bid?.revealed).length;
  switch (s.phase) {
    case "none":
      return { text: '아직 경매가 없습니다. "새 경매 시작"을 누르세요.', move: null, moveLabel: "" };
    case "bidding":
      return {
        text: `A~D가 카드에서 입찰합니다 (${bidCount}/4명 입찰함). 다 입찰했으면 "입찰 마감으로"를 누르세요.`,
        move: "reveal",
        moveLabel: "입찰 마감으로",
      };
    case "revealing":
      return {
        text: `입찰한 사람이 공개합니다 (${revealedCount}/${bidCount}명 공개함). 예시에서 D는 공개하지 않습니다. 다 됐으면 "공개 마감으로"를 누르세요.`,
        move: "end",
        moveLabel: "공개 마감으로",
      };
    case "awaiting_finalize":
      return { text: '공개 마감이 지났습니다. 아무 카드에서나 "종료"를 누르세요 (누구나 할 수 있음).', move: null, moveLabel: "" };
    default:
      return {
        text: '종료됐습니다. 장부에 받을 돈이 있는 사람이 "출금"을 누릅니다. 다음 경매는 "새 경매 시작"을 누르세요.',
        move: null,
        moveLabel: "",
      };
  }
}

/**
 * @typedef {{ kind: "bid" | "reveal" | "finalize" | "withdraw", label: string, reason: string }} CardAction
 *   reason: why the button is off (shown next to it); empty when it can be pressed
 */

/**
 * The status line and the buttons of a card (design.md 17번 B): the button of the current phase, and
 * 출금 whenever the ledger has money. The contract allows withdraw at any time (design.md 6번), so
 * money left from an earlier auction can still be taken out after a new auction started.
 * @param {Person} p
 * @param {Stage} s
 * @returns {{ status: string, action: CardAction | null, withdraw: CardAction | null }}
 *   withdraw: an extra 출금 next to `action`; null when `action` is 출금 itself or the ledger is empty
 */
export function cardFor(p, s) {
  const card = phaseCard(p, s);
  const withdraw =
    card.action?.kind !== "withdraw" && p.pending > 0n ? { kind: /** @type {const} */ ("withdraw"), label: "출금", reason: "" } : null;
  return { ...card, withdraw };
}

/**
 * The status line and the button of the current phase.
 * @param {Person} p
 * @param {Stage} s
 * @returns {{ status: string, action: CardAction | null }}
 */
function phaseCard(p, s) {
  const withdraw = () => ({
    kind: /** @type {const} */ ("withdraw"),
    label: "출금",
    reason: p.pending === 0n ? "장부에 받을 돈이 없습니다" : "",
  });
  const finalize = { kind: /** @type {const} */ ("finalize"), label: "종료", reason: "" };

  if (p.role.seller) {
    switch (s.phase) {
      case "bidding":
        return { status: "입찰을 기다리는 중 (이 예시에서 판매자는 입찰하지 않음)", action: null };
      case "revealing":
        return { status: "공개를 기다리는 중", action: null };
      case "awaiting_finalize":
        return { status: "", action: finalize };
      case "finalized":
        return { status: "", action: withdraw() };
      default:
        return { status: "", action: null };
    }
  }

  const deposit = p.bid ? formatEth(p.bid.deposit.toString()) : "";
  let status;
  if (!p.bid) status = "입찰하지 않음";
  else if (p.bid.revealed) status = `공개함 · 보증금 ${deposit}`;
  else if (s.phase === "awaiting_finalize") status = `공개하지 않음 · 보증금 ${deposit}는 종료하면 판매자에게 몰수`;
  else if (s.phase === "finalized") status = `공개하지 않아 보증금 ${deposit} 몰수`;
  else status = `입찰함 · 보증금 ${deposit}` + (p.saved ? ` · 이 브라우저에 저장된 입찰가 ${formatEth(p.saved.value)}` : "");
  switch (s.phase) {
    case "bidding": {
      let reason = "";
      if (p.bid) reason = "이미 입찰했습니다 (지갑당 한 번)";
      else if (!s.storeAvailable) reason = "브라우저 저장소를 쓸 수 없어 secret을 저장할 곳이 없습니다";
      return { status: p.bid ? status : "", action: { kind: "bid", label: "입찰", reason } };
    }
    case "revealing": {
      let reason = "";
      if (!p.bid) reason = "입찰하지 않아서 공개할 것이 없습니다";
      else if (p.bid.revealed) reason = "이미 공개했습니다";
      else if (p.savedError) reason = "이 브라우저에 저장된 secret이 손상되었습니다";
      else if (!p.saved) reason = "이 브라우저에 secret이 없습니다 (아래 가져오기로 넣을 수 있음)";
      return { status, action: { kind: "reveal", label: "공개", reason } };
    }
    case "awaiting_finalize":
      return { status, action: finalize };
    case "finalized":
      return { status, action: withdraw() };
    default:
      return { status: "", action: null };
  }
}

/**
 * "새 경매 시작": the seller puts up a test NFT it already owns, or mints one first, then creates the
 * auction (approve included, createAuction in actions.js). Pressing again after a failure does not
 * pile up NFTs: the unused one is taken.
 * @param {Chain} chain
 * @param {import("ethers").Signer} seller
 */
export async function startAuction(chain, seller) {
  const tokens = await ownedTokens(chain, await seller.getAddress());
  let tokenId = tokens[0];
  const minted = tokenId === undefined;
  if (tokenId === undefined) tokenId = (await mintNft(chain, seller)).tokenId;
  const created = await createAuction(chain, seller, tokenId, DEMO_BIDDING_SECONDS, DEMO_REVEAL_SECONDS);
  return { ...created, tokenId, minted };
}
