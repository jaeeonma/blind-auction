// The three read-only screens (design.md 17번 A). Each takes API data and returns DOM nodes built with el().
import { el } from "./dom.js";
import {
  PHASES,
  bidResult,
  formatEth,
  formatTime,
  nextStep,
  shortAddress,
  statusLabel,
} from "./format.js";

/**
 * @typedef {{ blockNumber: number, blockTime: number }} AsOf
 * @typedef {{ winner: string | null, winningBid: string, forfeited: string }} Result
 * @typedef {{ auctionId: string, seller: string, nftAddress: string, tokenId: string, biddingEnd: number,
 *             revealEnd: number, status: string, result: Result | null }} Auction
 * @typedef {{ bidder: string, commitment: string, deposit: string, revealed: boolean, value: string | null,
 *             result: string }} Bid
 */

/** @param {string} status */
const statusBadge = (status) => el("span", { class: `badge status-${status}` }, statusLabel(status));
/**
 * @param {string} result
 * @param {string} auctionStatus
 */
const resultBadge = (result, auctionStatus) => {
  const r = bidResult(result, auctionStatus);
  return el("span", { class: `badge result-${r.code}` }, r.label);
};
/** @param {string} address */
const addressLink = (address) =>
  el("a", { href: `#/users/${address}`, title: address, class: "mono" }, shortAddress(address));

/**
 * @param {Auction} a
 */
function resultSummary(a) {
  if (!a.result) return el("span", { class: "muted" }, "-");
  if (!a.result.winner) return el("span", { class: "muted" }, "유효 입찰 없음");
  return el("span", {}, addressLink(a.result.winner), ` · ${formatEth(a.result.winningBid)}`);
}

/**
 * @param {Auction} a
 * @param {number} blockTime
 */
function nextStepCell(a, blockTime) {
  const step = nextStep(a, blockTime);
  return step.remaining ? el("span", {}, `${step.label} `, el("strong", {}, step.remaining)) : el("span", { class: "muted" }, step.label);
}

const FILTERS = /** @type {const} */ ([
  ["", "전체"],
  ["active", "진행 중"],
  ["finalized", "종료"],
]);

/**
 * 경매 목록
 * @param {{ asOf: AsOf, auctions: Auction[] }} data
 * @param {"" | "active" | "finalized"} status
 */
export function auctionList(data, status) {
  const tabs = el(
    "nav",
    { class: "tabs" },
    FILTERS.map(([value, label]) =>
      el("a", { href: value ? `#/auctions?status=${value}` : "#/auctions", class: value === status ? "tab active" : "tab" }, label),
    ),
  );
  if (data.auctions.length === 0) {
    return [el("h1", {}, "경매 목록"), tabs, el("p", { class: "empty" }, "경매가 없습니다.")];
  }
  const rows = data.auctions.map((a) =>
    el(
      "tr",
      {},
      el("td", {}, el("a", { href: `#/auctions/${a.auctionId}` }, `${a.auctionId}번`)),
      el("td", {}, statusBadge(a.status)),
      el("td", {}, `토큰 ${a.tokenId}번`),
      el("td", {}, addressLink(a.seller)),
      el("td", {}, nextStepCell(a, data.asOf.blockTime)),
      el("td", {}, resultSummary(a)),
    ),
  );
  return [
    el("h1", {}, "경매 목록"),
    tabs,
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ["경매", "상태", "대상", "판매자", "다음 단계", "결과 (낙찰자 · 낙찰가)"].map((h) => el("th", {}, h)))),
      el("tbody", {}, rows),
    ),
  ];
}

/**
 * The four phases with the current one highlighted.
 * @param {string} status
 */
export function phaseSteps(status) {
  const current = PHASES.indexOf(status);
  return el(
    "ol",
    { class: "steps" },
    PHASES.map((p, i) => el("li", { class: i < current ? "done" : i === current ? "current" : "" }, statusLabel(p))),
  );
}

/**
 * 경매 상세
 * @param {{ asOf: AsOf, auction: Auction & { bids: Bid[] } }} data
 */
export function auctionDetail(data) {
  const a = data.auction;
  const step = nextStep(a, data.asOf.blockTime);

  const info = el(
    "dl",
    { class: "info" },
    el("dt", {}, "판매자"),
    el("dd", {}, addressLink(a.seller), el("span", { class: "mono muted full" }, a.seller)),
    el("dt", {}, "경매 대상"),
    el("dd", {}, `토큰 ${a.tokenId}번 `, el("span", { class: "mono muted" }, `(NFT ${a.nftAddress})`)),
    el("dt", {}, "입찰 마감"),
    el("dd", {}, formatTime(a.biddingEnd)),
    el("dt", {}, "공개 마감"),
    el("dd", {}, formatTime(a.revealEnd)),
    el("dt", {}, "다음 단계"),
    el("dd", {}, step.remaining ? `${step.label} ${step.remaining}` : step.label),
  );

  return [
    el("p", { class: "crumb" }, el("a", { href: "#/auctions" }, "← 경매 목록")),
    el("h1", {}, `경매 ${a.auctionId}번 `, statusBadge(a.status)),
    phaseSteps(a.status),
    el("section", {}, el("h2", {}, "경매 정보"), info),
    el("section", {}, el("h2", {}, "결과"), resultBlock(a)),
    el("section", {}, el("h2", {}, `입찰 (${a.bids.length})`), bidsTable(a)),
  ];
}

/**
 * 결과 (winner, winning bid, forfeited). Shared by the detail and the 경매 진행 screen.
 * @param {Auction} a
 */
export function resultBlock(a) {
  if (!a.result) return el("p", { class: "muted" }, "아직 종료되지 않았습니다. 종료되면 낙찰자와 정산 결과가 여기에 나옵니다.");
  if (!a.result.winner)
    return el("p", {}, "유효 입찰이 없어 NFT는 판매자에게 돌아갔습니다. 몰수금: ", el("strong", {}, formatEth(a.result.forfeited)));
  return el(
      "dl",
      { class: "info" },
      el("dt", {}, "낙찰자"),
      el("dd", {}, addressLink(a.result.winner), el("span", { class: "mono muted full" }, a.result.winner)),
      el("dt", {}, "낙찰가"),
      el("dd", {}, el("strong", {}, formatEth(a.result.winningBid))),
      el("dt", {}, "몰수금"),
      el("dd", {}, `${formatEth(a.result.forfeited)} (공개하지 않은 입찰의 보증금, 판매자 몫)`),
    );
}

/**
 * 입찰 목록 (the value stays "비공개" until revealed). Shared by the detail and the 경매 진행 screen.
 * @param {Auction & { bids: Bid[] }} a
 */
export function bidsTable(a) {
  return a.bids.length === 0
    ? el("p", { class: "empty" }, "아직 입찰이 없습니다.")
    : el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ["입찰자", "보증금", "공개", "입찰가", "결과", "해시"].map((h) => el("th", {}, h)))),
        el(
          "tbody",
          {},
          a.bids.map((b) =>
            el(
              "tr",
              {},
              el("td", {}, addressLink(b.bidder)),
              el("td", { class: "num" }, formatEth(b.deposit)),
              el("td", {}, b.revealed ? "공개함" : "-"),
              el("td", { class: "num" }, b.value === null ? el("span", { class: "muted" }, "비공개") : formatEth(b.value)),
              el("td", {}, resultBadge(b.result, a.status)),
              el("td", { class: "mono muted", title: b.commitment }, shortAddress(b.commitment)),
            ),
          ),
        ),
      );
}

/**
 * 사용자별 참여 경매
 * @param {{ asOf: AsOf, address: string, auctions: Array<Auction & { myBid: Bid }> }} data
 */
export function userAuctions(data) {
  const header = [
    el("p", { class: "crumb" }, el("a", { href: "#/auctions" }, "← 경매 목록")),
    el("h1", {}, "참여한 경매"),
    el("p", { class: "mono" }, data.address),
  ];
  if (data.auctions.length === 0) return [...header, el("p", { class: "empty" }, "이 주소로 입찰한 경매가 없습니다.")];
  return [
    ...header,
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, ["경매", "상태", "내 보증금", "내 입찰가", "내 결과", "낙찰자 · 낙찰가"].map((h) => el("th", {}, h)))),
      el(
        "tbody",
        {},
        data.auctions.map((a) =>
          el(
            "tr",
            {},
            el("td", {}, el("a", { href: `#/auctions/${a.auctionId}` }, `${a.auctionId}번`)),
            el("td", {}, statusBadge(a.status)),
            el("td", { class: "num" }, formatEth(a.myBid.deposit)),
            el("td", { class: "num" }, a.myBid.value === null ? el("span", { class: "muted" }, "비공개") : formatEth(a.myBid.value)),
            el("td", {}, resultBadge(a.myBid.result, a.status)),
            el("td", {}, resultSummary(a)),
          ),
        ),
      ),
    ),
  ];
}
