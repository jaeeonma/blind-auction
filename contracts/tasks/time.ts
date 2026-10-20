import { task, types } from "hardhat/config";
import { phaseOf } from "../scripts/lib/bid";
import { increaseTime, latestBlockTime, moveTimeTo } from "../scripts/lib/time";
import { formatTime, parseDuration, parseUint } from "../scripts/lib/units";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run time-travel -- --seconds 1d
// npm run time-travel -- --auction 0 --to reveal   (bidding end: the reveal phase starts)
// npm run time-travel -- --auction 0 --to end      (reveal end: finalize becomes possible)
task("time-travel", "로컬 노드의 블록 시간을 앞당긴다 (시연용)")
  .addOptionalParam("seconds", "앞당길 시간 (예: 600, 10m, 1d)", undefined, types.string)
  .addOptionalParam("auction", "경매 번호 (--to와 함께)", undefined, types.string)
  .addOptionalParam("to", "reveal = 입찰 마감, end = 공개 마감 (--auction과 함께)", undefined, types.string)
  .setAction(
    scriptAction(async (args: { seconds?: string; auction?: string; to?: string }, hre) => {
      ensureLocalhost(hre);
      const provider = hre.ethers.provider;
      const before = await latestBlockTime(provider);

      if (args.seconds !== undefined) {
        if (args.auction !== undefined || args.to !== undefined) {
          throw new Error("--seconds와 --auction·--to는 함께 쓸 수 없습니다");
        }
        const after = await increaseTime(provider, parseDuration(args.seconds));
        console.log(`블록 시간: ${formatTime(before)} → ${formatTime(after)}`);
        return;
      }

      if (args.auction === undefined || (args.to !== "reveal" && args.to !== "end")) {
        throw new Error("--seconds N 또는 --auction <번호> --to reveal|end 중 하나를 주세요");
      }
      const { auction } = await loadContracts(hre, await accountAt(hre, 0));
      const auctionId = parseUint("auction", args.auction);
      await phaseOf(auction, auctionId); // clear error for an unknown auction
      const { biddingEnd, revealEnd } = await auction.getAuction(auctionId);
      const target = args.to === "reveal" ? biddingEnd : revealEnd;

      const r = await moveTimeTo(provider, target);
      if (r.moved) {
        console.log(`블록 시간: ${formatTime(before)} → ${formatTime(r.time)}`);
      } else {
        console.log(`블록 시간이 이미 목표 시각을 지나서 옮기지 않았습니다. 지금: ${formatTime(r.time)}, 목표: ${formatTime(target)}`);
      }
      console.log(`경매 ${auctionId}번의 현재 상태: ${await phaseOf(auction, auctionId)}`);
    }),
  );
