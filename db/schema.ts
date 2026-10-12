import { readFile } from "node:fs/promises";
import type { ClientBase } from "pg";

const SCHEMA_PATH = new URL("./schema.sql", import.meta.url);

/**
 * Applies db/schema.sql. Every statement is IF NOT EXISTS, so running it again is a no-op.
 * Tables are created in the client's current search_path (tests point it at a throwaway schema).
 */
export async function applySchema(client: ClientBase): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, "utf8");
  await client.query(sql);
}
