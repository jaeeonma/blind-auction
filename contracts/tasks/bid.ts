import { formatEther } from "ethers";
import { task, types } from "hardhat/config";
import { placeBid, revealFromFile } from "../scripts/lib/bid";
import { parseEthAmount, parseUint } from "../scripts/lib/units";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run bid -- --auction 0 --value 3 --deposit 5 --account 1
task("bid", "비공개 입찰: 입찰가와 secret을 .bids/에 저장한 뒤 해시와 보증금을 보낸다")
  .addParam("auction", "경매 번호", undefined, types.string)
  .addParam("value", "입찰가, ETH 단위 (공개 전까지 비밀)", undefined, types.string)
  .addParam("deposit", "보증금, ETH 단위 (공개됨. 입찰가 이상이어야 유효)", undefined, types.string)
  .addOptionalParam("account", "입찰자 계정 번호", 0, types.int)
  .setAction(
    scriptAction(async (args: { auction: string; value: string; deposit: string; account: number }, hre) => {
      ensureLocalhost(hre);
      const bidder = await accountAt(hre, args.account);
      const { auction } = await loadContracts(hre, bidder);
      const auctionId = parseUint("auction", args.auction);
      const value = parseEthAmount(args.value);
      const deposit = parseEthAmount(args.deposit);

      const placed = await placeBid(auction, bidder, auctionId, value, deposit);

      for (const w of placed.warnings) console.log(`경고: ${w}`);
      if (placed.replacedFile) console.log("(이전 시도가 실패해 남아 있던 secret 파일을 새 secret으로 바꿨습니다.)");
      console.log(`경매 ${auctionId}번에 입찰했습니다 (계정 ${args.account}번): ${bidder.address}`);
      console.log(`  보증금: ${formatEther(deposit)} ETH`);
      console.log(`  해시: ${placed.commitment}`);
      // The secret itself is never printed (design.md 8번).
      console.log(`  입찰가와 secret 저장 위치: ${placed.file}`);
      console.log("  이 파일을 지우지 마세요. 없으면 공개할 수 없고 보증금이 몰수됩니다.");
    }),
  );

// npm run reveal -- --auction 0 --account 1
task("reveal", "저장한 secret 파일로 입찰을 공개한다")
  .addParam("auction", "경매 번호", undefined, types.string)
  .addOptionalParam("account", "입찰자 계정 번호", 0, types.int)
  .setAction(
    scriptAction(async (args: { auction: string; account: number }, hre) => {
      ensureLocalhost(hre);
      const bidder = await accountAt(hre, args.account);
      const { auction } = await loadContracts(hre, bidder);
      const auctionId = parseUint("auction", args.auction);

      const revealed = await revealFromFile(auction, bidder, auctionId);
      const result = revealed.valid ? "유효" : "무효(보증금 < 입찰가)";
      console.log(`경매 ${auctionId}번에서 계정 ${args.account}번의 입찰을 공개했습니다. 결과: ${result}`);
      console.log(`  입찰가: ${formatEther(revealed.value)} ETH`);
      if (!revealed.valid) console.log("  보증금 전액이 장부에 적혀 withdraw로 출금할 수 있습니다.");
    }),
  );
