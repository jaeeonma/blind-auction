import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 배포 기록. 나머지 스크립트가 컨트랙트 주소를 매번 입력받지 않도록 여기서 읽는다.
 * 로컬 노드를 다시 켜면 주소가 바뀌는 값이라 Git에는 올리지 않는다 (.gitignore).
 */
export interface Deployment {
  network: string;
  chainId: number;
  blindAuction: string;
  mockNft: string;
  deployBlock: number;
  deployedAt: string;
}

/** contracts/deployments/. Integration tests use DEPLOYMENTS_DIR so they never overwrite the developer's file. */
export function deploymentsDir(): string {
  return process.env.DEPLOYMENTS_DIR ? path.resolve(process.env.DEPLOYMENTS_DIR) : path.resolve(__dirname, "../../deployments");
}

export function deploymentPath(network: string, dir = deploymentsDir()): string {
  return path.join(dir, `${network}.json`);
}

export function saveDeployment(deployment: Deployment, dir = deploymentsDir()): string {
  mkdirSync(dir, { recursive: true });
  const file = deploymentPath(deployment.network, dir);
  writeFileSync(file, JSON.stringify(deployment, null, 2) + "\n");
  return file;
}

export function loadDeployment(network: string, dir = deploymentsDir()): Deployment {
  const file = deploymentPath(network, dir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No deployment found at ${file}. Run "npm run deploy" first.`);
  }
  return JSON.parse(raw) as Deployment;
}
