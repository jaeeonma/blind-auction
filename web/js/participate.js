// Participation UI (design.md 17번 B): the account bar, and running a transaction with feedback.
// The transactions themselves are in actions.js; this file only wires them to the page.
import { ChainSetupError, connect, rpcUrlFrom, testAccounts } from "./chain.js";
import { findBid, keyFor, parseEthAmount, pendingOf, phaseOf, placeBid, revealFromStore, withdrawAll } from "./actions.js";
import { el, replace } from "./dom.js";
import { formatEth, formatEthShort, shortAddress } from "./format.js";
import { auctionPanel } from "./panels.js";
import { browserStore } from "./secrets.js";

const ACCOUNT_KEY = "blind-auction:account";
/** Roles of the design.md 7번 example (and of `npm run demo`). */
export const ROLE_HINT = /** @type {Record<number, string>} */ ({ 0: "판매자", 1: "A", 2: "B", 3: "C", 4: "D" });

/** @typedef {import("./chain.js").Chain} Chain */

/** A small "only on a local test node" tag, shown next to the test accounts and the time tools. */
export const localOnlyTag = () => el("span", { class: "local-only" }, "로컬 테스트 노드 전용");

export class Participation {
  /**
   * @param {{ accountBox: HTMLElement, notice: HTMLElement, panel: HTMLElement, onTransaction: () => void }} parts
   */
  constructor(parts) {
    this.accountBox = parts.accountBox;
    this.notice = parts.notice;
    this.panelBox = parts.panel;
    /** What the panel shows now; it is redrawn only when this changes, so typed input survives refreshes. */
    this.panelKey = "";
    this.store = browserStore();
    this.onTransaction = parts.onTransaction;
    /** @type {Chain | null} */
    this.chain = null;
    /** @type {Array<{ index: number, address: string, balance: bigint }>} */
    this.accounts = [];
    this.accountIndex = Number(readSetting(ACCOUNT_KEY) ?? 0);
    /** Block of the last transaction sent from this page; shown until the Indexer has read it. */
    this.waitingForBlock = 0;
    this.busy = false;
    /** @type {HTMLElement | null} */
    this.infoBox = null;
  }

  /** Connects to the node. Read-only screens keep working when this fails. */
  async init() {
    try {
      const res = await fetch("/deployment.json", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new ChainSetupError(body.error ?? "배포 기록을 읽지 못했습니다");
      this.chain = await connect(rpcUrlFrom(location.search), body);
      this.accounts = await testAccounts(this.chain.provider);
      if (!this.accounts[this.accountIndex]) this.accountIndex = 0;
      this.renderAccountBar();
    } catch (err) {
      this.chain = null;
      replace(this.accountBox, el("span", { class: "muted" }, `참여 기능을 쓸 수 없습니다: ${errorMessage(err)}`));
    }
  }

  /**
   * The panel of the current page (design.md 17번 B), from the chain's state for the selected account.
   * Called with every refresh; does nothing when nothing changed.
   * @param {{ name: string, id?: string }} route
   */
  async updatePanel(route) {
    if (!this.chain || !this.account || route.name !== "auction" || route.id === undefined) {
      this.setPanel("none");
      return;
    }
    const chain = this.chain;
    const auctionId = BigInt(route.id);
    const account = this.account.address;
    let phase;
    try {
      phase = await phaseOf(chain, auctionId);
    } catch {
      this.setPanel("none"); // unknown auction: the page itself says so
      return;
    }
    const bid = await findBid(chain, auctionId, account);
    let saved = null;
    let savedError = "";
    try {
      saved = this.store?.load(keyFor(chain, auctionId, account)) ?? null;
    } catch (err) {
      savedError = errorMessage(err);
    }
    if (this.account.address !== account) return; // the account changed meanwhile; a newer call follows
    const key = JSON.stringify([route.id, account, phase, bid?.commitment, bid?.revealed, saved?.secret, savedError]);
    this.setPanel(key, () =>
      auctionPanel(
        { auctionId, phase, account, bid, saved, savedError, storeAvailable: this.store !== null },
        {
          bid: (value, deposit) => void this.bid(auctionId, value, deposit),
          reveal: () => void this.reveal(auctionId),
        },
      ),
    );
  }

  /**
   * @param {string} key
   * @param {() => HTMLElement} [build]
   */
  setPanel(key, build) {
    if (key === this.panelKey) return;
    this.panelKey = key;
    if (build) replace(this.panelBox, build());
    else replace(this.panelBox);
  }

  /**
   * @param {bigint} auctionId
   * @param {string} valueInput ETH
   * @param {string} depositInput ETH
   */
  bid(auctionId, valueInput, depositInput) {
    return this.run("입찰", async () => {
      const value = parseEthAmount(valueInput);
      const deposit = parseEthAmount(depositInput);
      if (!this.store) throw new Error("이 브라우저는 저장소를 쓸 수 없어서 입찰할 수 없습니다");
      const r = await placeBid(/** @type {Chain} */ (this.chain), await this.signer(), this.store, auctionId, value, deposit);
      return {
        blockNumber: r.blockNumber,
        warnings: [...r.warnings, ...(r.replaced ? ["이전에 보내지 못한 입찰의 저장값을 새 secret으로 바꿨습니다."] : [])],
        message: `경매 ${auctionId}번에 입찰했습니다. 입찰가와 secret은 이 브라우저에 저장했습니다. 보증금: ${formatEth(deposit.toString())}`,
      };
    });
  }

  /** @param {bigint} auctionId */
  reveal(auctionId) {
    return this.run("공개", async () => {
      if (!this.store) throw new Error("이 브라우저는 저장소를 쓸 수 없습니다");
      const r = await revealFromStore(/** @type {Chain} */ (this.chain), await this.signer(), this.store, auctionId);
      return {
        blockNumber: r.blockNumber,
        message: `경매 ${auctionId}번 입찰을 공개했습니다: ${r.valid ? "유효" : "무효 (보증금 전액을 장부에 적음)"}, 입찰가 ${formatEth(r.value.toString())}`,
      };
    });
  }

  get account() {
    return this.accounts[this.accountIndex];
  }

  /** @returns {Promise<import("ethers").JsonRpcSigner>} */
  signer() {
    if (!this.chain) throw new Error("노드에 연결되지 않았습니다");
    return this.chain.provider.getSigner(this.accountIndex);
  }

  renderAccountBar() {
    const select = /** @type {HTMLSelectElement} */ (
      el(
        "select",
        { "aria-label": "계정 선택" },
        this.accounts.map((a) =>
          el("option", { value: String(a.index) }, `계정 ${a.index}${ROLE_HINT[a.index] ? ` (${ROLE_HINT[a.index]})` : ""} · ${shortAddress(a.address)}`),
        ),
      )
    );
    select.value = String(this.accountIndex);
    select.addEventListener("change", () => {
      this.accountIndex = Number(select.value);
      writeSetting(ACCOUNT_KEY, select.value);
      void this.refreshAccount();
      this.onTransaction(); // panels depend on the account
    });
    this.infoBox = el("span", { class: "account-info" });
    replace(this.accountBox, el("label", {}, "계정 ", select), localOnlyTag(), this.infoBox);
    void this.refreshAccount();
  }

  /** Balance and ledger of the selected account; called on every new block. */
  async refreshAccount() {
    if (!this.chain || !this.account || !this.infoBox) return;
    const address = this.account.address;
    const [balance, pending] = await Promise.all([this.chain.provider.getBalance(address), pendingOf(this.chain, address)]);
    const withdraw = el("button", { type: "button", class: "small" }, "출금");
    withdraw.toggleAttribute("disabled", pending === 0n || this.busy);
    withdraw.addEventListener("click", () =>
      void this.run("출금", async () => {
        const r = await withdrawAll(/** @type {Chain} */ (this.chain), await this.signer());
        return { blockNumber: r.blockNumber, message: `출금했습니다: ${formatEth(r.amount.toString())}` };
      }),
    );
    replace(
      this.infoBox,
      el("span", { class: "mono", title: address }, shortAddress(address)),
      ` 잔액 ${formatEthShort(balance)} · 장부 `,
      el("strong", {}, formatEth(pending.toString())),
      " ",
      withdraw,
    );
  }

  /**
   * Runs one transaction with feedback: one at a time, result or error in the notice line.
   * @param {string} label shown while sending
   * @param {() => Promise<{ blockNumber: number, message: string, warnings?: string[] }>} action
   * @returns {Promise<boolean>} true when it succeeded
   */
  async run(label, action) {
    if (this.busy) return false;
    this.busy = true;
    this.show("busy", `${label}: 트랜잭션을 보내는 중…`);
    try {
      const r = await action();
      this.waitingForBlock = r.blockNumber;
      this.show("ok", [...(r.warnings ?? []).map((w) => `경고: ${w}`), r.message].join(" "));
      return true;
    } catch (err) {
      this.show("error", `${label} 실패: ${errorMessage(err)}`);
      return false;
    } finally {
      this.busy = false;
      void this.refreshAccount();
      this.onTransaction();
    }
  }

  /**
   * @param {"ok" | "busy" | "error"} kind
   * @param {string} text
   */
  show(kind, text) {
    replace(this.notice, el("p", { class: `notice ${kind}` }, text));
  }

  /**
   * Called with every asOf: tells when the Indexer has caught up with the last transaction.
   * @param {number} blockNumber
   */
  indexedUpTo(blockNumber) {
    if (this.waitingForBlock && blockNumber < this.waitingForBlock) {
      return `화면 반영 대기 중: 트랜잭션 블록 #${this.waitingForBlock}, Indexer는 #${blockNumber}`;
    }
    this.waitingForBlock = 0;
    return "";
  }
}

/**
 * A readable message: custom errors of the contract by name, otherwise ethers' short reason.
 * @param {unknown} err
 */
export function errorMessage(err) {
  /** @type {any} */
  const e = err;
  if (e?.revert?.name) return `컨트랙트가 거절했습니다 (${e.revert.name})`;
  return String(e?.shortMessage ?? e?.message ?? err);
}

/**
 * localStorage may be unavailable (private mode, blocked site data); settings are only a convenience.
 * @param {string} key
 */
function readSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {string} value
 */
function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore: the selection just is not remembered
  }
}
