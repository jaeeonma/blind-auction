import { readFileSync } from "node:fs";
import { Interface, Wallet } from "ethers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { pendingOf, withdrawAll } from "../../web/js/actions.js";
import {
  AUCTION_ABI,
  ChainSetupError,
  DEFAULT_RPC_URL,
  NFT_ABI,
  connect,
  revertName,
  rpcUrlFrom,
  testAccounts,
} from "../../web/js/chain.js";
import { createAuction, deployContracts, eth, mineAt, placeBid, revealBid, type Chain as TestChain } from "../helpers/chain.js";

// The browser modules of the participation screens (design.md 17번 B), run in Node against the test
// node. They import "ethers", which in the browser is the import map and here the root package.

const compiled = (name: string) =>
  new Interface(
    JSON.parse(readFileSync(new URL(`../../contracts/artifacts/contracts/${name}.sol/${name}.json`, import.meta.url), "utf8")).abi,
  );

describe("web: chain connection", () => {
  let t: TestChain;
  let deployment: { network: string; chainId: number; blindAuction: string; mockNft: string; deployBlock: number };

  beforeEach(async () => {
    t = await deployContracts(inject("rpcUrl"));
    deployment = {
      network: "localhost",
      chainId: 31337,
      blindAuction: t.auctionAddress,
      mockNft: await t.nft.getAddress(),
      deployBlock: t.deployBlock,
    };
  });

  it("the ABI written in chain.js matches the compiled contracts (selectors, topics, return types)", () => {
    for (const [abi, name] of [
      [AUCTION_ABI, "BlindAuction"],
      [NFT_ABI, "MockNFT"],
    ] as const) {
      const written = new Interface(abi);
      const real = compiled(name);
      written.forEachFunction((f) => {
        // Same selector = same name and parameter types. Return types and mutability must match too,
        // or the browser would decode results wrongly. (Parameter names may differ.)
        const r = real.getFunction(f.selector);
        expect(r, `${name}.${f.format()}`).not.toBeNull();
        expect(f.stateMutability, `${name}.${f.name} mutability`).toBe(r!.stateMutability);
        expect(f.outputs.map((o) => o.format("sighash")), `${name}.${f.name} returns`).toEqual(r!.outputs.map((o) => o.format("sighash")));
      });
      written.forEachEvent((e) => expect(real.getEvent(e.topicHash), `${name} event ${e.name}`).not.toBeNull());
      written.forEachError((e) => expect(real.getError(e.selector), `${name} error ${e.name}`).not.toBeNull());
    }
  });

  it("takes the node address from ?rpc= only for a node on this computer", () => {
    expect(rpcUrlFrom("")).toEqual({ url: DEFAULT_RPC_URL, rejected: null });
    expect(rpcUrlFrom("?rpc=")).toEqual({ url: DEFAULT_RPC_URL, rejected: null });
    for (const [given, used] of [
      ["http://127.0.0.1:8547", "http://127.0.0.1:8547/"],
      ["http://localhost:8547", "http://localhost:8547/"],
      ["http://LOCALHOST:8547", "http://localhost:8547/"],
      ["http://[::1]:8545", "http://[::1]:8545/"],
      ["https://127.0.0.1:8545/rpc", "https://127.0.0.1:8545/rpc"],
    ]) {
      expect(rpcUrlFrom(`?rpc=${encodeURIComponent(given!)}`), given).toEqual({ url: used, rejected: null });
    }
    // Someone else's node could lie about the phase and receive the secrets of a reveal (design.md 16번).
    for (const given of [
      "http://evil.example:8545",
      "https://203.0.113.5:8545",
      "http://localhost.evil.example:8545",
      "http://127.0.0.1.nip.io:8545",
      "http://192.168.0.10:8545",
      "http://user:pw@127.0.0.1:8545",
      "ws://127.0.0.1:8545",
      "javascript:alert(1)",
      "127.0.0.1:8545",
    ]) {
      expect(rpcUrlFrom(`?rpc=${encodeURIComponent(given)}`), given).toEqual({ url: DEFAULT_RPC_URL, rejected: given });
    }
  });

  it("connects when the deployment record matches the node", async () => {
    const c = await connect(inject("rpcUrl"), deployment);
    expect(await c.auction.getFunction("nextAuctionId")()).toBe(0n);
    c.provider.destroy();
  });

  it("explains a deployment record that does not match the node (node restarted)", async () => {
    const empty = Wallet.createRandom().address;
    const err = await connect(inject("rpcUrl"), { ...deployment, blindAuction: empty }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainSetupError);
    expect((err as Error).message).toBe(
      `배포 기록의 BlindAuction 주소에 컨트랙트가 없습니다. 노드를 다시 켰다면 "npm run deploy"를 먼저 실행하세요. 주소: ${empty}`,
    );
  });

  it("refuses a node whose chain id differs from the deployment record (eth_chainId)", async () => {
    const err = await connect(inject("rpcUrl"), { ...deployment, chainId: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainSetupError);
    expect((err as Error).message).toBe(
      "노드의 chain id가 배포 기록과 달라서 연결하지 않았습니다. 배포 기록이 이 노드의 것인지 확인하세요. 배포 기록: 1, 노드: 31337",
    );
  });

  it("explains a node that cannot be reached", async () => {
    const err = await connect("http://127.0.0.1:1", deployment).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainSetupError);
    expect((err as Error).message).toMatch(/노드에 연결할 수 없습니다.*npm run node.*노드 주소: http:\/\/127\.0\.0\.1:1/);
  });

  it("lists the node's test accounts with balances", async () => {
    const c = await connect(inject("rpcUrl"), deployment);
    const accounts = await testAccounts(c.provider);
    expect(accounts).toHaveLength(10);
    expect(accounts[0]!.address.toLowerCase()).toBe((await t.seller.getAddress()).toLowerCase());
    expect(accounts.every((a) => a.balance > 0n)).toBe(true);
    c.provider.destroy();
  });

  it("reads the custom error name from a real revert over HTTP", async () => {
    const c = await connect(inject("rpcUrl"), deployment);
    const err = await c.auction.getFunction("getBid")(0n, Wallet.createRandom().address).catch((e: unknown) => e);
    // auction 0 does not exist yet
    expect(revertName(err)).toBe("AuctionNotFound");
    await createAuction(t);
    const err2 = await c.auction.getFunction("getBid")(0n, Wallet.createRandom().address).catch((e: unknown) => e);
    expect(revertName(err2)).toBe("BidNotFound");
    expect(revertName(new Error("network down"))).toBeUndefined();
    c.provider.destroy();
  });

  it("withdraw: refuses an empty ledger without sending, then pays out the whole ledger", async () => {
    const c = await connect(inject("rpcUrl"), deployment);
    const signer = await c.provider.getSigner(1);
    const address = await signer.getAddress();
    const nonce = await c.provider.getTransactionCount(address);
    await expect(withdrawAll(c, signer)).rejects.toThrow(`출금할 금액이 없는 지갑입니다: ${address}`);
    expect(await c.provider.getTransactionCount(address)).toBe(nonce);

    // An invalid bid (deposit < value) credits the full deposit at reveal.
    const auctionId = await createAuction(t);
    const bid = await placeBid(t, auctionId, t.bidders[0], eth("3"), eth("2"));
    await mineAt(t, (await t.auction.getFunction("getAuction")(auctionId)).biddingEnd);
    await revealBid(t, auctionId, bid);
    expect(await pendingOf(c, address)).toBe(eth("2"));

    const r = await withdrawAll(c, signer);
    expect(r.amount).toBe(eth("2"));
    expect(r.blockNumber).toBeGreaterThan(0);
    expect(await pendingOf(c, address)).toBe(0n);
    c.provider.destroy();
  });
});
