import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deployContracts } from "../../scripts/lib/deploy";
import { saveDeployment } from "../../scripts/lib/deployments";
import { loadContracts } from "../../tasks/common";

describe("scripts: loadContracts checks the deployment record (design.md 12번)", function () {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "deployments-"));
    process.env.DEPLOYMENTS_DIR = dir; // loadContracts reads <DEPLOYMENTS_DIR>/<network>.json
  });
  afterEach(() => {
    delete process.env.DEPLOYMENTS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  /** An address with no code: what a deployment record points at after the local node restarted. */
  const emptyAddress = () => ethers.Wallet.createRandom().address;

  it("returns the contracts when both addresses hold code", async function () {
    const [signer] = await ethers.getSigners();
    const d = await deployContracts(hre, signer!);
    saveDeployment(d);

    const { auction, nft } = await loadContracts(hre, signer!);
    expect(await auction.getAddress()).to.equal(d.blindAuction);
    expect(await nft.getAddress()).to.equal(d.mockNft);
  });

  it("tells the user to deploy first when the BlindAuction address has no code (node restarted)", async function () {
    const [signer] = await ethers.getSigners();
    const d = await deployContracts(hre, signer!);
    const blindAuction = emptyAddress();
    saveDeployment({ ...d, blindAuction });

    await expect(loadContracts(hre, signer!)).to.be.rejectedWith(
      `배포 기록의 BlindAuction 주소에 컨트랙트가 없습니다. 노드를 다시 켰다면 "npm run deploy"를 먼저 실행하세요. 주소: ${blindAuction}`,
    );
  });

  it("also checks the MockNFT address", async function () {
    const [signer] = await ethers.getSigners();
    const d = await deployContracts(hre, signer!);
    saveDeployment({ ...d, mockNft: emptyAddress() });

    await expect(loadContracts(hre, signer!)).to.be.rejectedWith(/배포 기록의 MockNFT 주소에 컨트랙트가 없습니다/);
  });
});
