import { task, types } from "hardhat/config";
import { deployContracts } from "../scripts/lib/deploy";
import { saveDeployment } from "../scripts/lib/deployments";
import { accountAt, ensureLocalhost, scriptAction } from "./common";

// npm run deploy [-- --account 0]
task("deploy", "Deploy MockNFT and BlindAuction to the local node")
  .addOptionalParam("account", "Deployer account index", 0, types.int)
  .setAction(scriptAction(async (args: { account: number }, hre) => {
    ensureLocalhost(hre);
    const deployer = await accountAt(hre, args.account);
    const deployment = await deployContracts(hre, deployer);
    const file = saveDeployment(deployment);

    console.log(`MockNFT       ${deployment.mockNft}`);
    console.log(`BlindAuction  ${deployment.blindAuction} (block ${deployment.deployBlock})`);
    console.log(`Saved to ${file}`);
    console.log("\nPut these in the root .env for the Indexer, then restart it:");
    console.log(`CONTRACT_ADDRESS=${deployment.blindAuction}`);
    console.log(`DEPLOY_BLOCK=${deployment.deployBlock}`);
  }));
