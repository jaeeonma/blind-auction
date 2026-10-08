// npm run db:init — creates the tables in DATABASE_URL (design.md 10번).
import pg from "pg";
import { applySchema } from "./schema.js";
import { requireEnv } from "./env.js";

const client = new pg.Client({ connectionString: requireEnv("DATABASE_URL") });
await client.connect();
try {
  await applySchema(client);
  console.log("db:init: tables are ready (auctions, bids, indexer_state)");
} finally {
  await client.end();
}
