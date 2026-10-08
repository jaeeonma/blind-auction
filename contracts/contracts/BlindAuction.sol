// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title BlindAuction
/// @notice Commit-Reveal 방식의 비공개 입찰 경매. NFT를 걸고 ETH로 입찰한다.
/// @dev 설계 기준: docs/design.md 4~7번, 13번
///      - 하나의 컨트랙트가 여러 경매를 auctionId로 관리한다 (Indexer가 주소 하나만 감시하면 됨).
///      - ETH는 Pull 방식으로만 지급한다: pendingWithdrawals(장부)에 적립 → 본인이 withdraw.
///      - 입찰자 전체를 순회하는 반복문을 두지 않는다 (가스 한도 초과로 종료가 막히는 것 방지, design.md 7번).
contract BlindAuction is ReentrancyGuard {
    // ─────────────────────────────────────────────────────────────
    // 타입
    // ─────────────────────────────────────────────────────────────

    /// @dev 상태는 저장하지 않고 블록 시간과 finalized 표시로 계산한다 (phaseOf, design.md 10번).
    ///      저장해 두면 "시간이 지났는데 상태 값은 그대로"인 불일치가 생길 수 있기 때문.
    ///      경매 취소는 없으므로(design.md 16번) 상태는 4개뿐이다.
    enum Phase {
        Bidding, // 입찰 중
        Reveal, // 공개 중
        AwaitingFinalize, // 종료 대기 (공개 마감 후, 아직 finalize 안 됨)
        Finalized // 종료
    }

    struct Auction {
        address seller;
        address nft;
        uint256 tokenId;
        uint64 biddingEnd;
        uint64 revealEnd;
        address highestBidder; // 현재 최고가 입찰자 (없으면 0)
        uint256 highestBid;
        uint256 highestBidSeq; // 동점 처리용: 최고가 입찰의 입찰 순서
        uint256 totalDeposits; // 모든 입찰 보증금 합계
        uint256 revealedDeposits; // 공개된 입찰 보증금 합계
        uint32 bidCount; // 입찰 수. 다음 입찰의 순서(seq)를 매기는 데도 쓴다
        bool finalized;
    }

    struct Bid {
        bytes32 commitment;
        uint256 deposit;
        uint256 seq; // 이 경매 안에서의 입찰 순서 (1부터). 0이면 입찰이 없다는 뜻
        bool revealed;
    }

    // ─────────────────────────────────────────────────────────────
    // 상수와 저장 데이터
    // ─────────────────────────────────────────────────────────────

    /// @dev 기간은 판매자가 정하되 범위를 제한한다 (design.md 4번 Q2).
    ///      공개는 모든 입찰자가 직접 트랜잭션을 보내야 하므로 입찰보다 여유 있게 둔다.
    ///      블록 생성자는 block.timestamp를 수 초 범위에서만 조정할 수 있어서, 최소 10분이면 그 영향은 무시할 수 있다.
    uint64 public constant MIN_BIDDING_DURATION = 10 minutes;
    uint64 public constant MAX_BIDDING_DURATION = 5 days;
    uint64 public constant MIN_REVEAL_DURATION = 1 days;
    uint64 public constant MAX_REVEAL_DURATION = 2 days;

    uint256 public nextAuctionId;
    mapping(uint256 => Auction) private auctions;
    /// @dev 지갑당 한 경매에 1회만 입찰하므로 (경매, 입찰자)마다 Bid 하나만 둔다 (design.md 4번 Q10).
    mapping(uint256 => mapping(address => Bid)) private bids;
    mapping(address => uint256) public pendingWithdrawals;

    // ─────────────────────────────────────────────────────────────
    // 이벤트 (design.md 6번)
    // Indexer가 추가 조회 없이 DB를 채울 수 있도록 필요한 값을 모두 담는다.
    // indexed 인자는 로그의 topic에 들어가 주소·ID로 필터링할 수 있다.
    // ─────────────────────────────────────────────────────────────

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint64 biddingEnd,
        uint64 revealEnd
    );
    event BidCommitted(uint256 indexed auctionId, address indexed bidder, bytes32 commitment, uint256 deposit);
    /// @dev valid = 보증금 ≥ 입찰가. 낙찰·패찰은 종료됨 이벤트의 winner로 정한다 (design.md 6번).
    event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint256 value, bool valid);
    /// @dev 유찰이면 winner = address(0), winningBid = 0
    event AuctionFinalized(
        uint256 indexed auctionId,
        address indexed winner,
        uint256 winningBid,
        uint256 forfeited
    );
    event Withdrawn(address indexed account, uint256 amount);

    // ─────────────────────────────────────────────────────────────
    // 에러
    // require("문자열") 대신 custom error: 배포·실행 가스가 적고,
    // 테스트에서 revertedWithCustomError로 어떤 에러인지 정확히 검증할 수 있다.
    // ─────────────────────────────────────────────────────────────

    error AuctionNotFound();
    error InvalidDuration();
    error InvalidPhase();
    error AlreadyBid();
    error BidNotFound();
    error AlreadyRevealed();
    error CommitmentMismatch();
    error NothingToWithdraw();
    error TransferFailed();

    // ─────────────────────────────────────────────────────────────
    // 상태 변경 함수
    // ─────────────────────────────────────────────────────────────

    /// @notice 경매를 만들고 NFT를 컨트랙트로 옮겨 보관(에스크로)한다.
    /// @dev 호출 전에 NFT 소유자가 이 컨트랙트에 approve(또는 setApprovalForAll)해야 한다.
    ///      transferFrom의 from이 msg.sender이므로 NFT 소유자 본인만 경매를 만들 수 있다 (design.md 13번).
    ///      최저가는 두지 않는다 (design.md 16번).
    function createAuction(
        address nft,
        uint256 tokenId,
        uint64 biddingDuration,
        uint64 revealDuration
    ) external returns (uint256 auctionId) {
        // [Checks]
        if (
            biddingDuration < MIN_BIDDING_DURATION ||
            biddingDuration > MAX_BIDDING_DURATION ||
            revealDuration < MIN_REVEAL_DURATION ||
            revealDuration > MAX_REVEAL_DURATION
        ) revert InvalidDuration();

        // [Effects] 외부 호출 전에 상태를 먼저 기록한다 (CEI 패턴).
        auctionId = nextAuctionId++;
        uint64 biddingEnd = uint64(block.timestamp) + biddingDuration;
        uint64 revealEnd = biddingEnd + revealDuration;

        Auction storage a = auctions[auctionId];
        a.seller = msg.sender;
        a.nft = nft;
        a.tokenId = tokenId;
        a.biddingEnd = biddingEnd;
        a.revealEnd = revealEnd;

        emit AuctionCreated(auctionId, msg.sender, nft, tokenId, biddingEnd, revealEnd);

        // [Interactions] NFT를 컨트랙트로 이동.
        // approve가 없거나 소유자가 아니면 NFT 컨트랙트가 revert → 위 기록도 전부 취소된다.
        // safeTransferFrom이 아닌 transferFrom: 받는 쪽(이 컨트랙트) 콜백이 필요 없다.
        IERC721(nft).transferFrom(msg.sender, address(this), tokenId);
    }

    /// @notice 입찰 기간에 해시(commitment)와 보증금(ETH)을 제출한다.
    /// @dev 입찰가는 해시로만 올라가므로 공개 기간 전까지 드러나지 않는다 (design.md 8번).
    ///      지갑당 한 경매에 1회만 입찰할 수 있다 (design.md 4번 Q10).
    ///      판매자의 입찰은 막지 않는다. 다른 지갑으로 입찰하면 우회되므로 막아도 의미가 없다 (Q9).
    ///      보증금 0도 막지 않는다. 보증금 ≥ 입찰가인지는 공개 때 판정한다 (Q3).
    function bid(uint256 auctionId, bytes32 commitment) external payable {
        // [Checks] 단계 검사를 가장 먼저 한다 (design.md 13번 "잘못된 상태").
        Auction storage a = _getAuction(auctionId);
        if (_phase(a) != Phase.Bidding) revert InvalidPhase();
        Bid storage b = bids[auctionId][msg.sender];
        // seq는 1부터 매기므로 0이 아니면 이미 입찰한 지갑이다 (design.md 13번 "중복 실행").
        // 보증금 0 입찰도 있을 수 있어서 deposit이 아니라 seq로 확인한다.
        if (b.seq != 0) revert AlreadyBid();

        // [Effects] 외부 호출이 없는 함수라 재진입 위험이 없다.
        // 입찰 순서를 저장해 두고, 동점이면 먼저 입찰한 쪽이 이긴다 (design.md 7번, Q5).
        a.bidCount += 1;
        b.commitment = commitment;
        b.deposit = msg.value;
        b.seq = a.bidCount;

        // 몰수금을 반복문 없이 계산하기 위해 보증금 합계를 누적한다 (design.md 7번).
        a.totalDeposits += msg.value;

        emit BidCommitted(auctionId, msg.sender, commitment, msg.value);
    }

    /// @notice 공개 기간에 입찰가와 secret을 제출해 입찰 때 낸 해시와 대조한다.
    /// @dev 입찰자 주소는 파라미터로 받지 않고 msg.sender만 쓴다 (design.md 5번).
    ///      - 조회: bids[auctionId][msg.sender] → 본인 입찰만 찾으므로 남의 입찰을 공개할 수 없다.
    ///      - 해시: msg.sender를 넣어 다시 계산하므로, 남의 해시를 복사해 입찰한 사람은
    ///        입찰가와 secret을 알아내도 같은 해시를 만들 수 없다 (design.md 4번 Q11).
    ///      반환은 종료 때가 아니라 지금 장부에 적는다. 공개는 한 명씩 들어오므로
    ///      종료 때 입찰자 전체를 반복문으로 돌 필요가 없다 (design.md 7번).
    function reveal(uint256 auctionId, uint256 value, bytes32 secret) external {
        // [Checks]
        Auction storage a = _getAuction(auctionId);
        if (_phase(a) != Phase.Reveal) revert InvalidPhase(); // 공개 기간에만 (design.md 13번 "잘못된 상태")

        Bid storage b = bids[auctionId][msg.sender];
        if (b.seq == 0) revert BidNotFound();
        // "공개했음" 표시로 같은 입찰을 두 번 공개해 반환금을 두 번 받는 것을 막는다 (design.md 13번 "중복 실행").
        if (b.revealed) revert AlreadyRevealed();

        // 해시 = 입찰가 + secret + 입찰자 주소 (design.md 4번 Q11). 입찰 스크립트와 같은 인코딩이어야 한다.
        bytes32 expected = keccak256(abi.encode(value, secret, msg.sender));
        if (expected != b.commitment) revert CommitmentMismatch();

        // [Effects] 이 함수는 외부 호출이 없다. ETH는 여기서 보내지 않고 장부에 적기만 한다 (Pull 방식).
        b.revealed = true;
        // 몰수금 = totalDeposits − revealedDeposits (finalize에서 반복문 없이 계산, design.md 7번)
        a.revealedDeposits += b.deposit;

        // 보증금이 입찰가 이상이면 유효, 아니면 무효 (design.md 4번 Q3).
        // 최저가가 없으므로 입찰가 0도 유효하다.
        bool valid = b.deposit >= value;

        // 이번 입찰이 새 최고가인가? 동점이면 입찰 순서(seq)가 빠른 쪽이 이긴다.
        // 공개 순서와는 무관하다: 먼저 입찰한 사람이 나중에 공개해도 동점이면 이긴다 (design.md 4번 Q5, 7번).
        // 입찰가 0도 유효하므로 "최고가가 아직 없음"은 금액(0)이 아니라 highestBidder == address(0)으로 확인한다.
        bool isNewHighest = valid &&
            (a.highestBidder == address(0) ||
                value > a.highestBid ||
                (value == a.highestBid && b.seq < a.highestBidSeq));

        // design.md 7번 표대로 장부에 적는다.
        if (isNewHighest) {
            // 새 최고가: 본인 보증금은 낙찰 대금으로 컨트랙트에 남겨 둔다 (차액은 종료 때 장부에 적는다).
            // 밀려난 이전 최고가에게는 보증금 전액을 적는다.
            // 지갑당 입찰이 하나뿐이라 (경매, 주소)로 그 사람의 보증금을 바로 찾을 수 있다.
            address previous = a.highestBidder;
            if (previous != address(0)) {
                pendingWithdrawals[previous] += bids[auctionId][previous].deposit;
            }
            a.highestBidder = msg.sender;
            a.highestBid = value;
            a.highestBidSeq = b.seq;
        } else {
            // 무효이거나, 유효하지만 현재 최고가에 졌다: 본인 보증금 전액을 적는다 (design.md 4번 Q3-1).
            pendingWithdrawals[msg.sender] += b.deposit;
        }

        emit BidRevealed(auctionId, msg.sender, value, valid);
    }

    /// @notice 공개 마감 후 경매를 정산한다. 누구나 1회 호출할 수 있다.
    /// @dev 판매자만 호출할 수 있으면, 결과가 마음에 안 드는 판매자가 호출하지 않아
    ///      모든 보증금이 묶일 수 있다. 그래서 누구나 호출할 수 있게 한다 (design.md 4번 Q8).
    ///      입찰자별 반환은 공개 때 이미 장부에 적었으므로, 여기서는 낙찰자와 판매자 몫만 적는다.
    ///      입찰자 전체를 도는 반복문이 없어서 입찰자가 많아도 가스 상한에 걸리지 않는다 (design.md 7번).
    function finalize(uint256 auctionId) external nonReentrant {
        // [Checks] 공개 마감 후, 아직 종료되지 않았을 때만.
        // 종료 후에는 phase가 Finalized가 되므로 두 번째 호출도 여기서 실패한다 (design.md 13번 "중복 실행").
        Auction storage a = _getAuction(auctionId);
        if (_phase(a) != Phase.AwaitingFinalize) revert InvalidPhase();

        // [Effects] 외부 호출(NFT 전송) 전에 "종료 여부" 표시와 장부 기록을 모두 끝낸다 (CEI 패턴).
        a.finalized = true;

        // 몰수금 = 보증금 전체 합계 − 공개된 보증금 합계 = 공개하지 않은 입찰의 보증금 (design.md 4번 Q4, 7번)
        uint256 forfeited = a.totalDeposits - a.revealedDeposits;
        address winner = a.highestBidder;
        // 유효 입찰이 없으면 highestBid는 0으로 남아 있다 → 낙찰가 0 (design.md 7번)
        uint256 winningBid = a.highestBid;

        if (winner != address(0)) {
            // 낙찰자: 보증금 − 낙찰가. 유효 입찰이라 보증금 ≥ 낙찰가가 보장되므로 음수가 되지 않는다.
            pendingWithdrawals[winner] += bids[auctionId][winner].deposit - winningBid;
        }
        // 판매자: 낙찰가 + 몰수금. 유효 입찰이 없으면 몰수금만 (design.md 4번 Q6, Q7).
        pendingWithdrawals[a.seller] += winningBid + forfeited;

        emit AuctionFinalized(auctionId, winner, winningBid, forfeited);

        // [Interactions] NFT는 낙찰자에게, 유효 입찰이 없으면 판매자에게 돌려준다 (design.md 5번).
        // safeTransferFrom이 아닌 transferFrom: safeTransferFrom은 받는 쪽이 컨트랙트면 콜백을 호출하는데,
        // 낙찰자 컨트랙트가 콜백에서 revert하면 종료 전체가 취소되어 모든 정산이 막힌다.
        // NFT 주소는 판매자가 넣은 임의 컨트랙트라 이 호출 중에 다시 들어올 수 있으므로 nonReentrant도 단다.
        address nftReceiver = winner != address(0) ? winner : a.seller;
        IERC721(a.nft).transferFrom(address(this), nftReceiver, a.tokenId);
    }

    /// @notice 장부에 적힌 자기 몫을 출금한다. 언제든 호출할 수 있다.
    /// @dev 컨트랙트가 여러 명에게 직접 송금하지 않고, 각자 자기 몫을 가져간다 (Pull 방식, design.md 13번 "자산 전송").
    ///      직접 보내면 한 명이 송금을 거부할 때(받는 쪽 컨트랙트가 revert) 다른 사람의 정산까지 막힌다.
    ///      자기 몫만 출금하므로 남의 장부에는 손댈 수 없다 (design.md 13번 "권한 없는 사용자").
    function withdraw() external nonReentrant {
        // [Checks]
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw(); // 두 번째 출금은 받을 돈이 없어 실패한다

        // [Effects] 송금하기 전에 장부를 먼저 0으로 만든다 (CEI 패턴, design.md 13번 "취약점").
        // 송금을 먼저 하면, 받는 쪽 컨트랙트가 ETH를 받는 순간(receive) withdraw를 다시 호출했을 때
        // 장부가 아직 그대로라 같은 금액을 또 받아 갈 수 있다 → 남의 보증금까지 빠져나간다.
        pendingWithdrawals[msg.sender] = 0;
        emit Withdrawn(msg.sender, amount);

        // [Interactions] transfer() 대신 call: transfer는 가스를 2300으로 제한해서 받는 쪽이 컨트랙트 지갑이면 실패할 수 있다.
        // call은 가스 제한이 없어 재진입 여지가 생기므로, 위의 CEI 순서와 nonReentrant(재호출 잠금)로 이중으로 막는다.
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        // 송금이 실패하면 revert → 장부를 0으로 만든 것도 취소되어 돈을 잃지 않는다.
        if (!ok) revert TransferFailed();
    }

    // ─────────────────────────────────────────────────────────────
    // 조회 함수 (테스트와 사용자 스크립트용)
    // ─────────────────────────────────────────────────────────────

    function getAuction(uint256 auctionId) external view returns (Auction memory) {
        return _getAuction(auctionId);
    }

    /// @notice 현재 경매 상태 (design.md 10번 상태표)
    function phaseOf(uint256 auctionId) external view returns (Phase) {
        return _phase(_getAuction(auctionId));
    }

    function getBid(uint256 auctionId, address bidder) external view returns (Bid memory b) {
        _getAuction(auctionId);
        b = bids[auctionId][bidder];
        if (b.seq == 0) revert BidNotFound();
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

    /// @dev 시간 판단은 block.timestamp 하나로 통일한다 (design.md 13번 "잘못된 상태").
    ///      Indexer·API도 서버 시계가 아니라 블록 시간으로 같은 계산을 한다 (design.md 10번).
    function _phase(Auction storage a) private view returns (Phase) {
        if (a.finalized) return Phase.Finalized;
        if (block.timestamp < a.biddingEnd) return Phase.Bidding;
        if (block.timestamp < a.revealEnd) return Phase.Reveal;
        return Phase.AwaitingFinalize;
    }
}
