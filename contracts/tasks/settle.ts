import { formatEther } from "ethers";
import { task, types } from "hardhat/config";
import { finalizeAuction, withdrawAll } from "../scripts/lib/settle";
import { parseUint } from "../scripts/lib/units";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run finalize -- --auction 0 [--account 0]
task("finalize", "공개 기간이 끝난 경매를 종료한다 (누구나 호출 가능)")
  .addParam("auction", "경매 번호", undefined, types.string)
  .addOptionalParam("account", "호출할 계정 번호 (아무 계정이나 가능)", 0, types.int)
  .setAction(
    scriptAction(async (args: { auction: string; account: number }, hre) => {
      ensureLocalhost(hre);
      const caller = await accountAt(hre, args.account);
      const { auction } = await loadContracts(hre, caller);
      const auctionId = parseUint("auction", args.auction);

      const r = await finalizeAuction(auction, auctionId);
      console.log(`경매 ${auctionId}번을 종료했습니다`);
      if (r.winner) {
        console.log(`  낙찰가: ${formatEther(r.winningBid)} ETH`);
        console.log(`  낙찰자 (NFT를 받음): ${r.winner}`);
      } else {
        console.log("  유효 입찰 없음: NFT는 판매자에게 돌아갔습니다");
      }
      console.log(`  몰수금 (공개하지 않은 입찰의 보증금, 판매자 몫): ${formatEther(r.forfeited)} ETH`);
      console.log("  이제 낙찰자와 판매자는 withdraw로 출금할 수 있습니다.");
    }),
  );

// npm run withdraw -- --account 1
task("withdraw", "내 장부에 적힌 금액을 모두 출금한다")
  .addOptionalParam("account", "계정 번호", 0, types.int)
  .setAction(
    scriptAction(async (args: { account: number }, hre) => {
      ensureLocalhost(hre);
      const account = await accountAt(hre, args.account);
      const { auction } = await loadContracts(hre, account);

      const amount = await withdrawAll(auction, account);
      console.log(`계정 ${args.account}번으로 출금했습니다: ${formatEther(amount)} ETH (${account.address})`);
    }),
  );
