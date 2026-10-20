import { task, types } from "hardhat/config";
import { createAuction, mintNft } from "../scripts/lib/auction";
import { formatTime, parseDuration, parseUint } from "../scripts/lib/units";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run mint-nft [-- --to 0]
task("mint-nft", "테스트 NFT를 발행한다 (시연용)")
  .addOptionalParam("to", "NFT를 받을 계정 번호", 0, types.int)
  .setAction(
    scriptAction(async (args: { to: number }, hre) => {
      ensureLocalhost(hre);
      const owner = await accountAt(hre, args.to);
      const { nft } = await loadContracts(hre, owner);
      const tokenId = await mintNft(nft, owner.address);
      console.log(`토큰 ${tokenId}번 발행 → 계정 ${args.to}번: ${owner.address}`);
    }),
  );

// npm run create-auction -- --token 1 --bidding 10m --reveal 1d [--account 0]
task("create-auction", "NFT를 승인(approve)하고 경매를 만든다")
  .addParam("token", "판매할 NFT의 토큰 번호", undefined, types.string)
  .addParam("bidding", "입찰 기간, 10m~5d (예: 10m, 1h, 1d)", undefined, types.string)
  .addParam("reveal", "공개 기간, 1d~2d (예: 1d, 36h)", undefined, types.string)
  .addOptionalParam("account", "판매자 계정 번호 (NFT 주인이어야 함)", 0, types.int)
  .setAction(
    scriptAction(async (args: { token: string; bidding: string; reveal: string; account: number }, hre) => {
      ensureLocalhost(hre);
      const seller = await accountAt(hre, args.account);
      const { auction, nft } = await loadContracts(hre, seller);
      const tokenId = parseUint("token", args.token);
      const created = await createAuction(
        auction,
        nft,
        seller,
        tokenId,
        parseDuration(args.bidding),
        parseDuration(args.reveal),
      );
      if (created.approved) console.log(`토큰 ${tokenId}번을 경매 컨트랙트가 가져갈 수 있게 승인(approve)했습니다`);
      console.log(`경매 ${created.auctionId}번 생성 (판매자: 계정 ${args.account}번): ${seller.address}`);
      console.log(`  입찰 마감: ${formatTime(created.biddingEnd)}`);
      console.log(`  공개 마감: ${formatTime(created.revealEnd)}`);
    }),
  );
