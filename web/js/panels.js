// Participation panels (design.md 17번 B): what the selected account can do on the current page.
// Only builds elements; the state comes from the chain (participate.js) and every button calls back.
import { el } from "./dom.js";
import { formatEth, statusLabel } from "./format.js";

/**
 * @typedef {{ commitment: string, deposit: bigint, revealed: boolean }} ChainBid
 * @typedef {{
 *   auctionId: bigint,
 *   phase: string,
 *   account: string,
 *   bid: ChainBid | null,
 *   saved: import("./secrets.js").SavedBid | null,
 *   savedError: string,
 *   storeAvailable: boolean,
 * }} AuctionState
 * @typedef {{
 *   bid: (value: string, deposit: string) => void,
 *   reveal: () => void,
 *   finalize: () => void,
 *   moveTime: (to: "reveal" | "end") => void,
 * }} AuctionHandlers
 * @typedef {{
 *   mint: () => void,
 *   create: (tokenId: string, bidding: string, reveal: string) => void,
 * }} CreateHandlers
 */

/** A small "only on a local test node" tag, shown next to the test accounts and the time tools. */
export const localOnlyTag = () => el("span", { class: "local-only" }, "로컬 테스트 노드 전용");

/** Note under the bid form: where the secret lives and what losing it means (design.md 4번 Q4, 17번). */
const STORAGE_NOTE =
  "입찰가와 secret은 서버가 아니라 이 브라우저에만 저장됩니다 (보내기 전에 저장). " +
  "공개할 때도 같은 브라우저, 같은 주소(localhost와 127.0.0.1은 다른 저장소)로 접속해야 하고, " +
  "브라우저 저장소를 지우면 공개할 수 없어 보증금이 몰수됩니다.";

/**
 * "내 참여" panel of an auction detail page.
 * @param {AuctionState} s
 * @param {AuctionHandlers} on
 */
export function auctionPanel(s, on) {
  return el(
    "section",
    { class: "panel" },
    el("h2", {}, `내 참여 · 경매 ${s.auctionId}번 `, el("span", { class: "muted" }, `(체인 기준: ${statusLabel(s.phase)})`)),
    ...body(s, on),
    timeTools(s, on),
  );
}

/**
 * @param {AuctionState} s
 * @param {AuctionHandlers} on
 * @returns {HTMLElement[]}
 */
function body(s, on) {
  if (s.savedError) return [el("p", { class: "warn" }, s.savedError)];
  switch (s.phase) {
    case "bidding":
      return s.bid ? [bidSummary(s)] : [bidForm(s, on)];
    case "revealing":
      if (!s.bid) return [el("p", { class: "muted" }, "이 계정은 이 경매에 입찰하지 않았습니다.")];
      if (s.bid.revealed) return [bidSummary(s)];
      return [bidSummary(s), revealBox(s, on)];
    case "awaiting_finalize":
      return [s.bid ? bidSummary(s) : el("p", { class: "muted" }, "이 계정은 이 경매에 입찰하지 않았습니다."), finalizeBox(on)];
    default:
      return [el("p", { class: "muted" }, "종료된 경매입니다. 돌려받을 돈과 판매 대금은 위 계정 줄의 장부에서 출금합니다.")];
  }
}

/** @param {AuctionState} s */
function bidSummary(s) {
  const bid = /** @type {ChainBid} */ (s.bid);
  return el(
    "p",
    {},
    bid.revealed ? "공개한 입찰입니다. " : "입찰했습니다 (해시만 체인에 있음). ",
    `보증금 ${formatEth(bid.deposit.toString())} · `,
    s.saved
      ? `이 브라우저에 저장된 입찰가 ${formatEth(s.saved.value)}`
      : el("span", { class: "warn" }, "이 브라우저에는 secret이 없습니다 (다른 브라우저나 스크립트로 입찰했다면 그쪽에서 공개하세요)"),
  );
}

/**
 * @param {AuctionState} s
 * @param {AuctionHandlers} on
 */
function bidForm(s, on) {
  const value = /** @type {HTMLInputElement} */ (el("input", { name: "value", type: "text", inputmode: "decimal", placeholder: "예: 5", required: "" }));
  const deposit = /** @type {HTMLInputElement} */ (el("input", { name: "deposit", type: "text", inputmode: "decimal", placeholder: "예: 6", required: "" }));
  const submit = el("button", { type: "submit" }, "입찰 (secret 저장 후 전송)");
  if (!s.storeAvailable) submit.setAttribute("disabled", "");
  const form = /** @type {HTMLFormElement} */ (
    el(
      "form",
      { class: "action-form", autocomplete: "off" },
      el("label", {}, "입찰가 (ETH) ", value),
      el("label", {}, "보증금 (ETH) ", deposit),
      submit,
      el(
        "p",
        { class: "hint" },
        "보증금을 입찰가보다 크게 넣으면 실제 입찰가를 숨길 수 있습니다. 보증금이 입찰가보다 적으면 공개 때 무효가 되고 보증금만 돌려받습니다. 지갑당 한 번만 입찰할 수 있습니다.",
      ),
      el("p", { class: "hint" }, s.storeAvailable ? STORAGE_NOTE : el("span", { class: "warn" }, "이 브라우저는 저장소를 쓸 수 없어서 입찰할 수 없습니다 (secret을 저장할 곳이 없음).")),
    )
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    on.bid(value.value, deposit.value);
  });
  return form;
}

/**
 * @param {AuctionState} s
 * @param {AuctionHandlers} on
 */
function revealBox(s, on) {
  const button = el("button", { type: "button" }, "공개");
  if (!s.saved) button.setAttribute("disabled", "");
  button.addEventListener("click", () => on.reveal());
  return el(
    "div",
    { class: "action-form" },
    button,
    el("p", { class: "hint" }, "저장된 입찰가와 secret을 체인의 해시와 먼저 맞춰 본 뒤 보냅니다. 공개 마감까지 공개하지 않으면 보증금은 몰수됩니다."),
  );
}

/** @param {AuctionHandlers} on */
function finalizeBox(on) {
  const button = el("button", { type: "button" }, "경매 종료");
  button.addEventListener("click", () => on.finalize());
  return el(
    "div",
    { class: "action-form" },
    button,
    el("p", { class: "hint" }, "공개 마감이 지났습니다. 판매자가 아니어도 누구나 한 번 종료할 수 있습니다. 종료하면 NFT가 낙찰자(유효 입찰이 없으면 판매자)에게 가고 정산 금액이 장부에 적힙니다."),
  );
}

/**
 * "새 경매 만들기" panel of the auction list: mint a test NFT, then put one of the account's tokens up for auction.
 * @param {{ tokens: bigint[], selected: string }} s tokens the account owns; selected = token id to preselect
 * @param {CreateHandlers} on
 */
export function createPanel(s, on) {
  const mint = el("button", { type: "button", class: "small" }, "테스트 NFT 발행");
  mint.addEventListener("click", () => on.mint());

  const token = /** @type {HTMLSelectElement} */ (
    el("select", { name: "token" }, s.tokens.map((id) => el("option", { value: id.toString() }, `토큰 ${id}번`)))
  );
  if (s.tokens.some((id) => id.toString() === s.selected)) token.value = s.selected;
  const bidding = /** @type {HTMLInputElement} */ (el("input", { name: "bidding", type: "text", value: "10m", required: "" }));
  const reveal = /** @type {HTMLInputElement} */ (el("input", { name: "reveal", type: "text", value: "1d", required: "" }));
  const submit = el("button", { type: "submit" }, "경매 만들기 (승인 후 생성)");
  if (s.tokens.length === 0) {
    token.setAttribute("disabled", "");
    submit.setAttribute("disabled", "");
  }
  const form = /** @type {HTMLFormElement} */ (
    el(
      "form",
      { class: "action-form", autocomplete: "off" },
      el("label", {}, "NFT ", token),
      el("label", {}, "입찰 기간 ", bidding),
      el("label", {}, "공개 기간 ", reveal),
      submit,
      el(
        "p",
        { class: "hint" },
        s.tokens.length === 0
          ? "이 계정이 가진 NFT가 없습니다. 먼저 테스트 NFT를 발행하세요."
          : "입찰 기간은 10m~5d, 공개 기간은 1d~2d (s, m, h, d). NFT는 경매 컨트랙트가 보관하므로 먼저 승인(approve)을 보내고 경매를 만듭니다.",
      ),
    )
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    on.create(token.value, bidding.value, reveal.value);
  });
  return el("section", { class: "panel" }, el("h2", {}, "새 경매 만들기 ", mint), form);
}

/**
 * 시간 앞당기기 (design.md 12·17번): jump the node's block time to the end of the current phase.
 * @param {AuctionState} s
 * @param {AuctionHandlers} on
 */
function timeTools(s, on) {
  /** @type {Record<string, ["reveal" | "end", string]>} */
  const jumps = { bidding: ["reveal", "입찰 마감으로 (공개 시작)"], revealing: ["end", "공개 마감으로 (종료 가능)"] };
  const jump = jumps[s.phase];
  if (!jump) return null;
  const button = el("button", { type: "button", class: "small" }, jump[1]);
  button.addEventListener("click", () => on.moveTime(jump[0]));
  return el(
    "div",
    { class: "action-form time-tools" },
    el("span", {}, "시간 앞당기기"),
    button,
    localOnlyTag(),
    el("p", { class: "hint" }, "노드의 블록 시간을 이 경매의 마감 시각으로 옮겨 블록을 하나 만듭니다. 시간은 되돌릴 수 없고, 같은 노드의 다른 경매 시간도 함께 지나갑니다."),
  );
}
