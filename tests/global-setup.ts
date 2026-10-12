import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    rpcUrl: string;
  }
}

const contractsDir = fileURLToPath(new URL("../contracts/", import.meta.url));
// Run Hardhat's CLI with this Node binary directly (no shell / npx), so the node process can be
// stopped with a plain kill on Windows as well.
const hardhatCli = fileURLToPath(new URL("../contracts/node_modules/hardhat/internal/cli/bootstrap.js", import.meta.url));
// A separate port so the tests never touch a Hardhat node the developer runs on 8545.
const port = Number(process.env.TEST_RPC_PORT ?? 8546);

let node: ChildProcess | undefined;

/**
 * Once per `npm test`: compile the contracts (tests deploy the real BlindAuction) and start a
 * Hardhat node. Each test deploys its own contracts, so tests do not share auction state.
 */
export async function setup(project: TestProject) {
  const compile = spawnSync(process.execPath, [hardhatCli, "compile", "--quiet"], { cwd: contractsDir, stdio: "inherit" });
  if (compile.status !== 0) throw new Error("hardhat compile failed");

  node = spawn(process.execPath, [hardhatCli, "node", "--port", String(port)], { cwd: contractsDir });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Hardhat node did not start:\n${output}`)), 60_000);
    node!.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Started HTTP and WebSocket JSON-RPC server")) {
        clearTimeout(timer);
        resolve();
      }
    });
    node!.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    node!.once("exit", (code) => reject(new Error(`Hardhat node exited (${code}):\n${output}`)));
  });
  // Keep draining stdout so the node never blocks on a full pipe.
  node.stdout!.resume();

  project.provide("rpcUrl", `http://127.0.0.1:${port}`);
}

export async function teardown() {
  node?.kill();
}
