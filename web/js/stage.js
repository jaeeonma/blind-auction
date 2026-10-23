// 경매 진행 화면 (design.md 17번 B), the first screen: the current auction from start to payout on one
// page. Top: phase, what to do next, time button, 새 경매 시작. Middle: one card per demo account with
// the one button its phase allows (and why it is off). Bottom: bids and result as the API has them.
// Each part is redrawn only when what it shows changed, so the bid inputs survive the 3 s refresh.
import { ApiError, getAuction, listAuctions } from "./api.js";
import { ROLES, cardFor, guide, loadStage } from "./demo.js";
import { el, replace } from "./dom.js";
import { formatEth, formatEthShort, shortAddress } from "./format.js";
import { bidsTable, phaseSteps, resultBlock } from "./views.js";

/** A small "only on a local test node" tag, next to the test accounts and the time button (design.md 17번). */
const localOnlyTag = () => el("span", { class: "local-only" }, "로컬 테스트 노드 전용");

/** @typedef {import("./participate.js").Participation} Participation */
/** @typedef {import("./demo.js").Stage} Stage */
/** @typedef {import("./demo.js").Person} Person */

/** A part of the screen that is replaced only when its key changes. */
class Part {
  /** @param {HTMLElement} box */
  constructor(box) {
    this.box = box;
    this.key = "";
  }

  /**
   * @param {string} key
   * @param {() => Array<Node | string>} build
   */
  show(key, build) {
    if (key === this.key) return;
    this.key = key;
    replace(this.box, ...build());
  }
}

/**
 * A button that is off for a reason, with the reason next to it (design.md 17번: an off button says why).
 * @param {string} label
 * @param {string} reason empty: the button can be pressed
 * @param {() => void} onClick
 * @param {string} [cls]
 */
function actionButton(label, reason, onClick, cls = "") {
  const button = el("button", { type: "button", class: cls }, label);
  if (reason) button.setAttribute("disabled", "");
  else button.addEventListener("click", onClick);
  return el("span", { class: "action" }, button, reason ? el("span", { class: "why" }, reason) : null);
}

export class StageScreen {
  /** @param {Participation} p */
  constructor(p) {
    this.p = p;
    this.top = new Part(el("section", { class: "stage-top" }));
    /** One card per demo account; each has a line that may change freely and an action part. */
    this.cards = ROLES.map((role) => {
      const info = new Part(el("div", { class: "card-info" }));
      const action = new Part(el("div", { class: "card-action" }));
      const box = el(
        "section",
        { class: "card" },
        el("h3", {}, role.seller ? "판매자" : role.name, " ", el("span", { class: "muted" }, `(계정 ${role.index}번)`)),
        info.box,
        role.note ? el("p", { class: "hint" }, role.note) : null,
        action.box,
      );
      return { role, box, info, action };
    });
    this.tools = new Part(el("p", { class: "stage-tools" }));
    this.bottom = new Part(el("section", { class: "stage-bottom" }));
    this.cardsBox = el("div", { class: "cards" }, this.cards.map((c) => c.box));
    this.root = el("div", { class: "stage" }, this.top.box, this.cardsBox, this.tools.box, this.bottom.box);
    this.running = false;
    this.again = false;
  }

  /**
   * Reads the chain and the API and updates what changed. Returns the API's asOf for the header.
   * Calls that arrive while one is running are folded into one more run.
   * @returns {Promise<import("./views.js").AsOf | null>}
   */
  async refresh() {
    if (this.running) {
      this.again = true;
      return null;
    }
    this.running = true;
    try {
      let asOf;
      do {
        this.again = false;
        asOf = await this.update();
      } while (this.again);
      return asOf;
    } finally {
      this.running = false;
    }
  }

  async update() {
    const p = this.p;
    const ready = !p.connecting && p.chain !== null && p.store !== null;
    // Without a node there is nothing the cards could do.
    this.cardsBox.hidden = !ready;
    this.tools.box.hidden = !ready;
    this.bottom.box.hidden = !ready;
    if (p.connecting) {
      this.top.show("connecting", () => [el("h1", {}, "경매 진행"), el("p", { class: "muted" }, "노드에 연결하는 중…")]);
      return (await listAuctions("")).asOf;
    }
    if (!p.chain || !p.store) {
      this.top.show(`off:${p.problem}`, () => [
        el("h1", {}, "경매 진행"),
        el("p", { class: "warn" }, p.problem || "브라우저 저장소를 쓸 수 없어 참여 기능을 쓸 수 없습니다 (secret을 저장할 곳이 없음)"),
        p.rpcWarning ? el("p", { class: "warn" }, p.rpcWarning) : null,
        el("p", { class: "muted" }, "경매 조회는 위 메뉴의 경매 목록에서 할 수 있습니다."),
      ].filter((x) => x !== null));
      return (await listAuctions("")).asOf;
    }

    const stage = await loadStage(p.chain, p.store, p.accounts.slice(0, ROLES.length).map((a) => a.address));
    this.showTop(stage);
    for (const card of this.cards) this.showCard(card, stage);
    this.showTools();
    return this.showBottom(stage);
  }

  /** @param {Stage} s */
  showTop(s) {
    const g = guide(s);
    this.top.show(JSON.stringify([s.auctionId?.toString(), s.phase, g.text, this.p.rpcWarning]), () => [
      el(
        "div",
        { class: "stage-head" },
        el(
          "h1",
          {},
          s.auctionId === null ? "경매 진행" : `경매 ${s.auctionId}번`,
          s.auctionId === null ? null : el("a", { href: `#/auctions/${s.auctionId}`, class: "small-link" }, "상세 화면"),
        ),
        actionButton("새 경매 시작", "", () => void this.p.startAuction(), "primary"),
      ),
      s.auctionId === null ? null : phaseSteps(s.phase),
      el("p", { class: "guide" }, el("strong", {}, "다음에 할 일: "), g.text),
      g.move === null
        ? null
        : el(
            "p",
            { class: "time-tools" },
            actionButton(
              `${g.moveLabel} ▶`,
              "",
              () => void this.p.moveTime(/** @type {bigint} */ (s.auctionId), /** @type {"reveal" | "end"} */ (g.move)),
            ),
            " ",
            localOnlyTag(),
            el("span", { class: "hint" }, " 노드의 블록 시간을 이 경매의 마감 시각으로 옮깁니다. 되돌릴 수 없습니다."),
          ),
      this.p.rpcWarning ? el("p", { class: "warn" }, this.p.rpcWarning) : null,
    ].filter((x) => x !== null));
  }

  /**
   * @param {{ role: import("./demo.js").Role, info: Part, action: Part }} card
   * @param {Stage} s
   */
  showCard(card, s) {
    const person = /** @type {Person} */ (s.people[card.role.index]);
    card.info.show(JSON.stringify([person.address, person.balance.toString(), person.pending.toString()]), () => [
      el("p", { class: "mono muted", title: person.address }, shortAddress(person.address)),
      el("p", {}, `잔액 ${formatEthShort(person.balance)}`),
      el("p", {}, "장부 ", el("strong", {}, formatEth(person.pending.toString()))),
    ]);

    const { status, action } = cardFor(person, s);
    const auctionId = /** @type {bigint} */ (s.auctionId);
    const index = card.role.index;
    card.action.show(JSON.stringify([s.auctionId?.toString(), s.phase, status, action]), () => {
      /** @type {Array<Node | string>} */
      const nodes = status ? [el("p", { class: "status" }, status)] : [];
      if (!action) return nodes;
      if (action.kind === "bid" && !action.reason) {
        nodes.push(this.bidForm(index, auctionId, card.role.value, card.role.deposit));
        return nodes;
      }
      const run = {
        bid: () => {},
        reveal: () => void this.p.reveal(auctionId, index),
        finalize: () => void this.p.finalize(auctionId, index),
        withdraw: () => void this.p.withdraw(index),
      }[action.kind];
      nodes.push(actionButton(action.label, action.reason, run));
      return nodes;
    });
  }

  /**
   * Bid form prefilled with the design.md 7번 example; the values can be changed.
   * @param {number} index
   * @param {bigint} auctionId
   * @param {string} value
   * @param {string} deposit
   */
  bidForm(index, auctionId, value, deposit) {
    const valueInput = /** @type {HTMLInputElement} */ (el("input", { name: "value", type: "text", inputmode: "decimal", value, required: "" }));
    const depositInput = /** @type {HTMLInputElement} */ (el("input", { name: "deposit", type: "text", inputmode: "decimal", value: deposit, required: "" }));
    const form = /** @type {HTMLFormElement} */ (
      el(
        "form",
        { class: "bid-form", autocomplete: "off" },
        el("label", {}, "입찰가 ", valueInput, " ETH"),
        el("label", {}, "보증금 ", depositInput, " ETH"),
        el("button", { type: "submit" }, "입찰"),
      )
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.p.bid(auctionId, valueInput.value, depositInput.value, index);
    });
    return form;
  }

  /** Test accounts note, saved bids, export and import (design.md 17번). */
  showTools() {
    const count = this.p.store?.list().length ?? 0;
    this.tools.show(String(count), () => {
      const input = /** @type {HTMLInputElement} */ (el("input", { type: "file", accept: ".json,application/json", multiple: "", hidden: "" }));
      input.addEventListener("change", () => void this.p.importFiles(input));
      return [
        "카드는 노드의 테스트 계정 0~4번입니다 ",
        localOnlyTag(),
        ` · 이 브라우저에 저장된 입찰 ${count}건 `,
        actionButton("내보내기 (JSON)", count === 0 ? "저장된 입찰이 없습니다" : "", () => this.p.exportBids(), "small"),
        " ",
        actionButton("가져오기", "", () => input.click(), "small"),
        input,
        el("span", { class: "hint" }, " 입찰가와 secret은 이 브라우저에만 있습니다. 저장소를 지우기 전에 내보내 두세요."),
      ];
    });
  }

  /**
   * Bids and result of the current auction as the API has them (Indexer → DB, design.md 17번 A).
   * @param {Stage} s
   */
  async showBottom(s) {
    if (s.auctionId === null) {
      this.bottom.box.hidden = true;
      this.bottom.show("none", () => []);
      return (await listAuctions("")).asOf;
    }
    try {
      const data = await getAuction(s.auctionId.toString());
      const a = data.auction;
      this.bottom.show(JSON.stringify([a.auctionId, data.asOf.blockNumber]), () => [
        el("h2", {}, `입찰 현황 (${a.bids.length}) `, el("span", { class: "muted" }, "· Indexer가 읽은 블록 기준, 공개 전 입찰가는 비공개")),
        bidsTable(a),
        el("h2", {}, "결과"),
        resultBlock(a),
      ]);
      return data.asOf;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      this.bottom.show(`missing:${s.auctionId}`, () => [
        el("h2", {}, "입찰 현황"),
        el("p", { class: "muted" }, "Indexer가 아직 이 경매를 읽지 않았습니다. 몇 초 뒤에 나옵니다."),
      ]);
      return (await listAuctions("")).asOf;
    }
  }
}
