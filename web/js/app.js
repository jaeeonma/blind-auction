// App shell: routing by location.hash, refresh every 3 s, header status (design.md 17번 A).
import { ApiError, getAuction, listAuctions, listUserAuctions } from "./api.js";
import { el, replace } from "./dom.js";
import { FreshnessTracker, formatTime, parseAddress, parseRoute } from "./format.js";
import { Participation } from "./participate.js";
import { auctionDetail, auctionList, userAuctions } from "./views.js";

const REFRESH_MS = 3000;

const main = /** @type {HTMLElement} */ (document.getElementById("main"));
const asOfBox = /** @type {HTMLElement} */ (document.getElementById("asof"));
const searchForm = /** @type {HTMLFormElement} */ (document.getElementById("search"));
const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("search-input"));

const freshness = new FreshnessTracker();
const participation = new Participation({
  accountBox: /** @type {HTMLElement} */ (document.getElementById("account")),
  notice: /** @type {HTMLElement} */ (document.getElementById("notice")),
  panel: /** @type {HTMLElement} */ (document.getElementById("panel")),
  // After a transaction (or an account switch) redraw at once instead of waiting for the next block.
  onTransaction: () => {
    shownKey = "";
    void refresh();
  },
});
/** Route + block of what is on screen now; redraw only when one of them changes. */
let shownKey = "";

/** @param {ReturnType<typeof parseRoute>} route */
async function load(route) {
  switch (route.name) {
    case "auction": {
      const data = await getAuction(route.id);
      return { asOf: data.asOf, nodes: auctionDetail(data) };
    }
    case "user": {
      const data = await listUserAuctions(route.address);
      return { asOf: data.asOf, nodes: userAuctions(data) };
    }
    default: {
      const data = await listAuctions(route.status);
      return { asOf: data.asOf, nodes: auctionList(data, route.status) };
    }
  }
}

/**
 * @param {"ok" | "stale" | "error"} state
 * @param {string} text
 */
function showStatus(state, text) {
  const label = { ok: "정상", stale: "Indexer가 멈춘 것 같음", error: "연결 안 됨" }[state];
  replace(asOfBox, el("span", { class: `dot ${state}` }), el("span", {}, `${label} · ${text}`));
}

async function refresh() {
  const route = parseRoute(location.hash);
  const routeKey = JSON.stringify(route);
  try {
    const { asOf, nodes } = await load(route);
    const now = Date.now();
    const newBlock = freshness.update(asOf.blockNumber, now);
    const key = `${routeKey}@${asOf.blockNumber}`;
    if (key !== shownKey) {
      replace(main, ...nodes);
      shownKey = key;
    }
    if (newBlock) void participation.refreshAccount();
    void participation.updatePanel(route);
    const waiting = participation.indexedUpTo(asOf.blockNumber);
    showStatus(
      freshness.isStale(now) ? "stale" : "ok",
      `블록 #${asOf.blockNumber} · ${formatTime(asOf.blockTime)}${waiting ? ` · ${waiting}` : ""}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ApiError ? err.status : 0;
    if (status === 503) {
      showStatus("error", "Indexer가 아직 블록을 처리하지 않았습니다");
    } else {
      showStatus("error", status === 0 ? "API에 연결할 수 없습니다" : `오류 ${status}`);
    }
    // Keep the last good screen during a short outage; show the error only for a new route.
    if (!shownKey.startsWith(routeKey)) {
      replace(main, el("h1", {}, "불러오지 못했습니다"), el("p", { class: "error" }, message));
      shownKey = `${routeKey}@error`;
    }
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const address = parseAddress(searchInput.value);
  if (!address) {
    searchInput.setCustomValidity("0x로 시작하는 40자리 주소를 입력하세요");
    searchInput.reportValidity();
    return;
  }
  searchInput.setCustomValidity("");
  location.hash = `#/users/${address}`;
});
searchInput.addEventListener("input", () => searchInput.setCustomValidity(""));

window.addEventListener("hashchange", () => {
  shownKey = "";
  void refresh();
});

void participation.init();
void refresh();
setInterval(() => void refresh(), REFRESH_MS);
