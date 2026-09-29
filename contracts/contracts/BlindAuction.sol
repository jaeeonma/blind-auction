// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BlindAuction
/// @notice Commit-Reveal 방식의 비공개 입찰 경매. NFT를 걸고 ETH로 입찰한다.
/// @dev 설계 기준: docs/design.md 2~4장, 8장
///      - 하나의 컨트랙트가 여러 경매를 auctionId로 관리한다 (Indexer가 주소 하나만 감시하면 됨).
///      - ETH는 Pull 방식으로만 지급한다: pendingWithdrawals에 적립 → 본인이 withdraw.
///      - 입찰자 전체를 순회하는 반복문을 두지 않는다 (가스 한도 초과 DoS 방지).
contract BlindAuction is ReentrancyGuard {
    // ─────────────────────────────────────────────────────────────
    // 타입 (design.md 3.1, 4.2, 4.5)
    // ─────────────────────────────────────────────────────────────

    /// @dev 상태는 저장하지 않고 시간과 플래그로 계산한다 (phaseOf).
    ///      저장해 두면 "시간이 지났는데 상태 값은 그대로"인 불일치가 생길 수 있기 때문.
    enum Phase {
        Bidding,
        Reveal,
        AwaitingFinalize,
        Settled,
        NoWinner,
        Cancelled
    }

    enum InvalidReason {
        None,
        Fake,
        InsufficientDeposit,
        BelowReserve
    }

    struct Auction {
        address seller;
        address nft;
        uint256 tokenId;
        uint256 reservePrice; // 최저가 (wei)
        uint64 biddingEnd;
        uint64 revealEnd;
        address highestBidder; // 현재 최고가 입찰자 (없으면 0)
        uint256 highestBid;
        uint256 highestBidSeq; // 동점 처리용: 최고가 입찰의 제출 순번
        uint256 totalDeposits; // 모든 입찰 보증금 합계
        uint256 revealedDeposits; // 공개된 입찰 보증금 합계
        uint32 bidCount;
        bool finalized;
        bool cancelled;
    }

    struct Bid {
        bytes32 commitment;
        uint256 deposit;
        uint256 seq; // 전역 제출 순번 (동점이면 작은 쪽이 낙찰)
        bool revealed;
    }

    // ─────────────────────────────────────────────────────────────
    // 상수와 저장 데이터
    // ─────────────────────────────────────────────────────────────

    /// @dev 블록 생성자는 block.timestamp를 수 초 범위에서만 조정할 수 있다.
    ///      기간을 최소 1분으로 두어 그 영향을 무시할 수 있게 한다 (design.md 8.2).
    uint64 public constant MIN_DURATION = 1 minutes;
    uint64 public constant MAX_DURATION = 30 days;

    uint256 public nextAuctionId;
    uint256 private bidSeq;
    mapping(uint256 => Auction) private auctions;
    mapping(uint256 => mapping(address => Bid[])) private bids;
    mapping(address => uint256) public pendingWithdrawals;

    // ─────────────────────────────────────────────────────────────
    // 이벤트 (design.md 4.5)
    // Indexer가 추가 조회 없이 DB를 채울 수 있도록 필요한 값을 모두 담는다.
    // indexed 인자는 로그의 topic에 들어가 주소·ID로 필터링할 수 있다.
    // ─────────────────────────────────────────────────────────────

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint256 reservePrice,
        uint64 biddingEnd,
        uint64 revealEnd
    );
    event BidCommitted(
        uint256 indexed auctionId,
        address indexed bidder,
        uint256 bidIndex,
        uint256 seq,
        bytes32 commitment,
        uint256 deposit
    );
    event BidRevealed(
        uint256 indexed auctionId,
        address indexed bidder,
        uint256 bidIndex,
        uint256 value,
        bool fake,
        InvalidReason reason,
        uint256 refund
    );
    event HighestBidUpdated(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    /// @dev 유찰이면 winner = address(0), winningBid = 0
    event AuctionFinalized(
        uint256 indexed auctionId,
        address indexed winner,
        uint256 winningBid,
        uint256 forfeited
    );
    event AuctionCancelled(uint256 indexed auctionId);
    event Withdrawn(address indexed account, uint256 amount);

    // ─────────────────────────────────────────────────────────────
    // 에러 (design.md 4.6)
    // require("문자열") 대신 custom error: 배포·실행 가스가 적고,
    // 테스트에서 revertedWithCustomError로 어떤 에러인지 정확히 검증할 수 있다.
    // ─────────────────────────────────────────────────────────────

    error AuctionNotFound();
    error InvalidDuration();
    error InvalidPhase();
    error NotSeller();
    error SellerCannotBid();
    error ZeroDeposit();
    error BidNotFound();
    error AlreadyRevealed();
    error CommitmentMismatch();
    error AuctionHasBids();
    error NothingToWithdraw();
    error TransferFailed();

    // ─────────────────────────────────────────────────────────────
    // 상태 변경 함수
    // ─────────────────────────────────────────────────────────────

    /// @notice 경매를 만들고 NFT를 컨트랙트로 옮겨 보관(에스크로)한다.
    /// @dev 호출 전에 NFT 소유자가 이 컨트랙트에 approve(또는 setApprovalForAll)해야 한다.
    ///      transferFrom의 from이 msg.sender이므로 NFT 소유자 본인만 경매를 만들 수 있다.
    function createAuction(
        address nft,
        uint256 tokenId,
        uint256 reservePrice,
        uint64 biddingDuration,
        uint64 revealDuration
    ) external returns (uint256 auctionId) {
        // [Checks]
        if (
            biddingDuration < MIN_DURATION ||
            biddingDuration > MAX_DURATION ||
            revealDuration < MIN_DURATION ||
            revealDuration > MAX_DURATION
        ) revert InvalidDuration();

        // [Effects] 외부 호출 전에 상태를 먼저 기록한다 (CEI 패턴).
        auctionId = nextAuctionId++;
        uint64 biddingEnd = uint64(block.timestamp) + biddingDuration;
        uint64 revealEnd = biddingEnd + revealDuration;

        Auction storage a = auctions[auctionId];
        a.seller = msg.sender;
        a.nft = nft;
        a.tokenId = tokenId;
        a.reservePrice = reservePrice;
        a.biddingEnd = biddingEnd;
        a.revealEnd = revealEnd;

        emit AuctionCreated(auctionId, msg.sender, nft, tokenId, reservePrice, biddingEnd, revealEnd);

        // [Interactions] NFT를 컨트랙트로 이동.
        // approve가 없거나 소유자가 아니면 NFT 컨트랙트가 revert → 위 기록도 전부 취소된다.
        // safeTransferFrom이 아닌 transferFrom: 받는 쪽(이 컨트랙트) 콜백이 필요 없다.
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
    }

    // ─────────────────────────────────────────────────────────────
    // 조회 함수 (design.md 4.4)
    // ─────────────────────────────────────────────────────────────

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return _getAuction(auctionId);
    }

    /// @notice 현재 경매 상태 (design.md 3.1)
    function phaseOf(uint256 auctionId) external view returns (Phase) {
        return _phase(_getAuction(auctionId));
    }

    // ─────────────────────────────────────────────────────────────
    // 내부 함수
    // ─────────────────────────────────────────────────────────────

    /// @dev mapping은 없는 키를 읽어도 0으로 채워진 값을 돌려준다.
    ///      그래서 seller가 0이면 "생성되지 않은 경매"로 판단한다.
    function _getAuction(uint256 auctionId) private view returns (Auction storage a) {
        a = auctions[auctionId];
        if (a.seller == address(0)) revert AuctionNotFound();
    }

    /// @dev 시간 판단은 block.timestamp 하나로 통일한다 (design.md 8.1).
    function _phase(Auction storage a) private view returns (Phase) {
        if (a.cancelled) return Phase.Cancelled;
        if (a.finalized) return a.highestBidder != address(0) ? Phase.Settled : Phase.NoWinner;
        if (block.timestamp < a.biddingEnd) return Phase.Bidding;
        if (block.timestamp < a.revealEnd) return Phase.Reveal;
        return Phase.AwaitingFinalize;
    }
}
