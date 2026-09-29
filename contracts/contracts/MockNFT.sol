// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title MockNFT
/// @notice 경매 대상으로 쓰는 테스트·시연용 ERC-721 (design.md 4.1)
/// @dev 검증된 OpenZeppelin ERC721을 상속하고 `mint`만 추가한다.
///      로컬 Hardhat 노드에서 테스트·시연용으로만 쓰므로 누구나 발행할 수 있게 했다.
contract MockNFT is ERC721 {
    uint256 public nextTokenId = 1;

    constructor() ERC721("Mock NFT", "MNFT") {}

    /// @notice `to`에게 새 토큰을 발행하고 tokenId를 반환한다 (1부터 시작).
    function mint(address to) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        // _safeMint 대신 _mint: 받는 쪽 콜백(onERC721Received)을 호출하지 않는다.
        // BlindAuction에서 transferFrom을 쓰는 이유와 같다 (design.md 2.7).
        _mint(to, tokenId);
    }
}
