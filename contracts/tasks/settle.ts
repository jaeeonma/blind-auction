import { formatEther } from "ethers";
import { task, types } from "hardhat/config";
import { finalizeAuction, withdrawAll } from "../scripts/lib/settle";
import { parseUint } from "../scripts/lib/units";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run finalize -- --auction 0 [--account 0]
task("finalize", "Finalize an auction after the reveal phase (anyone can call)")
  .addParam("auction", "Auction id", undefined, types.string)
  .addOptionalParam("account", "Caller account index (any account)", 0, types.int)
  .setAction(
    scriptAction(async (args: { auction: string; account: number }, hre) => {
      ensureLocalhost(hre);
      const caller = await accountAt(hre, args.account);
      const { auction } = await loadContracts(hre, caller);
      const auctionId = parseUint("auction", args.auction);

      const r = await finalizeAuction(auction, auctionId);
      console.log(`Finalized auction ${auctionId}`);
      if (r.winner) {
        console.log(`  winner ${r.winner} at ${formatEther(r.winningBid)} ETH (gets the NFT)`);
      } else {
        console.log("  no valid bid: the NFT went back to the seller");
      }
      console.log(`  forfeited deposits (unrevealed bids) ${formatEther(r.forfeited)} ETH → seller`);
      console.log("  Winner and seller can now run withdraw.");
    }),
  );

// npm run withdraw -- --account 1
task("withdraw", "Withdraw everything credited to your account")
  .addOptionalParam("account", "Account index", 0, types.int)
  .setAction(
    scriptAction(async (args: { account: number }, hre) => {
      ensureLocalhost(hre);
      const account = await accountAt(hre, args.account);
      const { auction } = await loadContracts(hre, account);

      const amount = await withdrawAll(auction, account);
      console.log(`Withdrew ${formatEther(amount)} ETH to account ${args.account} (${account.address})`);
    }),
  );
