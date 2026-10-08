import { randomBytes } from "node:crypto";
import pg from "pg";
import { requireEnv } from "../../db/env.js";
import { applySchema } from "../../db/schema.js";

export interface TestDb {
  schema: string;
  /** Pool whose connections all use the throwaway schema (search_path). */
  pool: pg.Pool;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway PostgreSQL schema with the tables from db/schema.sql, so tests never touch
 * the development data in the default schema. Call drop() in afterAll.
 */
export async function createTestDb(): Promise<TestDb> {
  const connectionString = requireEnv("DATABASE_URL");
  const schema = `test_${randomBytes(6).toString("hex")}`;

  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
  const client = await pool.connect();
  try {
    await applySchema(client);
  } finally {
    client.release();
  }

  return {
    schema,
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString });
      await c.connect();
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    },
  };
}
