// npm run indexer:reset — rebuild the DB copy from the chain (design.md 9번 "DB가 블록체인과 다르다고 의심됨").
//
// Empties auctions, bids and the bookmark in one transaction. The next Indexer run reads every event
// again from DEPLOY_BLOCK and builds the copy from scratch, so wrong rows are fixed too.
// (Rewinding only the bookmark would not be enough: rows that already exist are skipped by the UNIQUE
// keys and the guarded UPDATEs, so a wrong value would stay.)
//
// Stop the Indexer first: a step that is still running could write its bookmark back after the reset.
import pg from "pg";
import { requireEnv } from "../db/env.js";

const client = new pg.Client({ connectionString: requireEnv("DATABASE_URL") });
await client.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query<{ last_block: string }>("SELECT last_block FROM indexer_state WHERE id = 1");
  const counts = await client.query<{ auctions: number; bids: number }>(
    "SELECT (SELECT count(*) FROM auctions)::int AS auctions, (SELECT count(*) FROM bids)::int AS bids",
  );
  await client.query("TRUNCATE bids, auctions, indexer_state");
  await client.query("COMMIT");

  const c = counts.rows[0]!;
  console.log(
    `indexer:reset: removed ${c.auctions} auction(s), ${c.bids} bid(s) and the bookmark` +
      (rows[0] ? ` (was block ${rows[0].last_block})` : " (there was none)"),
  );
  console.log("Start the Indexer again (npm run indexer): it reads everything again from DEPLOY_BLOCK.");
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await client.end();
}
