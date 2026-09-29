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

    /// @notice 입찰 단계에 commitment(해시)와 보증금(ETH)을 제출한다.
    /// @dev commitment = keccak256(abi.encode(address(this), auctionId, bidder, value, fake, salt))
    ///      실제 금액(value)은 공개 단계 전까지 드러나지 않는다.
    ///      보증금(msg.value)은 누구나 볼 수 있으므로 입찰가보다 크게 넣거나(초과 보증금),
    ///      fake 입찰을 섞어 입찰가를 추측하기 어렵게 한다 (design.md 2.2).
    ///      같은 주소가 여러 번 입찰할 수 있다 (가짜 입찰을 섞기 위해 필요, design.md 2.5).
    function bid(uint256 auctionId, bytes32 commitment) external payable {
        // [Checks] 상태 확인을 가장 먼저 한다 (design.md 8.1).
        Auction storage a = _getAuction(auctionId);
        if (_phase(a) != Phase.Bidding) revert InvalidPhase();
        if (msg.sender == a.seller) revert SellerCannotBid();
        if (msg.value == 0) revert ZeroDeposit();

        // [Effects] 외부 호출이 없는 함수라 재진입 위험이 없다.
        // seq는 모든 경매에서 공유하는 전역 순번이고 1부터 시작한다.
        // 동점일 때 "먼저 제출된 입찰"을 가리는 기준이 된다 (design.md 2.4).
        uint256 seq = ++bidSeq;
        Bid[] storage myBids = bids[auctionId][msg.sender];
        uint256 bidIndex = myBids.length;
        myBids.push(Bid({commitment: commitment, deposit: msg.value, seq: seq, revealed: false}));

        // 몰수액을 반복문 없이 계산하기 위해 합계를 누적한다 (design.md 4.2).
        a.totalDeposits += msg.value;
        a.bidCount += 1;

        emit BidCommitted(auctionId, msg.sender, bidIndex, seq, commitment, msg.value);
    }

    /// @notice 공개 단계에 입찰 원문(value, fake, salt)을 제출해 commitment와 대조한다.
    /// @dev 입찰자 주소는 파라미터로 받지 않고 msg.sender만 쓴다.
    ///      - 조회: bids[auctionId][msg.sender] → 본인 입찰 목록에서만 찾으므로 남의 입찰을 공개할 수 없다.
    ///      - 해시: msg.sender를 넣어 계산하므로 남의 commitment를 복사해 제출해도
    ///        복사한 사람은 같은 해시를 만들 수 없다 (design.md 8.2 Commitment 복사).
    ///      입찰자 전체를 다시 돌지 않도록, 공개될 때마다 최고가를 즉시 갱신한다 (design.md 2.4).
    function reveal(uint256 auctionId, uint256 bidIndex, uint256 value, bool fake, bytes32 salt) external {
        // [Checks]
        Auction storage a = _getAuction(auctionId);
        if (_phase(a) != Phase.Reveal) revert InvalidPhase();

        Bid[] storage myBids = bids[auctionId][msg.sender];
        if (bidIndex >= myBids.length) revert BidNotFound();
        Bid storage b = myBids[bidIndex];
        if (b.revealed) revert AlreadyRevealed(); // 같은 입찰을 두 번 공개해 반환금을 두 번 받는 것을 막는다.

        // 입찰 때와 같은 인코딩으로 해시를 다시 계산한다 (design.md 2.2).
        // address(this)와 auctionId가 들어 있어 다른 배포·다른 경매의 commitment는 통과하지 못한다.
        bytes32 expected = keccak256(abi.encode(address(this), auctionId, msg.sender, value, fake, salt));
        if (expected != b.commitment) revert CommitmentMismatch();

        // [Effects] 이 함수는 외부 호출이 없다. ETH는 여기서 보내지 않고 적립만 한다 (Pull 방식).
        b.revealed = true;
        a.revealedDeposits += b.deposit; // 몰수액 = totalDeposits - revealedDeposits (finalize에서 사용)
        uint256 refund = b.deposit;

        // 유효성 판정 (design.md 2.3). 무효 입찰은 보증금 전액을 돌려받는다.
        InvalidReason reason;
        if (fake) {
            reason = InvalidReason.Fake;
        } else if (b.deposit < value) {
            reason = InvalidReason.InsufficientDeposit;
        } else if (value == 0 || value < a.reservePrice) {
            reason = InvalidReason.BelowReserve;
        } else {
            reason = InvalidReason.None;
        }

        // 최고가 갱신. 동점이면 seq(제출 순번)가 작은 입찰이 이긴다 → 공개 순서와 무관 (design.md 2.4).
        // value > 0이 보장되므로 최고가가 없는 상태(highestBid == 0)에서는 항상 첫 번째 조건으로 들어온다.
        if (
            reason == InvalidReason.None &&
            (value > a.highestBid || (value == a.highestBid && b.seq < a.highestBidSeq))
        ) {
            // 밀려난 이전 최고가 입찰의 금액을 그 입찰자에게 적립한다.
            // 이전 최고가 입찰자가 msg.sender 본인일 수도 있다 (한 사람의 여러 입찰).
            if (a.highestBidder != address(0)) {
                pendingWithdrawals[a.highestBidder] += a.highestBid;
            }
            a.highestBidder = msg.sender;
            a.highestBid = value;
            a.highestBidSeq = b.seq;
            // 최고가 입찰의 금액(value)은 낙찰 대금으로 컨트랙트에 남겨 두고, 차액만 돌려준다.
            // 유효 입찰이면 deposit >= value가 보장되므로 음수가 되지 않는다.
            refund -= value;
            emit HighestBidUpdated(auctionId, msg.sender, value);
        }

        pendingWithdrawals[msg.sender] += refund;
        emit BidRevealed(auctionId, msg.sender, bidIndex, value, fake, reason, refund);
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

    function getBid(uint256 auctionId, address bidder, uint256 bidIndex) external view returns (Bid memory) {
        _getAuction(auctionId);
        Bid[] storage list = bids[auctionId][bidder];
        if (bidIndex >= list.length) revert BidNotFound();
        return list[bidIndex];
    }

    function bidCountOf(uint256 auctionId, address bidder) external view returns (uint256) {
        _getAuction(auctionId);
        return bids[auctionId][bidder].length;
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
