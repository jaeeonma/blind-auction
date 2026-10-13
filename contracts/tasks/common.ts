import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { HardhatPluginError } from "hardhat/plugins";
import type { ActionType, HardhatRuntimeEnvironment, TaskArguments } from "hardhat/types";
import type { BlindAuction, MockNFT } from "../typechain-types";
import { loadDeployment, type Deployment } from "../scripts/lib/deployments";

/**
 * Task action wrapper. Hardhat prints a plain Error as "An unexpected error occurred" with a stack
 * trace, which looks like a bug. Expected failures (wrong phase, missing secret file, ...) are
 * re-thrown as HardhatPluginError so the user sees just the message.
 */
export function scriptAction<A extends TaskArguments>(action: ActionType<A>): ActionType<A> {
  return async (args, hre, runSuper) => {
    try {
      return await action(args, hre, runSuper);
    } catch (err) {
      if (err instanceof HardhatPluginError) throw err;
      throw new HardhatPluginError("blind-auction", (err as Error).message, err as Error);
    }
  };
}

/**
 * 스크립트는 로컬 노드(localhost)에서만 실행한다. --network를 빠뜨리면 Hardhat은 실행할 때만
 * 잠깐 생기는 메모리 체인에서 돌아서 결과가 남지 않는다. npm 스크립트가 --network localhost를 붙인다.
 */
export function ensureLocalhost(hre: HardhatRuntimeEnvironment): void {
  if (hre.network.name !== "localhost") {
    throw new Error(`Run scripts against the local node: use "npm run <script>" (got network "${hre.network.name}")`);
  }
}

/** --account N → 로컬 노드 기본 계정 N번 (노드가 열어 두므로 개인키가 필요 없다). */
export async function accountAt(hre: HardhatRuntimeEnvironment, index: number): Promise<HardhatEthersSigner> {
  const signers = await hre.ethers.getSigners();
  const signer = signers[index];
  if (!Number.isInteger(index) || !signer) throw new Error(`--account must be 0-${signers.length - 1}, got ${index}`);
  return signer;
}

export interface Contracts {
  deployment: Deployment;
  auction: BlindAuction;
  nft: MockNFT;
}

/** 배포 기록에서 주소를 읽어 signer로 연결한 컨트랙트를 돌려준다. */
export async function loadContracts(hre: HardhatRuntimeEnvironment, signer: HardhatEthersSigner): Promise<Contracts> {
  const deployment = loadDeployment(hre.network.name);
  const [auction, nft] = await Promise.all([
    hre.ethers.getContractAt("BlindAuction", deployment.blindAuction, signer),
    hre.ethers.getContractAt("MockNFT", deployment.mockNft, signer),
  ]);
  return { deployment, auction, nft };
}
