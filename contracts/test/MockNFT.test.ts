import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("MockNFT", function () {
  async function deployFixture() {
    const [owner, alice] = await ethers.getSigners();
    const nft = await ethers.deployContract("MockNFT");
    return { nft, owner, alice };
  }

  it("mints sequential token ids starting at 1", async function () {
    const { nft, alice } = await loadFixture(deployFixture);

    await expect(nft.mint(alice.address))
      .to.emit(nft, "Transfer")
      .withArgs(ethers.ZeroAddress, alice.address, 1n);
    await nft.mint(alice.address);

    expect(await nft.ownerOf(1n)).to.equal(alice.address);
    expect(await nft.ownerOf(2n)).to.equal(alice.address);
    expect(await nft.balanceOf(alice.address)).to.equal(2n);
    expect(await nft.nextTokenId()).to.equal(3n);
  });
});
