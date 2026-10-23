import { describe, expect, it } from "vitest";
import {
  FreshnessTracker,
  bidResult,
  formatDuration,
  formatEth,
  formatEthShort,
  nextStep,
  parseAddress,
  parseRoute,
  resultLabel,
  shortAddress,
  statusLabel,
} from "../../web/js/format.js";

// Display logic of the demo web screens (design.md 17번). Pure functions, no browser needed.

describe("web: format helpers", () => {
  it("shows status and result codes with Korean names; unknown codes pass through", () => {
    expect(["bidding", "revealing", "awaiting_finalize", "finalized"].map(statusLabel)).toEqual([
      "입찰 중",
      "공개 중",
      "종료 대기",
      "종료",
    ]);
    expect(["unrevealed", "valid", "invalid", "won", "lost"].map(resultLabel)).toEqual(["미공개", "유효", "무효", "낙찰", "패찰"]);
    expect(statusLabel("something_new")).toBe("something_new");
  });

  it("shows an unrevealed bid of a finalized auction as forfeited", () => {
    expect(bidResult("unrevealed", "finalized")).toEqual({ code: "forfeited", label: "미공개 · 몰수" });
    expect(bidResult("unrevealed", "revealing")).toEqual({ code: "unrevealed", label: "미공개" });
    expect(bidResult("won", "finalized")).toEqual({ code: "won", label: "낙찰" });
  });

  it("formats wei exactly, beyond what a JavaScript number can hold", () => {
    expect(formatEth("0")).toBe("0 ETH");
    expect(formatEth("5000000000000000000")).toBe("5 ETH");
    expect(formatEth("500000000000000000")).toBe("0.5 ETH");
    expect(formatEth("1")).toBe("0.000000000000000001 ETH");
    const uint256Max = (2n ** 256n - 1n).toString();
    expect(formatEth(uint256Max)).toBe(
      "115792089237316195423570985008687907853269984665640564039457.584007913129639935 ETH",
    );
  });

  it("cuts long balances to a few decimals without rounding up", () => {
    expect(formatEthShort(9999999346200000000000n)).toBe("9999.9993 ETH");
    expect(formatEthShort("5000000000000000000")).toBe("5 ETH");
    expect(formatEthShort("1")).toBe("0 ETH");
  });

  it("shortens addresses and hashes for tables", () => {
    expect(shortAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8")).toBe("0x7099…79c8");
    expect(shortAddress("0x1234")).toBe("0x1234");
  });

  it("formats remaining time with the two largest units", () => {
    expect(formatDuration(0)).toBe("0초");
    expect(formatDuration(-5)).toBe("0초");
    expect(formatDuration(45)).toBe("45초");
    expect(formatDuration(570)).toBe("9분 30초");
    expect(formatDuration(86400 + 2 * 3600 + 59)).toBe("1일 2시간");
  });

  it("tells the next step from the block time (not the browser clock)", () => {
    const a = { biddingEnd: 1000, revealEnd: 2000 };
    expect(nextStep({ ...a, status: "bidding" }, 400)).toEqual({ label: "입찰 마감까지", at: 1000, remaining: "10분" });
    expect(nextStep({ ...a, status: "revealing" }, 1940)).toEqual({ label: "공개 마감까지", at: 2000, remaining: "1분" });
    expect(nextStep({ ...a, status: "awaiting_finalize" }, 2500).label).toBe("누군가 종료를 호출하면 정산");
    expect(nextStep({ ...a, status: "finalized" }, 2500).label).toBe("정산 완료");
  });

  it("flags the Indexer as stopped when asOf has not moved for 15 seconds", () => {
    const t = new FreshnessTracker();
    expect(t.isStale(0)).toBe(false); // nothing seen yet
    expect(t.update(10, 0)).toBe(true); // first block → redraw
    expect(t.update(10, 5_000)).toBe(false); // same block → no redraw
    expect(t.isStale(15_000)).toBe(false);
    expect(t.isStale(15_001)).toBe(true);
    expect(t.update(11, 16_000)).toBe(true); // a new block → live again
    expect(t.isStale(20_000)).toBe(false);
  });

  it("accepts a wallet address in any case and rejects anything else", () => {
    expect(parseAddress(" 0xABCDEFabcdef0123456789ABCDEFabcdef012345 ")).toBe("0xabcdefabcdef0123456789abcdefabcdef012345");
    for (const bad of ["", "0x1234", "alice", "0x" + "g".repeat(40), "<script>alert(1)</script>"]) {
      expect(parseAddress(bad)).toBeNull();
    }
  });

  it("parses the hash routes and falls back to the list", () => {
    expect(parseRoute("")).toEqual({ name: "list", status: "" });
    expect(parseRoute("#/")).toEqual({ name: "list", status: "" });
    expect(parseRoute("#/?status=active")).toEqual({ name: "list", status: "active" });
    expect(parseRoute("#/?status=finalized")).toEqual({ name: "list", status: "finalized" });
    expect(parseRoute("#/auctions/12")).toEqual({ name: "auction", id: "12" });
    expect(parseRoute("#/users/0xABCDEFabcdef0123456789ABCDEFabcdef012345")).toEqual({
      name: "user",
      address: "0xabcdefabcdef0123456789abcdefabcdef012345",
    });
    for (const odd of ["#/auctions/abc", "#/users/0x12", "#/?status=ended", "#/nope"]) {
      expect(parseRoute(odd)).toEqual({ name: "list", status: "" });
    }
  });
});
