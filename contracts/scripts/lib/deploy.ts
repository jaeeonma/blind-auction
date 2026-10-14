import type { Signer } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Deployment } from "./deployments";

/** MockNFT와 BlindAuction을 배포한다 (design.md 12번 "배포"). */
export async function deployContracts(hre: HardhatRuntimeEnvironment, deployer: Signer): Promise<Deployment> {
  const nft = await hre.ethers.deployContract("MockNFT", [], deployer);
  await nft.waitForDeployment();

  const auction = await hre.ethers.deployContract("BlindAuction", [], deployer);
  const receipt = await auction.deploymentTransaction()!.wait();

  return {
    network: hre.network.name,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    blindAuction: await auction.getAddress(),
    mockNft: await nft.getAddress(),
    // Indexer는 이 블록부터 읽는다 (DEPLOY_BLOCK). 그 전 블록에는 이 컨트랙트의 이벤트가 있을 수 없다.
    deployBlock: receipt!.blockNumber,
    deployedAt: new Date().toISOString(),
  };
}
