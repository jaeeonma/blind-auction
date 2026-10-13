import { randomBytes } from "node:crypto";
import { AbiCoder, hexlify, keccak256 } from "ethers";

/**
 * 해시 = 입찰가 + secret + 입찰자 주소 (design.md 4번 Q11).
 * BlindAuction.reveal의 keccak256(abi.encode(value, secret, msg.sender))와 순서·타입이 같아야 한다.
 * 하나라도 다르면 본인도 공개할 수 없으므로, 스크립트와 컨트랙트 테스트가 모두 이 함수 하나를 쓴다.
 */
export function computeCommitment(value: bigint, secret: string, bidder: string): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "address"], [value, secret, bidder]));
}

/** 입찰마다 새로 만드는 32바이트 secret (design.md 12번). 운영체제의 암호학적 난수를 쓴다. */
export function randomSecret(): string {
  return hexlify(randomBytes(32));
}
