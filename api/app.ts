import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Express } from "express";
import type { Pool } from "pg";
import {
  ACTIVE_STATUSES,
  STATUSES,
  getAuction,
  inSnapshot,
  listAuctions,
  listUserAuctions,
  type Status,
} from "./queries.js";

// Read-only API over the DB copy (design.md 11번). Only GET routes exist: writes go from the
// user's wallet straight to the contract (design.md 3번).

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** ?status= → the statuses to include. Absent = all. */
function parseStatusFilter(raw: unknown): readonly Status[] {
  if (raw === undefined) return [];
  if (raw === "active") return ACTIVE_STATUSES;
  if (typeof raw === "string" && (STATUSES as readonly string[]).includes(raw)) return [raw as Status];
  throw new HttpError(400, `status must be one of: active, ${STATUSES.join(", ")}`);
}

/** uint256 auction id as a canonical decimal string ("007" → "7"). */
function parseAuctionId(raw: string): string {
  // 78 digits = the width of NUMERIC(78,0); also keeps BigInt() from parsing huge inputs.
  if (!/^\d{1,78}$/.test(raw)) throw new HttpError(400, "auctionId must be a non-negative integer");
  const id = BigInt(raw);
  if (id >= 2n ** 256n) throw new HttpError(400, "auctionId is out of the uint256 range");
  return id.toString();
}

/** Addresses are stored lowercase, so mixed-case input is lowercased before the lookup (design.md 10번). */
function parseAddress(raw: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new HttpError(400, "address must be 0x followed by 40 hex characters");
  return raw.toLowerCase();
}

/** Indexer has not processed a block yet: without a block time no status can be computed. */
const notIndexedYet = () => new HttpError(503, "indexer has not processed any block yet");

export function createApp(pool: Pool): Express {
  const app = express();
  app.disable("x-powered-by");

  // 전체 / 진행 중(?status=active) / 종료된(?status=finalized) 경매
  app.get("/auctions", async (req, res) => {
    const statuses = parseStatusFilter(req.query.status);
    const r = await inSnapshot(pool, (c) => listAuctions(c, statuses));
    if (!r) throw notIndexedYet();
    res.json({ asOf: r.asOf, auctions: r.data });
  });

  // 경매 상세 정보 / 진행 상태 / 결과
  app.get("/auctions/:auctionId", async (req, res) => {
    const auctionId = parseAuctionId(req.params.auctionId);
    const r = await inSnapshot(pool, (c) => getAuction(c, auctionId));
    if (!r) throw notIndexedYet();
    if (!r.data) throw new HttpError(404, `auction ${auctionId} not found`);
    res.json({ asOf: r.asOf, auction: r.data });
  });

  // 특정 사용자가 참여한 경매. A wallet with no bids gets an empty list, not 404.
  app.get("/users/:address/auctions", async (req, res) => {
    const address = parseAddress(req.params.address);
    const r = await inSnapshot(pool, (c) => listUserAuctions(c, address));
    if (!r) throw notIndexedYet();
    res.json({ asOf: r.asOf, address, auctions: r.data });
  });

  // Demo web screens (design.md 17번): plain files from web/, GET only. Mounted after the API routes,
  // so it never shadows them; anything that is neither a route nor a file still gets the JSON 404.
  app.use(express.static(WEB_DIR, { index: "index.html" }));

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // DB down etc.: log the details, do not leak them to the client.
    console.error("api: request failed:", err);
    res.status(500).json({ error: "internal error" });
  };
  app.use(onError);

  return app;
}
