// npm run api — runs the API as its own process, separate from the Indexer (design.md 3번).
// The API keeps answering from the DB even while the Indexer is stopped; asOf shows how fresh it is.
import pg from "pg";
import { requireEnv } from "../db/env.js";
import { createApp } from "./app.js";

const port = Number(process.env.API_PORT || 3000);
const pool = new pg.Pool({ connectionString: requireEnv("DATABASE_URL") });
// An idle connection dropping (e.g. PostgreSQL restarted) must not crash the process.
pool.on("error", (err) => console.error(`api: idle DB connection error: ${err.message}`));

const server = createApp(pool).listen(port, () => {
  console.log(`api: listening on http://localhost:${port}`);
});

const shutdown = () => {
  server.close(async () => {
    await pool.end();
    console.log("api: stopped");
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
