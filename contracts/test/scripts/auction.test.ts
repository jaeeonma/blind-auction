import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { createAuction, mintNft } from "../../scripts/lib/auction";
import { parseDuration, parseEthAmount, parseUint } from "../../scripts/lib/units";

const DAY = 86400n;

describe("scripts: mint-nft, create-auction (design.md 12번)", function () {
  async function deployed() {
    const [seller, alice] = await ethers.getSigners();
    const nft = await ethers.deployContract("MockNFT");
    const auction = await ethers.deployContract("BlindAuction");
    return { nft, auction, seller: seller!, alice: alice! };
  }

  describe("input parsing", function () {
    it("parses durations with s/m/h/d or plain seconds", function () {
      expect(parseDuration("90")).to.equal(90n);
      expect(parseDuration("90s")).to.equal(90n);
      expect(parseDuration("10m")).to.equal(600n);
      expect(parseDuration("36h")).to.equal(36n * 3600n);
      expect(parseDuration("1d")).to.equal(DAY);
      for (const bad of ["", "1w", "-1d", "1.5d", "ten"]) expect(() => parseDuration(bad)).to.throw(/Invalid duration/);
    });

    it("parses ETH amounts to wei", function () {
      expect(parseEthAmount("3")).to.equal(ethers.parseEther("3"));
      expect(parseEthAmount("0.5")).to.equal(ethers.parseEther("0.5"));
      expect(parseEthAmount("0")).to.equal(0n);
      for (const bad of ["", "-1", "1e18", "abc", "0.1234567890123456789"]) {
        expect(() => parseEthAmount(bad)).to.throw(/Invalid ETH amount/);
      }
    });

    it("parses ids", function () {
      expect(parseUint("token", "7")).to.equal(7n);
      expect(() => parseUint("token", "x")).to.throw("--token must be a non-negative integer");
    });
  });

  it("mintNft returns the new token id", async function () {
    const { nft, alice } = await loadFixture(deployed);
    expect(await mintNft(nft, alice.address)).to.equal(1n);
    expect(await mintNft(nft, alice.address)).to.equal(2n);
    expect(await nft.ownerOf(2n)).to.equal(alice.address);
  });

  it("createAuction approves, creates the auction and returns its id and end times", async function () {
    const { nft, auction, seller } = await loadFixture(deployed);
    const tokenId = await mintNft(nft, seller.address);

    const created = await createAuction(auction, nft, seller, tokenId, 600n, DAY);
    const now = BigInt(await time.latest());

    expect(created).to.deep.equal({ auctionId: 0n, biddingEnd: now + 600n, revealEnd: now + 600n + DAY, approved: true });
    expect(await nft.ownerOf(tokenId)).to.equal(await auction.getAddress()); // NFT in escrow
  });

  it("skips approve when the auction contract is already approved for all", async function () {
    const { nft, auction, seller } = await loadFixture(deployed);
    const tokenId = await mintNft(nft, seller.address);
    await nft.setApprovalForAll(await auction.getAddress(), true);

    expect((await createAuction(auction, nft, seller, tokenId, 600n, DAY)).approved).to.equal(false);
  });

  describe("checks before sending (no transaction is sent)", function () {
    async function expectRefused(promise: Promise<unknown>, message: string | RegExp, signer: { address: string }) {
      const nonceBefore = await ethers.provider.getTransactionCount(signer.address);
      await expect(promise).to.be.rejectedWith(message);
      expect(await ethers.provider.getTransactionCount(signer.address)).to.equal(nonceBefore);
    }

    it("refuses when the caller does not own the NFT", async function () {
      const { nft, auction, seller, alice } = await loadFixture(deployed);
      const tokenId = await mintNft(nft, seller.address);
      await expectRefused(
        createAuction(auction.connect(alice), nft.connect(alice), alice, tokenId, 600n, DAY),
        /is owned by/,
        alice,
      );
    });

    it("refuses a token that is already in an auction", async function () {
      const { nft, auction, seller } = await loadFixture(deployed);
      const tokenId = await mintNft(nft, seller.address);
      await createAuction(auction, nft, seller, tokenId, 600n, DAY);
      await expectRefused(createAuction(auction, nft, seller, tokenId, 600n, DAY), /already in an auction/, seller);
    });

    it("refuses a token that does not exist", async function () {
      const { nft, auction, seller } = await loadFixture(deployed);
      await expectRefused(createAuction(auction, nft, seller, 99n, 600n, DAY), "Token 99 does not exist", seller);
    });

    it("refuses durations outside bidding 10m-5d / reveal 1d-2d", async function () {
      const { nft, auction, seller } = await loadFixture(deployed);
      const tokenId = await mintNft(nft, seller.address);
      await expectRefused(createAuction(auction, nft, seller, tokenId, 599n, DAY), /Bidding duration/, seller);
      await expectRefused(createAuction(auction, nft, seller, tokenId, 5n * DAY + 1n, DAY), /Bidding duration/, seller);
      await expectRefused(createAuction(auction, nft, seller, tokenId, 600n, DAY - 1n), /Reveal duration/, seller);
      await expectRefused(createAuction(auction, nft, seller, tokenId, 600n, 2n * DAY + 1n), /Reveal duration/, seller);
    });
  });
});
