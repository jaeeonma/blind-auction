import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * secret 파일 (design.md 8번, 12번).
 * 입찰가와 secret은 입찰자 본인 컴퓨터에만 둔다. 서버·DB·Git에는 절대 올리지 않는다 (.bids/는 .gitignore 대상).
 * 이 파일을 잃으면 공개할 수 없고 보증금은 몰수된다 (Q4).
 */
export interface BidFile {
  chainId: number;
  contract: string;
  auctionId: string;
  bidder: string;
  /** 입찰가 (wei) */
  value: string;
  /** 32바이트 secret (0x...) */
  secret: string;
  /** 보증금 (wei) */
  deposit: string;
  /** 체인에 올린 해시. 공개 전에 파일이 맞는지 확인하는 데 쓴다. */
  commitment: string;
  createdAt: string;
}

export interface BidKey {
  chainId: number;
  contract: string;
  auctionId: bigint | string;
  bidder: string;
}

/** 저장소 루트의 .bids/. 테스트는 BIDS_DIR로 다른 폴더를 쓴다. */
export function bidsDir(): string {
  return process.env.BIDS_DIR ? path.resolve(process.env.BIDS_DIR) : path.resolve(__dirname, "../../../.bids");
}

/**
 * 입찰 하나에 파일 하나: <chainId>-<contract>-<auctionId>-<bidder>.json
 * 지갑당 한 경매에 1회라 이 조합은 유일하다 (Q10). 체인과 컨트랙트까지 넣는 이유는 로컬 노드를
 * 다시 켜면 같은 경매 번호가 새 컨트랙트에 또 생기기 때문이다.
 */
export function bidFilePath(key: BidKey, dir = bidsDir()): string {
  const name = `${key.chainId}-${key.contract.toLowerCase()}-${key.auctionId}-${key.bidder.toLowerCase()}.json`;
  return path.join(dir, name);
}

export function bidFileExists(key: BidKey, dir = bidsDir()): boolean {
  return existsSync(bidFilePath(key, dir));
}

/**
 * 파일을 끝까지 디스크에 쓴 뒤에 돌아온다. 입찰 트랜잭션은 이 함수가 끝난 다음에 보낸다.
 * 임시 파일에 쓰고 fsync한 뒤 이름을 바꿔서, 중간에 프로그램이 죽어도 반쯤 쓰인 secret 파일이 남지 않는다.
 */
export function writeBidFile(bid: BidFile, dir = bidsDir()): string {
  mkdirSync(dir, { recursive: true });
  const file = bidFilePath(bid, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600); // 0o600: owner only (ignored on Windows)
  try {
    writeSync(fd, JSON.stringify(bid, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return file;
}

export function readBidFile(key: BidKey, dir = bidsDir()): BidFile {
  const file = bidFilePath(key, dir);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `No secret file for auction ${key.auctionId} and ${key.bidder} (${file}). ` +
        "Without the value and secret the bid cannot be revealed and its deposit is forfeited (design.md 4번 Q4).",
    );
  }
  return JSON.parse(raw) as BidFile;
}
