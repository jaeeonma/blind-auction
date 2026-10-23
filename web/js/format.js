// Display helpers for the demo web screens (design.md 17번). No DOM here, so they are unit-tested in Node.

/** API status codes stay English (design.md 10·11번); only the screen shows Korean names. */
export const STATUS_LABEL = {
  bidding: "입찰 중",
  revealing: "공개 중",
  awaiting_finalize: "종료 대기",
  finalized: "종료",
};

/** API result codes → names on screen. */
export const RESULT_LABEL = {
  unrevealed: "미공개",
  valid: "유효",
  invalid: "무효",
  won: "낙찰",
  lost: "패찰",
};

/**
 * A bid's result as shown on screen. Once the auction is finalized an unrevealed bid's deposit has
 * gone to the seller (design.md 4번 Q4, 6번 "미공개는 그대로 미공개(몰수)"), so the screen says so.
 * @param {string} result API result code
 * @param {string} auctionStatus API status code of the auction
 * @returns {{ code: string, label: string }} code is used for the badge colour
 */
export function bidResult(result, auctionStatus) {
  if (result === "unrevealed" && auctionStatus === "finalized") return { code: "forfeited", label: "미공개 · 몰수" };
  return { code: result, label: resultLabel(result) };
}

/** The four phases in order, for the step indicator. */
export const PHASES = ["bidding", "revealing", "awaiting_finalize", "finalized"];

/**
 * @param {string} code
 * @returns {string}
 */
export function statusLabel(code) {
  return STATUS_LABEL[/** @type {keyof typeof STATUS_LABEL} */ (code)] ?? code;
}

/**
 * @param {string} code
 * @returns {string}
 */
export function resultLabel(code) {
  return RESULT_LABEL[/** @type {keyof typeof RESULT_LABEL} */ (code)] ?? code;
}

const WEI_PER_ETH = 10n ** 18n;

/**
 * wei (decimal string from the API) → "5 ETH", "0.5 ETH". Exact: BigInt, no floating point
 * (amounts can exceed what a JavaScript number holds exactly, design.md 10번).
 * @param {string} wei
 * @returns {string}
 */
export function formatEth(wei) {
  const value = BigInt(wei);
  const whole = value / WEI_PER_ETH;
  const fraction = (value % WEI_PER_ETH).toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ETH`;
}

/**
 * Like formatEth but cut (not rounded) to `digits` decimals, for balances that gas makes long:
 * "9999.9993 ETH". Ledger amounts and bids use formatEth, which is exact.
 * @param {string | bigint} wei
 * @param {number} [digits]
 * @returns {string}
 */
export function formatEthShort(wei, digits = 4) {
  const value = BigInt(wei);
  const whole = value / WEI_PER_ETH;
  const fraction = (value % WEI_PER_ETH).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ETH`;
}

/**
 * "0x1234…abcd" for tables; the full address is shown on hover and on the detail screens.
 * @param {string} address
 * @returns {string}
 */
export function shortAddress(address) {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Seconds → "1일 2시간", "9분 30초". Only the two largest units, which is enough at a glance.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (seconds <= 0) return "0초";
  const units = /** @type {const} */ ([
    ["일", 86400],
    ["시간", 3600],
    ["분", 60],
    ["초", 1],
  ]);
  const parts = [];
  let rest = Math.floor(seconds);
  for (const [name, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0) parts.push(`${n}${name}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/**
 * The next thing an auction is waiting for, measured in block time (design.md 10번), not the
 * browser clock: the contract decides by block.timestamp.
 * @param {{ status: string, biddingEnd: number, revealEnd: number }} auction
 * @param {number} blockTime unix seconds of the last block the Indexer read (asOf.blockTime)
 * @returns {{ label: string, at?: number, remaining?: string }}
 */
export function nextStep(auction, blockTime) {
  switch (auction.status) {
    case "bidding":
      return { label: "입찰 마감까지", at: auction.biddingEnd, remaining: formatDuration(auction.biddingEnd - blockTime) };
    case "revealing":
      return { label: "공개 마감까지", at: auction.revealEnd, remaining: formatDuration(auction.revealEnd - blockTime) };
    case "awaiting_finalize":
      return { label: "누군가 종료를 호출하면 정산" };
    default:
      return { label: "정산 완료" };
  }
}

/**
 * Unix seconds → local "2026-10-24 13:05:10".
 * @param {number} unixSeconds
 * @returns {string}
 */
export function formatTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** asOf unchanged for longer than this → the Indexer looks stopped (dev node mines every 5 s). */
export const STALE_AFTER_MS = 15_000;

/**
 * Tracks when asOf.blockNumber last changed, to tell "data is live" from "Indexer looks stopped".
 */
export class FreshnessTracker {
  constructor(staleAfterMs = STALE_AFTER_MS) {
    this.staleAfterMs = staleAfterMs;
    /** @type {number | null} */
    this.blockNumber = null;
    this.changedAt = 0;
  }

  /**
   * Records an asOf seen at `nowMs`. Returns true when the block number changed (time to redraw).
   * @param {number} blockNumber
   * @param {number} nowMs
   */
  update(blockNumber, nowMs) {
    if (blockNumber === this.blockNumber) return false;
    this.blockNumber = blockNumber;
    this.changedAt = nowMs;
    return true;
  }

  /** @param {number} nowMs */
  isStale(nowMs) {
    return this.blockNumber !== null && nowMs - this.changedAt > this.staleAfterMs;
  }
}

/**
 * Address typed into the search box, or null when it is not 0x + 40 hex characters.
 * Mixed case is fine: the API lowercases it (design.md 10번).
 * @param {string} input
 * @returns {string | null}
 */
export function parseAddress(input) {
  const s = input.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}

/**
 * "#/" (경매 진행), "#/auctions", "#/auctions?status=active", "#/auctions/3", "#/users/0x…" → a route
 * object. Unknown → 경매 진행, the first screen.
 * @param {string} hash
 * @returns {{ name: "stage" } | { name: "list", status: "" | "active" | "finalized" } | { name: "auction", id: string } | { name: "user", address: string }}
 */
export function parseRoute(hash) {
  const path = hash.replace(/^#/, "") || "/";
  if (path === "/auctions") return { name: "list", status: "" };
  let m = /^\/auctions\/(\d{1,78})$/.exec(path);
  if (m) return { name: "auction", id: /** @type {string} */ (m[1]) };
  m = /^\/users\/(0x[0-9a-fA-F]{40})$/.exec(path);
  if (m) return { name: "user", address: /** @type {string} */ (m[1]).toLowerCase() };
  const status = /^\/auctions\?status=(active|finalized)$/.exec(path)?.[1];
  if (status) return { name: "list", status: /** @type {"active" | "finalized"} */ (status) };
  return { name: "stage" };
}
