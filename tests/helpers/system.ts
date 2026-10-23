import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { requireEnv } from "../../db/env.js";
import { applySchema } from "../../db/schema.js";

// Helpers for system tests: every component runs as its own process, as in production (design.md 3번).

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const contractsDir = path.join(rootDir, "contracts");
const hardhatCli = path.join(contractsDir, "node_modules/hardhat/internal/cli/bootstrap.js");

// ── temporary database ────────────────────────────────────────────

export interface TempDatabase {
  name: string;
  /** DATABASE_URL for the Indexer and API processes. */
  url: string;
  /** For the test's own queries. */
  pool: pg.Pool;
  drop(): Promise<void>;
}

/**
 * A whole new PostgreSQL database with the tables from db/schema.sql. A separate database (not just
 * a schema) because child processes only get a DATABASE_URL. The developer's database is untouched.
 */
export async function createTempDatabase(): Promise<TempDatabase> {
  const adminUrl = requireEnv("DATABASE_URL");
  const name = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await applySchema(client);
  } finally {
    client.release();
  }

  return {
    name,
    url,
    pool,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      // FORCE closes connections a killed process may have left behind.
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

// ── child processes ───────────────────────────────────────────────

export interface Service {
  name: string;
  /** Everything the process printed so far. */
  output(): string;
  /** Hard kill (TerminateProcess on Windows, SIGKILL elsewhere): a crash, not a clean shutdown. */
  kill(): Promise<void>;
}

/**
 * Starts `npm run indexer` / `npm run api` as a real process and waits for its startup line.
 * `node --import tsx <file>` instead of the tsx command: the tsx command starts a second node process,
 * which a kill of the first one could leave running.
 */
export async function startService(
  name: "indexer" | "api",
  env: Record<string, string>,
  readyText: string,
): Promise<Service> {
  const child = spawn(process.execPath, ["--import", "tsx", `${name}/main.ts`], {
    cwd: rootDir,
    env: { ...process.env, ...env },
  });
  let output = "";
  const append = (chunk: Buffer) => (output += chunk.toString());
  child.stdout!.on("data", append);
  child.stderr!.on("data", append);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  await waitFor(`${name} to start`, async () => output.includes(readyText), 30_000, () => output);
  return {
    name,
    output: () => output,
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

/**
 * Runs `indexer/main.ts` or `api/main.ts` and waits for the process to exit by itself (e.g. a failed
 * startup check). Returns the exit code, or null if it was still running after `timeoutMs` (then it is killed).
 */
export async function runServiceUntilExit(
  name: "indexer" | "api",
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", `${name}/main.ts`], {
    cwd: rootDir,
    env: { ...process.env, ...env },
  });
  let output = "";
  child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await exited;
  clearTimeout(timer);
  return { code: child.killed ? null : code, output };
}

/** Runs a one-shot backend command (e.g. `npm run indexer:reset`) as a process and returns its output. */
export async function runBackendScript(file: string, env: Record<string, string>): Promise<string> {
  const child = spawn(process.execPath, ["--import", "tsx", file], { cwd: rootDir, env: { ...process.env, ...env } });
  let output = "";
  child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  if (code !== 0) throw new Error(`${file} failed (${code}):\n${output}`);
  return output;
}

export interface ScriptEnv {
  rpcUrl: string;
  deploymentsDir: string;
  bidsDir: string;
}

/** Runs a user script (Hardhat task, design.md 12번) against the test node and returns its output. */
export async function runScript(task: string, args: string[], env: ScriptEnv): Promise<string> {
  const child: ChildProcess = spawn(process.execPath, [hardhatCli, "--network", "localhost", task, ...args], {
    cwd: contractsDir,
    env: { ...process.env, RPC_URL: env.rpcUrl, DEPLOYMENTS_DIR: env.deploymentsDir, BIDS_DIR: env.bidsDir },
  });
  let output = "";
  child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  if (code !== 0) throw new Error(`npm run ${task} ${args.join(" ")} failed (${code}):\n${output}`);
  return output;
}

/** Fresh folders for the deployment record and secret files of one test. */
export function scriptDirs(rpcUrl: string): ScriptEnv & { cleanup(): void } {
  const base = mkdtempSync(path.join(tmpdir(), "system-"));
  return {
    rpcUrl,
    deploymentsDir: path.join(base, "deployments"),
    bidsDir: path.join(base, "bids"),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

// ── small utilities ───────────────────────────────────────────────

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function waitFor(
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 30_000,
  details?: () => string,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await condition()) return;
    } catch {
      // not ready yet (e.g. connection refused)
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${details ? `\n${details()}` : ""}`);
    await sleep(intervalMs);
  }
}

/** Last block the Indexer saved, from its bookmark in the DB (-1 if none). */
export async function indexedBlock(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ last_block: string }>("SELECT last_block FROM indexer_state WHERE id = 1");
  return rows[0] ? Number(rows[0].last_block) : -1;
}
