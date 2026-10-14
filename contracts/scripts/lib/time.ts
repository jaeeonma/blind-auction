// 시연용 블록 시간 앞당기기 (design.md 12번). Uses Hardhat-only RPC methods (evm_*), so it works on
// the local Hardhat node only. The contract reads block.timestamp, so moving block time is how a
// demo gets from bidding to reveal to finalize without waiting 10 minutes and a day.

export interface DevProvider {
  send(method: string, params: unknown[]): Promise<unknown>;
  getBlock(tag: "latest"): Promise<{ timestamp: number } | null>;
}

export async function latestBlockTime(provider: DevProvider): Promise<bigint> {
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("Could not read the latest block");
  return BigInt(block.timestamp);
}

/**
 * Moves block time forward by at least `seconds` and mines a block. Returns the new block time.
 * Hardhat adds the offset to the wall clock, so real seconds that passed since the last block are
 * included. Use moveTimeTo to land on an exact time.
 */
export async function increaseTime(provider: DevProvider, seconds: bigint): Promise<bigint> {
  if (seconds <= 0n) throw new Error("Seconds must be positive");
  await provider.send("evm_increaseTime", [Number(seconds)]);
  await provider.send("evm_mine", []);
  return latestBlockTime(provider);
}

/**
 * Mines a block exactly at `target` (unix seconds), so the next phase starts right away.
 * Time never goes backwards: if the chain is already at or past `target`, nothing happens.
 */
export async function moveTimeTo(provider: DevProvider, target: bigint): Promise<{ moved: boolean; time: bigint }> {
  const now = await latestBlockTime(provider);
  if (now >= target) return { moved: false, time: now };
  await provider.send("evm_setNextBlockTimestamp", [Number(target)]);
  await provider.send("evm_mine", []);
  return { moved: true, time: await latestBlockTime(provider) };
}
