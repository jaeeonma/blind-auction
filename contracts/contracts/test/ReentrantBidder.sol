// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BlindAuction} from "../BlindAuction.sol";

/// @title ReentrantBidder
/// @notice 테스트 전용 공격 컨트랙트. 배포 스크립트에서는 쓰지 않는다.
/// @dev 입찰·공개해서 장부에 돈을 쌓은 뒤 withdraw를 호출하고,
///      ETH를 받는 순간(receive) withdraw를 한 번 더 호출해 같은 금액을 두 번 받으려 한다 (재진입 공격).
///      BlindAuction이 막아야 하는 공격이다 (design.md 13번 "취약점", 14번).
contract ReentrantBidder {
    /// @dev Swallow: 재진입 실패를 try/catch로 삼키고 첫 출금은 끝까지 받는다 → 정확히 한 번만 받는지 확인.
    ///      Bubble: 재진입 실패를 그대로 올린다 → 송금 자체가 실패(TransferFailed)하는지 확인.
    enum Mode {
        Swallow,
        Bubble
    }

    BlindAuction public immutable auction;
    Mode public mode;
    bool public reentryAttempted;
    bool public reentryBlocked;
    bytes public reentryError; // 재진입이 막혔을 때의 revert 데이터 (어떤 에러로 막혔는지 테스트에서 확인)

    constructor(BlindAuction auction_) {
        auction = auction_;
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function bid(uint256 auctionId, bytes32 commitment) external payable {
        auction.bid{value: msg.value}(auctionId, commitment);
    }

    function reveal(uint256 auctionId, uint256 value, bytes32 secret) external {
        auction.reveal(auctionId, value, secret);
    }

    function attack() external {
        auction.withdraw();
    }

    receive() external payable {
        // 첫 송금을 받는 중에 한 번만 다시 호출한다.
        if (reentryAttempted) return;
        reentryAttempted = true;

        if (mode == Mode.Swallow) {
            try auction.withdraw() {
                // 여기까지 오면 재진입 성공 = 취약점
            } catch (bytes memory reason) {
                reentryBlocked = true;
                reentryError = reason;
            }
        } else {
            auction.withdraw();
        }
    }
}
