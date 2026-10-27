import pg from "pg";

// Only one Indexer per database (design.md 9번 "Indexer가 두 개 켜짐").
//
// Two Indexers on one database share one bookmark (indexer_state). With the same CONTRACT_ADDRESS that
// only wastes work: every step writes its whole range and the new bookmark in one transaction and every
// write is idempotent, so blocks may be read twice but nothing is lost. With different CONTRACT_ADDRESS
// values (e.g. an Indexer left running in an old terminal after a new deploy) events ARE lost: the one
// watching the other address finds nothing in a new block, still moves the shared bookmark past it, and
// the right one never reads that block. Either way only one Indexer should run.
//
// A PostgreSQL advisory lock is taken on a connection of its own and held until the process ends.
// PostgreSQL releases it by itself when that connection closes (process killed, Ctrl+C, crash), so
// there is no stale lock file to clean up. indexer:reset takes the same lock, so it cannot empty the
// tables under a running Indexer, and an Indexer cannot start in the middle of a reset.

/** Two-int advisory lock key: (class, object). Any constant works; it only has to be the same everywhere. */
export const LOCK_CLASS = 20261007; // design.md v2 date
export const LOCK_OBJECT = 9; // design.md 9번

/** Shown by pg_stat_activity, so the holder of the lock can be recognised. */
const APPLICATION_NAME = "blind-auction-indexer";

/** The lock is held by another session. Retrying will not help; a person has to stop the other one. */
export class IndexerAlreadyRunning extends Error {}

/** The lock was lost (its connection dropped) and another session holds it now. The Indexer must stop. */
export class IndexerLockTaken extends Error {}

/** PostgreSQL backend pid of the session that holds the lock, or null when nobody does. */
export async function lockHolder(client: pg.ClientBase | pg.Pool): Promise<number | null> {
  const { rows } = await client.query<{ pid: number }>(
    `SELECT pid FROM pg_locks
     WHERE locktype = 'advisory' AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = $1 AND objid = $2 AND objsubid = 2`,
    [LOCK_CLASS, LOCK_OBJECT],
  );
  return rows[0]?.pid ?? null;
}

/** Tries to take the lock for this session. False when another session holds it. */
export async function tryLock(client: pg.ClientBase): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [LOCK_CLASS, LOCK_OBJECT]);
  return rows[0]!.locked;
}

/** The Korean message for a person, as with the startup checks (design.md 9번). */
export function alreadyRunningMessage(holderPid: number | null): string {
  return (
    "Indexer가 이미 실행 중입니다. 같은 DB에 Indexer가 둘이면 책갈피 하나를 같이 쓰고, 서로 다른 CONTRACT_ADDRESS로 켜져 있으면 이벤트가 빠집니다.\n" +
    "할 일: 다른 터미널의 Indexer를 끄고 다시 실행하세요 (indexer:reset이 실행 중일 때도 이렇게 나옵니다)\n" +
    `잠금을 가진 PostgreSQL 연결(pid): ${holderPid ?? "알 수 없음"}`
  );
}

/**
 * The Indexer's lock, on a connection of its own (not from the pool), held until release().
 *
 * If that connection drops (DB restart, network), PostgreSQL releases the lock. Then:
 *   - `held` becomes false and ensureHeld() stops every sync step until the lock is back;
 *   - ensureHeld() reconnects and takes the lock again → indexing continues where the bookmark is;
 *   - if another session took it in the meantime → IndexerLockTaken: this Indexer stops (exit 1),
 *     because two Indexers must never write at the same time;
 *   - while the DB is unreachable, ensureHeld() throws the connection error and the caller retries.
 * assertOwner() also checks inside every sync transaction, before COMMIT, that this lock still exists.
 */
export class IndexerLock {
  private client: pg.Client | null = null;
  /** PostgreSQL backend pid of the lock connection. */
  pid = 0;
  held = false;

  private constructor(
    private readonly connectionString: string,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Takes the lock or throws IndexerAlreadyRunning. Connection errors are thrown as they are, so the
   * caller can retry (the DB may not be up yet).
   */
  static async acquire(connectionString: string, log: (message: string) => void = console.log): Promise<IndexerLock> {
    const lock = new IndexerLock(connectionString, log);
    await lock.take(IndexerAlreadyRunning);
    return lock;
  }

  private async take(ErrorType: typeof IndexerAlreadyRunning | typeof IndexerLockTaken): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString, application_name: APPLICATION_NAME });
    // A dropped connection must not crash the process; it only means the lock is gone.
    const lost = (reason: string) => {
      if (this.client !== client) return;
      if (this.held) this.log(`indexer: lost the Indexer lock (${reason}); syncing pauses until it is taken again`);
      this.held = false;
      this.client = null;
    };
    client.on("error", (err) => lost(err.message));
    client.on("end", () => lost("connection closed"));
    await client.connect();
    try {
      if (!(await tryLock(client))) {
        const holder = await lockHolder(client);
        throw new ErrorType(
          ErrorType === IndexerLockTaken
            ? "Indexer의 DB 연결이 끊긴 사이에 다른 Indexer(또는 indexer:reset)가 잠금을 가져갔습니다. 이 Indexer는 멈춥니다.\n" +
                "할 일: 실행 중인 Indexer가 하나뿐인지 확인하세요. 하나만 남기면 그 Indexer가 이어서 읽습니다\n" +
                `잠금을 가진 PostgreSQL 연결(pid): ${holder ?? "알 수 없음"}`
            : alreadyRunningMessage(holder),
        );
      }
      const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      this.client = client;
      this.pid = rows[0]!.pid;
      this.held = true;
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
  }

  /** Before every sync step: returns when the lock is held, taking it again after a dropped connection. */
  async ensureHeld(): Promise<void> {
    if (this.held) return;
    // An old connection that is still open would hold the lock against our own new one: close it first.
    const old = this.client;
    this.client = null;
    await old?.end().catch(() => {});
    await this.take(IndexerLockTaken);
    this.log(`indexer: took the Indexer lock again (PostgreSQL pid ${this.pid})`);
  }

  /**
   * Inside a sync transaction, before COMMIT: the lock must still be this Indexer's. Otherwise the step
   * is rolled back (nothing written, bookmark unchanged) and the next ensureHeld() decides what to do.
   */
  async assertOwner(client: pg.ClientBase): Promise<void> {
    const holder = await lockHolder(client);
    if (!this.held || holder !== this.pid) {
      this.held = false;
      throw new Error(`the Indexer lock is not held by this Indexer any more (holder pid ${holder ?? "none"})`);
    }
  }

  /** Closing the connection releases the lock. */
  async release(): Promise<void> {
    const client = this.client;
    this.held = false;
    this.client = null;
    await client?.end().catch(() => {});
  }
}
