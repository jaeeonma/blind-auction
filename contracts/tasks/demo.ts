import { task } from "hardhat/config";
import { runExample } from "../scripts/lib/demo";
import { accountAt, ensureLocalhost, loadContracts, scriptAction } from "./common";

// npm run demo
// Runs the design.md 7번 example on the deployed contract (so the Indexer and API see it too).
// Accounts: 0 = seller, 1-4 = A-D. Each run uses a new NFT and a new auction.
task("demo", "Run the design.md 7번 example end to end (create → bid → reveal → finalize → withdraw)").setAction(
  scriptAction(async (_args, hre) => {
    ensureLocalhost(hre);
    const [seller, a, b, c, d] = await Promise.all([0, 1, 2, 3, 4].map((i) => accountAt(hre, i)));
    const { auction, nft, deployment } = await loadContracts(hre, seller!);
    console.log(`BlindAuction ${deployment.blindAuction}`);
    const r = await runExample(auction, nft, hre.ethers.provider, { seller: seller!, bidders: [a!, b!, c!, d!] });
    console.log(`(See it through the API: GET /auctions/${r.auctionId})`);
  }),
);
