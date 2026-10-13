import { parseEther } from "ethers";

const UNIT_SECONDS: Record<string, bigint> = { s: 1n, m: 60n, h: 3600n, d: 86400n };

/** "90" | "90s" | "10m" | "2h" | "1d" → seconds. Durations are given this way on the command line. */
export function parseDuration(input: string): bigint {
  const m = /^(\d+)([smhd]?)$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration "${input}": use a number with s, m, h or d (e.g. 10m, 1d)`);
  return BigInt(m[1]!) * UNIT_SECONDS[m[2] || "s"]!;
}

/** "3" | "0.5" ETH → wei. Amounts are typed in ETH, the contract works in wei (design.md 10번). */
export function parseEthAmount(input: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(input.trim())) throw new Error(`Invalid ETH amount "${input}" (e.g. 3 or 0.5)`);
  return parseEther(input.trim());
}

/** Token id / auction id from the command line. */
export function parseUint(name: string, input: string): bigint {
  if (!/^\d+$/.test(input.trim())) throw new Error(`--${name} must be a non-negative integer, got "${input}"`);
  return BigInt(input.trim());
}

/** Unix seconds → "2026-10-13T01:56:30.000Z (1791856590)" for script output. */
export function formatTime(unixSeconds: bigint | number): string {
  return `${new Date(Number(unixSeconds) * 1000).toISOString()} (${unixSeconds})`;
}
