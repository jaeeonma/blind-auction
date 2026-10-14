import { formatEther } from "ethers";
import { task, types } from "hardhat/config";
import { placeBid, revealFromFile } from "../scripts/lib/bid";
import { parseEthAmount, parseUint } from "../scripts/lib/units";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run bid -- --auction 0 --value 3 --deposit 5 --account 1
task("bid", "Place a sealed bid: saves value + secret to .bids/, then sends the hash and deposit")
  .addParam("auction", "Auction id", undefined, types.string)
  .addParam("value", "Bid value in ETH (kept secret until reveal)", undefined, types.string)
  .addParam("deposit", "Deposit in ETH (public; must be >= value for a valid bid)", undefined, types.string)
  .addOptionalParam("account", "Bidder account index", 0, types.int)
  .setAction(
    scriptAction(async (args: { auction: string; value: string; deposit: string; account: number }, hre) => {
      ensureLocalhost(hre);
      const bidder = await accountAt(hre, args.account);
      const { auction } = await loadContracts(hre, bidder);
      const auctionId = parseUint("auction", args.auction);
      const value = parseEthAmount(args.value);
      const deposit = parseEthAmount(args.deposit);

      const placed = await placeBid(auction, bidder, auctionId, value, deposit);

      for (const w of placed.warnings) console.log(`WARNING: ${w}`);
      if (placed.replacedFile) console.log("(An old secret file from a failed attempt was replaced.)");
      console.log(`Bid placed in auction ${auctionId} by account ${args.account} (${bidder.address})`);
      console.log(`  deposit ${formatEther(deposit)} ETH, hash ${placed.commitment}`);
      // The secret itself is never printed (design.md 8번).
      console.log(`  value and secret saved to ${placed.file}`);
      console.log("  Keep this file: without it the bid cannot be revealed and the deposit is forfeited.");
    }),
  );

// npm run reveal -- --auction 0 --account 1
task("reveal", "Reveal your bid using the saved secret file")
  .addParam("auction", "Auction id", undefined, types.string)
  .addOptionalParam("account", "Bidder account index", 0, types.int)
  .setAction(
    scriptAction(async (args: { auction: string; account: number }, hre) => {
      ensureLocalhost(hre);
      const bidder = await accountAt(hre, args.account);
      const { auction } = await loadContracts(hre, bidder);
      const auctionId = parseUint("auction", args.auction);

      const revealed = await revealFromFile(auction, bidder, auctionId);
      console.log(
        `Revealed account ${args.account}'s bid in auction ${auctionId}: ${formatEther(revealed.value)} ETH, ` +
          (revealed.valid ? "valid" : "INVALID (deposit < value) — the full deposit is credited for withdraw"),
      );
    }),
  );
