import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deployContracts } from "../../scripts/lib/deploy";
import { deploymentPath, loadDeployment, saveDeployment } from "../../scripts/lib/deployments";

describe("scripts: deploy (design.md 12번)", function () {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "deployments-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deploys both contracts and records the deploy block of BlindAuction", async function () {
    const [deployer] = await ethers.getSigners();
    const d = await deployContracts(hre, deployer!);

    expect(d.chainId).to.equal(31337);
    expect(await ethers.provider.getCode(d.blindAuction)).to.not.equal("0x");
    expect(await ethers.provider.getCode(d.mockNft)).to.not.equal("0x");
    // The BlindAuction deployment is the latest block, so the Indexer can start exactly there.
    expect(d.deployBlock).to.equal(await ethers.provider.getBlockNumber());
    expect(await ethers.provider.getCode(d.blindAuction, d.deployBlock - 1)).to.equal("0x");

    const auction = await ethers.getContractAt("BlindAuction", d.blindAuction);
    expect(await auction.nextAuctionId()).to.equal(0n);
  });

  it("saves the deployment and loads it back", async function () {
    const [deployer] = await ethers.getSigners();
    const d = await deployContracts(hre, deployer!);

    const file = saveDeployment(d, dir);
    expect(file).to.equal(deploymentPath(d.network, dir));
    expect(loadDeployment(d.network, dir)).to.deep.equal(d);
  });

  it("uses DEPLOYMENTS_DIR when it is set (integration tests must not overwrite the developer's file)", async function () {
    const [deployer] = await ethers.getSigners();
    const d = await deployContracts(hre, deployer!);
    process.env.DEPLOYMENTS_DIR = dir;
    try {
      expect(saveDeployment(d)).to.equal(path.join(dir, `${d.network}.json`));
      expect(loadDeployment(d.network)).to.deep.equal(d);
    } finally {
      delete process.env.DEPLOYMENTS_DIR;
    }
  });

  it("tells the user to deploy first when there is no deployment", function () {
    expect(() => loadDeployment("localhost", dir)).to.throw(/npm run deploy/);
  });
});
