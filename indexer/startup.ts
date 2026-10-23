import { setTimeout as sleep } from "node:timers/promises";
import type { JsonRpcProvider } from "ethers";
import type { Pool } from "pg";

// Startup checks (design.md 9번 "시작할 때 확인").
//
// A wrong configuration does not heal by retrying: with DEPLOY_BLOCK after the real deploy block the
// Indexer skips AuctionCreated and then fails on the bids' foreign key forever, and with DEPLOY_BLOCK or
// the bookmark ahead of the chain (local node restarted) it silently waits. So these cases stop the
// Indexer with the cause and what to do. The messages are in Korean because a person has to act on
// them; the rest of the Indexer log stays in English.
// A node or DB that cannot be reached is a different matter: it may come back, so that is retried.

/** The configuration or the DB does not match the chain. Retrying will not help. */
export class StartupCheckFailed extends Error {}

export interface StartupOptions {
  contractAddress: string;
  deployBlock: number;
}

export interface StartupReport {
  /** Block the contract was really deployed in (found on chain). */
  actualDeployBlock: number;
  head: number;
  /** Fine to continue, but worth telling the user. */
  warnings: string[];
}

const REDEPLOY_STEPS =
  '할 일: Indexer를 멈춘 채로 "cd contracts && npm run deploy" → 출력된 CONTRACT_ADDRESS·DEPLOY_BLOCK으로 .env 갱신 ' +
  '→ "npm run indexer:reset" → "npm run indexer"';

/**
 * Smallest block at which `address` has code, i.e. the block the contract was deployed in.
 * Binary search over "is there code at this block": about log2(head) requests. `head` must have code.
 */
export async function findDeployBlock(provider: JsonRpcProvider, address: string, head: number): Promise<number> {
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await provider.getCode(address, mid)) !== "0x") hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Checks CONTRACT_ADDRESS, DEPLOY_BLOCK and the bookmark against the chain.
 * Throws StartupCheckFailed for a wrong configuration; any other error (node or DB unreachable) is
 * thrown as it is so the caller can retry.
 */
export async function checkStartup(provider: JsonRpcProvider, pool: Pool, options: StartupOptions): Promise<StartupReport> {
  const head = await provider.getBlockNumber();

  // 1. Is there a contract at CONTRACT_ADDRESS? (Not after a local node restart without a new deploy.)
  if ((await provider.getCode(options.contractAddress)) === "0x") {
    throw new StartupCheckFailed(
      "CONTRACT_ADDRESS에 컨트랙트가 없습니다. 노드를 다시 켰거나 주소가 틀렸습니다.\n" +
        `${REDEPLOY_STEPS}\nCONTRACT_ADDRESS: ${options.contractAddress}`,
    );
  }

  // 2. DEPLOY_BLOCK ahead of the chain: .env still holds the value from before the node restarted.
  if (options.deployBlock > head) {
    throw new StartupCheckFailed(
      "DEPLOY_BLOCK이 체인의 최신 블록보다 뒤에 있습니다. 노드를 다시 켜서 .env의 값이 예전 체인 기준일 가능성이 큽니다.\n" +
        `${REDEPLOY_STEPS}\nDEPLOY_BLOCK: ${options.deployBlock}, 최신 블록: ${head}`,
    );
  }

  // 3. DEPLOY_BLOCK after the real deploy block: the events in between (auction creation…) would be missed.
  const actualDeployBlock = await findDeployBlock(provider, options.contractAddress, head);
  if (options.deployBlock > actualDeployBlock) {
    throw new StartupCheckFailed(
      "DEPLOY_BLOCK이 실제 배포 블록보다 뒤에 있어서 그 사이의 이벤트(경매 생성 등)를 놓칩니다.\n" +
        '할 일: .env의 DEPLOY_BLOCK을 실제 배포 블록으로 고치고, 이미 저장된 데이터가 있으면 "npm run indexer:reset" 후 "npm run indexer"\n' +
        `DEPLOY_BLOCK: ${options.deployBlock}, 실제 배포 블록: ${actualDeployBlock}`,
    );
  }

  // 4. Bookmark ahead of the chain: the DB still holds the chain from before the node restarted.
  const { rows } = await pool.query<{ last_block: string }>("SELECT last_block FROM indexer_state WHERE id = 1");
  const bookmark = rows[0] ? Number(rows[0].last_block) : null;
  if (bookmark !== null && bookmark > head) {
    throw new StartupCheckFailed(
      "DB의 책갈피가 체인의 최신 블록보다 뒤에 있습니다. 노드를 다시 켠 뒤 DB가 예전 체인의 데이터를 갖고 있습니다.\n" +
        '할 일: "npm run indexer:reset" → "npm run indexer" (CONTRACT_ADDRESS·DEPLOY_BLOCK이 새 배포와 맞는지도 확인)\n' +
        `책갈피: ${bookmark}, 최신 블록: ${head}`,
    );
  }

  // DEPLOY_BLOCK before the deploy block only means reading some empty blocks: warn and continue.
  const warnings: string[] = [];
  if (options.deployBlock < actualDeployBlock) {
    warnings.push(
      "DEPLOY_BLOCK이 실제 배포 블록보다 앞에 있습니다. 결과에는 영향이 없고 빈 블록을 더 읽습니다. " +
        `DEPLOY_BLOCK: ${options.deployBlock}, 실제 배포 블록: ${actualDeployBlock}`,
    );
  }
  return { actualDeployBlock, head, warnings };
}

/**
 * Runs checkStartup until it either passes or finds a wrong configuration.
 * Connection errors are logged and retried, like the main loop does (design.md 9번).
 * Returns null when `signal` aborts first.
 */
export async function runStartupChecks(
  provider: JsonRpcProvider,
  pool: Pool,
  options: StartupOptions & { retryDelayMs: number; signal: AbortSignal; log?: (message: string) => void },
): Promise<StartupReport | null> {
  const log = options.log ?? console.log;
  while (!options.signal.aborted) {
    try {
      return await checkStartup(provider, pool, options);
    } catch (err) {
      if (err instanceof StartupCheckFailed) throw err;
      log(`indexer: startup check could not reach the node or DB, retrying in ${options.retryDelayMs} ms: ${(err as Error).message}`);
      await sleep(options.retryDelayMs, undefined, { signal: options.signal }).catch(() => {});
    }
  }
  return null;
}
