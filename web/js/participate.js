// Participation UI (design.md 17번 B): the account bar, and running a transaction with feedback.
// The transactions themselves are in actions.js; this file only wires them to the page.
import { ChainSetupError, DEFAULT_RPC_URL, LOCAL_RPC_HOSTS, connect, rpcUrlFrom, testAccounts } from "./chain.js";
import {
  auctionEnds,
  createAuction,
  finalizeAuction,
  findBid,
  importBids,
  keyFor,
  mintNft,
  moveTimeTo,
  ownedTokens,
  parseDuration,
  parseEthAmount,
  pendingOf,
  phaseOf,
  placeBid,
  revealFromStore,
  withdrawAll,
} from "./actions.js";
import { el, replace } from "./dom.js";
import { formatEth, formatEthShort, formatTime, shortAddress } from "./format.js";
import { auctionPanel, createPanel, localOnlyTag } from "./panels.js";
import { startAuction } from "./demo.js";
import { browserStore } from "./secrets.js";

const ACCOUNT_KEY = "blind-auction:account";
/** Roles of the design.md 7번 example (and of `npm run demo`). */
export const ROLE_HINT = /** @type {Record<number, string>} */ ({ 0: "판매자", 1: "A", 2: "B", 3: "C", 4: "D" });

/** @typedef {import("./chain.js").Chain} Chain */

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
    /** Token minted last from this page: preselected in the create form. */
    this.lastMinted = "";
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
    /** Set when ?rpc= was refused; stays on screen. */
    this.rpcWarning = "";
    /** Why participation is not available (no node, wrong deployment record); empty when connected. */
    this.problem = "";
    /** True until init() has finished (connected or failed). */
    this.connecting = true;
  }

  rpcWarningNodes() {
    return this.rpcWarning ? [el("span", { class: "warn" }, this.rpcWarning)] : [];
  }

  /** Downloads every bid saved in this browser as JSON (a backup of the secrets, design.md 17번). */
  exportBids() {
    if (!this.store) return;
    const count = this.store.list().length;
    const url = URL.createObjectURL(new Blob([this.store.exportJson()], { type: "application/json" }));
    const a = el("a", { href: url, download: `blind-auction-bids-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.show("ok", `저장된 입찰 ${count}건을 내보냈습니다. 파일에는 secret이 들어 있으니 다른 사람과 공유하지 마세요.`);
  }

  /** Connects to the node. Read-only screens keep working when this fails. */
  async init() {
    try {
      const res = await fetch("/deployment.json", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new ChainSetupError(body.error ?? "배포 기록을 읽지 못했습니다");
      const rpc = rpcUrlFrom(location.search);
      if (rpc.rejected !== null) {
        // Shown before connecting, so it is there even when the default node is not running.
        this.rpcWarning = `?rpc= 주소는 쓰지 않음 (기본 노드 ${DEFAULT_RPC_URL} 사용)`;
        this.show(
          "error",
          `화면 주소의 ?rpc=는 이 컴퓨터의 노드(${LOCAL_RPC_HOSTS.join(", ")})만 쓸 수 있어서, 받은 주소 대신 기본 노드(${DEFAULT_RPC_URL})를 씁니다. ` +
            `다른 노드는 입찰가와 secret을 받아 갈 수 있습니다. 받은 주소: ${rpc.rejected}`,
        );
      }
      this.chain = await connect(rpc.url, body);
      this.accounts = await testAccounts(this.chain.provider);
      if (!this.accounts[this.accountIndex]) this.accountIndex = 0;
      this.renderAccountBar();
    } catch (err) {
      this.chain = null;
      this.problem = `참여 기능을 쓸 수 없습니다: ${errorMessage(err)}`;
      replace(this.accountBox, el("span", { class: "muted" }, this.problem), ...this.rpcWarningNodes());
    } finally {
      this.connecting = false;
      this.onTransaction(); // draw the screen with the connection result now
    }
  }

  /**
   * The panel of the current page (design.md 17번 B), from the chain's state for the selected account.
   * Called with every refresh; does nothing when nothing changed.
   * @param {{ name: string, id?: string }} route
   */
  async updatePanel(route) {
    if (!this.chain || !this.account) return this.setPanel("none");
    if (route.name === "list") return this.updateCreatePanel();
    if (route.name !== "auction" || route.id === undefined) return this.setPanel("none");
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
          finalize: () => void this.finalize(auctionId),
          moveTime: (to) => void this.moveTime(auctionId, to),
        },
      ),
    );
  }

  async updateCreatePanel() {
    const chain = /** @type {Chain} */ (this.chain);
    const account = /** @type {{ address: string }} */ (this.account).address;
    const tokens = await ownedTokens(chain, account);
    if (this.account?.address !== account) return;
    const key = JSON.stringify(["create", account, tokens.map(String), this.lastMinted]);
    this.setPanel(key, () =>
      createPanel(
        { tokens, selected: this.lastMinted },
        {
          mint: () => void this.mint(),
          create: (tokenId, bidding, reveal) => void this.create(tokenId, bidding, reveal),
        },
      ),
    );
  }

  mint() {
    return this.run("NFT 발행", async () => {
      const r = await mintNft(/** @type {Chain} */ (this.chain), await this.signer());
      this.lastMinted = r.tokenId.toString();
      return { blockNumber: r.blockNumber, message: `테스트 NFT 토큰 ${r.tokenId}번을 발행했습니다 (계정 ${this.accountIndex}번)` };
    });
  }

  /**
   * @param {string} tokenInput
   * @param {string} biddingInput e.g. 10m
   * @param {string} revealInput e.g. 1d
   */
  create(tokenInput, biddingInput, revealInput) {
    return this.run("경매 만들기", async () => {
      if (!/^\d+$/.test(tokenInput)) throw new Error("경매에 올릴 NFT를 고르세요");
      const r = await createAuction(
        /** @type {Chain} */ (this.chain),
        await this.signer(),
        BigInt(tokenInput),
        parseDuration(biddingInput),
        parseDuration(revealInput),
      );
      location.hash = `#/auctions/${r.auctionId}`;
      return {
        blockNumber: r.blockNumber,
        message:
          `경매 ${r.auctionId}번을 만들었습니다${r.approved ? " (승인 후 생성)" : ""}. ` +
          `입찰 마감 ${formatTime(Number(r.biddingEnd))}, 공개 마감 ${formatTime(Number(r.revealEnd))}`,
      };
    });
  }

  /**
   * @param {bigint} auctionId
   * @param {"reveal" | "end"} to
   */
  moveTime(auctionId, to) {
    return this.run("시간 앞당기기", async () => {
      const chain = /** @type {Chain} */ (this.chain);
      const ends = await auctionEnds(chain, auctionId);
      const r = await moveTimeTo(chain, to === "reveal" ? ends.biddingEnd : ends.revealEnd);
      const where = to === "reveal" ? "입찰 마감" : "공개 마감";
      return {
        blockNumber: r.blockNumber,
        message: r.moved
          ? `블록 시간을 경매 ${auctionId}번의 ${where}으로 옮겼습니다: ${formatTime(Number(r.time))}`
          : `이미 경매 ${auctionId}번의 ${where}이 지났습니다. 지금 블록 시간: ${formatTime(Number(r.time))}`,
      };
    });
  }

  /**
   * @param {bigint} auctionId
   * @param {number} [index] account that sends it (anyone may finalize)
   */
  finalize(auctionId, index = this.accountIndex) {
    return this.run("경매 종료", async () => {
      const r = await finalizeAuction(/** @type {Chain} */ (this.chain), await this.signerOf(index), auctionId);
      return {
        blockNumber: r.blockNumber,
        message: r.winner
          ? `경매 ${auctionId}번을 종료했습니다. 낙찰가 ${formatEth(r.winningBid.toString())}, 몰수금 ${formatEth(r.forfeited.toString())}, 낙찰자: ${r.winner}`
          : `경매 ${auctionId}번을 종료했습니다. 유효 입찰이 없어 NFT는 판매자에게 돌아갔습니다. 몰수금: ${formatEth(r.forfeited.toString())}`,
      };
    });
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
   * @param {number} [index] account that bids
   */
  bid(auctionId, valueInput, depositInput, index = this.accountIndex) {
    return this.run("입찰", async () => {
      const value = parseEthAmount(valueInput);
      const deposit = parseEthAmount(depositInput);
      if (!this.store) throw new Error("이 브라우저는 저장소를 쓸 수 없어서 입찰할 수 없습니다");
      const r = await placeBid(/** @type {Chain} */ (this.chain), await this.signerOf(index), this.store, auctionId, value, deposit);
      return {
        blockNumber: r.blockNumber,
        warnings: [...r.warnings, ...(r.replaced ? ["이전에 보내지 못한 입찰의 저장값을 새 secret으로 바꿨습니다."] : [])],
        message: `경매 ${auctionId}번에 입찰했습니다. 입찰가와 secret은 이 브라우저에 저장했습니다. 보증금: ${formatEth(deposit.toString())}`,
      };
    });
  }

  /**
   * @param {bigint} auctionId
   * @param {number} [index] account that reveals
   */
  reveal(auctionId, index = this.accountIndex) {
    return this.run("공개", async () => {
      if (!this.store) throw new Error("이 브라우저는 저장소를 쓸 수 없습니다");
      const r = await revealFromStore(/** @type {Chain} */ (this.chain), await this.signerOf(index), this.store, auctionId);
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
    return this.signerOf(this.accountIndex);
  }

  /**
   * A test account of the local node, by number (the node signs; no wallet, design.md 17번).
   * @param {number} index
   * @returns {Promise<import("ethers").JsonRpcSigner>}
   */
  signerOf(index) {
    if (!this.chain) throw new Error("노드에 연결되지 않았습니다");
    return this.chain.provider.getSigner(index);
  }

  /**
   * 출금 of one account's whole ledger.
   * @param {number} index
   */
  withdraw(index) {
    return this.run("출금", async () => {
      const r = await withdrawAll(/** @type {Chain} */ (this.chain), await this.signerOf(index));
      return { blockNumber: r.blockNumber, message: `출금했습니다 (계정 ${index}번): ${formatEth(r.amount.toString())}` };
    });
  }

  /** "새 경매 시작": the seller (account 0) puts up a test NFT, minting one if needed (demo.js). */
  startAuction() {
    return this.run("새 경매 시작", async () => {
      const r = await startAuction(/** @type {Chain} */ (this.chain), await this.signerOf(0));
      return {
        blockNumber: r.blockNumber,
        message:
          `경매 ${r.auctionId}번을 시작했습니다 (토큰 ${r.tokenId}번${r.minted ? " 발행" : ""}, 승인 후 생성). ` +
          `입찰 마감 ${formatTime(Number(r.biddingEnd))}, 공개 마감 ${formatTime(Number(r.revealEnd))}`,
      };
    });
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
    replace(this.accountBox, el("label", {}, "계정 ", select), localOnlyTag(), this.infoBox, ...this.rpcWarningNodes());
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
        return { blockNumber: r.blockNumber, message: `출금했습니다 (계정 ${this.accountIndex}번): ${formatEth(r.amount.toString())}` };
      }),
    );
    replace(
      this.infoBox,
      el("span", { class: "mono", title: address }, shortAddress(address)),
      ` 잔액 ${formatEthShort(balance)} · 장부 `,
      el("strong", {}, formatEth(pending.toString())),
      " ",
      withdraw,
      this.exportBox(),
    );
  }

  /** "저장된 입찰 N건 [내보내기]": a backup of the browser's secrets (design.md 17번). */
  exportBox() {
    if (!this.store) return el("span", { class: "warn" }, " · 브라우저 저장소를 쓸 수 없음");
    const count = this.store.list().length;
    const button = el("button", { type: "button", class: "small" }, "내보내기 (JSON)");
    if (count === 0) button.setAttribute("disabled", "");
    button.addEventListener("click", () => {
      const store = /** @type {import("./secrets.js").SecretStore} */ (this.store);
      const url = URL.createObjectURL(new Blob([store.exportJson()], { type: "application/json" }));
      const a = el("a", { href: url, download: `blind-auction-bids-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.show("ok", `저장된 입찰 ${count}건을 내보냈습니다. 파일에는 secret이 들어 있으니 다른 사람과 공유하지 마세요.`);
    });
    const input = /** @type {HTMLInputElement} */ (el("input", { type: "file", accept: ".json,application/json", multiple: "", hidden: "" }));
    input.addEventListener("change", () => void this.importFiles(input));
    const importButton = el("button", { type: "button", class: "small", title: "스크립트의 .bids/ 파일이나 내보낸 JSON" }, "가져오기");
    importButton.addEventListener("click", () => input.click());
    return el(
      "span",
      { class: "saved-bids", title: "입찰가와 secret은 이 브라우저에만 있습니다. 저장소를 지우기 전에 내보내 두세요." },
      ` · 이 브라우저에 저장된 입찰 ${count}건 `,
      button,
      " ",
      importButton,
      input,
    );
  }

  /**
   * (선택, design.md 17번) Secret files of the scripts (.bids/) or an export of this page.
   * @param {HTMLInputElement} input
   */
  async importFiles(input) {
    if (!this.chain || !this.store) return;
    const files = await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, text: await f.text() })));
    input.value = "";
    try {
      const r = await importBids(this.chain, this.store, files);
      const lines = [`가져오기: ${r.added.length}건 추가`, ...r.added, ...r.skipped.map((x) => `건너뜀 - ${x}`)];
      this.show(r.skipped.length && !r.added.length ? "error" : "ok", lines.join(" / "));
    } catch (err) {
      this.show("error", `가져오기 실패: ${errorMessage(err)}`);
    }
    void this.refreshAccount();
    this.onTransaction(); // the panel shows whether a secret is saved
  }

  /**
   * Runs one transaction with feedback: one at a time, result or error in the notice line.
   * @param {string} label shown while sending
   * @param {() => Promise<{ blockNumber: number, message: string, warnings?: string[] }>} action
   * @returns {Promise<boolean>} true when it succeeded
   */
  async run(label, action) {
    if (this.busy) {
      this.show("error", `${label}: 다른 트랜잭션을 보내는 중입니다. 끝난 뒤 다시 누르세요.`);
      return false;
    }
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
