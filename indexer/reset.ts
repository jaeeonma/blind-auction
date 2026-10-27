// npm run indexer:reset — rebuild the DB copy from the chain (design.md 9번 "DB가 블록체인과 다르다고 의심됨").
//
// Empties auctions, bids and the bookmark in one transaction. The next Indexer run reads every event
// again from DEPLOY_BLOCK and builds the copy from scratch, so wrong rows are fixed too.
// (Rewinding only the bookmark would not be enough: rows that already exist are skipped by the UNIQUE
// keys and the guarded UPDATEs, so a wrong value would stay.)
//
// The Indexer must be stopped first: a step that is still running could write its bookmark back after
// the reset. So the reset takes the Indexer lock (lock.ts) and refuses while an Indexer holds it.
import pg from "pg";
import { requireEnv } from "../db/env.js";
import { lockHolder, tryLock } from "./lock.js";

const client = new pg.Client({ connectionString: requireEnv("DATABASE_URL") });
await client.connect();
try {
  if (!(await tryLock(client))) {
    const holder = await lockHolder(client);
    console.error(
      "indexer:reset: Indexer가 실행 중이라 DB를 비우지 않았습니다. 실행 중인 Indexer가 비운 뒤에 책갈피를 다시 쓸 수 있습니다.\n" +
        '할 일: 모든 터미널의 Indexer를 끈 뒤 "npm run indexer:reset" → "npm run indexer"\n' +
        `잠금을 가진 PostgreSQL 연결(pid): ${holder ?? "알 수 없음"}`,
    );
    process.exitCode = 1;
  } else {
    // Held until client.end() below, so no Indexer can start in the middle of the reset.
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
  }
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await client.end(); // also releases the lock
}
