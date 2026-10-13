import { task, types } from "hardhat/config";
import { createAuction, mintNft } from "../scripts/lib/auction";
import { formatTime, parseDuration, parseUint } from "../scripts/lib/units";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run mint-nft [-- --to 0]
task("mint-nft", "Mint a test NFT (demo only)")
  .addOptionalParam("to", "Account index that receives the NFT", 0, types.int)
  .setAction(
    scriptAction(async (args: { to: number }, hre) => {
      ensureLocalhost(hre);
      const owner = await accountAt(hre, args.to);
      const { nft } = await loadContracts(hre, owner);
      const tokenId = await mintNft(nft, owner.address);
      console.log(`Minted token ${tokenId} to account ${args.to} (${owner.address})`);
    }),
  );

// npm run create-auction -- --token 1 --bidding 10m --reveal 1d [--account 0]
task("create-auction", "Approve the NFT and create an auction")
  .addParam("token", "Token id of the NFT to sell", undefined, types.string)
  .addParam("bidding", "Bidding duration, 10m-5d (e.g. 10m, 1h, 1d)", undefined, types.string)
  .addParam("reveal", "Reveal duration, 1d-2d (e.g. 1d, 36h)", undefined, types.string)
  .addOptionalParam("account", "Seller account index (must own the NFT)", 0, types.int)
  .setAction(
    scriptAction(async (args: { token: string; bidding: string; reveal: string; account: number }, hre) => {
      ensureLocalhost(hre);
      const seller = await accountAt(hre, args.account);
      const { auction, nft } = await loadContracts(hre, seller);
      const created = await createAuction(
        auction,
        nft,
        seller,
        parseUint("token", args.token),
        parseDuration(args.bidding),
        parseDuration(args.reveal),
      );
      if (created.approved) console.log(`Approved the auction contract for token ${args.token}`);
      console.log(`Created auction ${created.auctionId} (seller: account ${args.account}, ${seller.address})`);
      console.log(`  bidding ends ${formatTime(created.biddingEnd)}`);
      console.log(`  reveal ends  ${formatTime(created.revealEnd)}`);
    }),
  );
