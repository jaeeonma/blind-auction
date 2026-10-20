import { task, types } from "hardhat/config";
import { TASK_COMPILE } from "hardhat/builtin-tasks/task-names";
import { deployContracts } from "../scripts/lib/deploy";
import { saveDeployment } from "../scripts/lib/deployments";
import { accountAt, ensureLocalhost, scriptAction } from "./common";

// npm run deploy [-- --account 0]
task("deploy", "MockNFT와 BlindAuction을 로컬 노드에 배포한다")
  .addOptionalParam("account", "배포할 계정 번호", 0, types.int)
  .setAction(scriptAction(async (args: { account: number }, hre) => {
    ensureLocalhost(hre);
    // A fresh clone has no build output yet. Compile first, like `hardhat run` does
    // (nothing to do when the contracts are already compiled).
    await hre.run(TASK_COMPILE, { quiet: true });
    const deployer = await accountAt(hre, args.account);
    const deployment = await deployContracts(hre, deployer);
    const file = saveDeployment(deployment);

    console.log(`MockNFT       ${deployment.mockNft}`);
    console.log(`BlindAuction  ${deployment.blindAuction} (블록 ${deployment.deployBlock})`);
    console.log(`기록 위치: ${file}`);
    console.log("\n아래 두 줄을 루트 .env에 넣고 Indexer를 켜세요 (이미 켜져 있으면 다시 켜세요):");
    // These two lines are copied into .env as they are, so they stay exactly in this form.
    console.log(`CONTRACT_ADDRESS=${deployment.blindAuction}`);
    console.log(`DEPLOY_BLOCK=${deployment.deployBlock}`);
  }));
