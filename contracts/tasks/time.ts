import { task, types } from "hardhat/config";
import { phaseOf } from "../scripts/lib/bid";
import { increaseTime, latestBlockTime, moveTimeTo } from "../scripts/lib/time";
import { formatTime, parseDuration, parseUint } from "../scripts/lib/units";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run time-travel -- --seconds 1d
// npm run time-travel -- --auction 0 --to reveal   (bidding end: the reveal phase starts)
// npm run time-travel -- --auction 0 --to end      (reveal end: finalize becomes possible)
task("time-travel", "Move the local node's block time forward (demo only)")
  .addOptionalParam("seconds", "How far to move, e.g. 600, 10m, 1d", undefined, types.string)
  .addOptionalParam("auction", "Auction id (with --to)", undefined, types.string)
  .addOptionalParam("to", "reveal = bidding end, end = reveal end (with --auction)", undefined, types.string)
  .setAction(
    scriptAction(async (args: { seconds?: string; auction?: string; to?: string }, hre) => {
      ensureLocalhost(hre);
      const provider = hre.ethers.provider;
      const before = await latestBlockTime(provider);

      if (args.seconds !== undefined) {
        if (args.auction !== undefined || args.to !== undefined) throw new Error("Use either --seconds or --auction with --to");
        const after = await increaseTime(provider, parseDuration(args.seconds));
        console.log(`Block time ${formatTime(before)} → ${formatTime(after)}`);
        return;
      }

      if (args.auction === undefined || (args.to !== "reveal" && args.to !== "end")) {
        throw new Error("Give --seconds N, or --auction <id> --to reveal|end");
      }
      const { auction } = await loadContracts(hre, await accountAt(hre, 0));
      const auctionId = parseUint("auction", args.auction);
      await phaseOf(auction, auctionId); // clear error for an unknown auction
      const { biddingEnd, revealEnd } = await auction.getAuction(auctionId);
      const target = args.to === "reveal" ? biddingEnd : revealEnd;

      const r = await moveTimeTo(provider, target);
      if (r.moved) console.log(`Block time ${formatTime(before)} → ${formatTime(r.time)}`);
      else console.log(`Block time is already ${formatTime(r.time)}, past the target ${formatTime(target)}; not moved`);
      console.log(`Auction ${auctionId} is now: ${await phaseOf(auction, auctionId)}`);
    }),
  );
