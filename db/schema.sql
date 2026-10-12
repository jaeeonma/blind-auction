-- Blind Auction DB 테이블 (design.md 10번)
--
-- 블록체인 이벤트를 옮겨 둔 조회용 사본이다. 블록체인과 다르면 블록체인이 맞다 (design.md 3번).
-- Indexer와 API가 이 파일 하나의 테이블을 같이 쓴다. `npm run db:init`으로 적용한다.
-- IF NOT EXISTS라 여러 번 실행해도 안전하다.
--
-- 공통 규칙
--   - 금액·토큰 번호·경매 번호(uint256)는 NUMERIC(78,0): uint256 최댓값(78자리)까지 정확히 담는다.
--     JavaScript number는 2^53까지만 정확해서 wei 금액을 숫자로 다루면 끝자리가 틀어진다.
--   - 주소는 소문자 0x + 40자리로만 저장한다 (CHECK로 강제). 대소문자가 섞이면 같은 지갑을 놓친다.
--   - 시간(입찰 마감, 공개 마감, 블록 시간)은 블록 시간과 같은 단위인 unix 초(BIGINT)로 저장한다.
--     컨트랙트가 block.timestamp와 비교하는 값을 그대로 옮겨서, 상태 계산 기준이 컨트랙트와 같아진다.
--   - 진행 상태(입찰 중, 공개 중, 종료 대기, 종료)는 칼럼으로 두지 않고 조회할 때 계산한다 (design.md 10번).
--   - secret과 공개 전 입찰가는 어떤 테이블에도 두지 않는다 (design.md 8번).

-- ───────────────────────────────────────────────────────────────
-- auctions: 경매 하나에 한 줄. 경매 생성됨 → INSERT, 종료됨 → UPDATE
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auctions (
  -- PRIMARY KEY = UNIQUE(경매 번호). 같은 경매 생성됨 이벤트를 두 번 읽어도 한 줄만 남는다 (design.md 9번).
  auction_id   NUMERIC(78, 0) PRIMARY KEY CHECK (auction_id >= 0),
  seller       TEXT           NOT NULL CHECK (seller ~ '^0x[0-9a-f]{40}$'),
  nft_address  TEXT           NOT NULL CHECK (nft_address ~ '^0x[0-9a-f]{40}$'),
  token_id     NUMERIC(78, 0) NOT NULL CHECK (token_id >= 0),
  bidding_end  BIGINT         NOT NULL,
  reveal_end   BIGINT         NOT NULL CHECK (reveal_end > bidding_end),

  -- 종료됨 이벤트에서 채운다. 종료 전에는 모두 비어 있다.
  finalized    BOOLEAN        NOT NULL DEFAULT FALSE,
  winner       TEXT           CHECK (winner ~ '^0x[0-9a-f]{40}$'), -- 유효 입찰이 없으면 종료 후에도 NULL
  winning_bid  NUMERIC(78, 0) CHECK (winning_bid >= 0),
  forfeited    NUMERIC(78, 0) CHECK (forfeited >= 0),

  -- 종료 여부와 결과 칼럼이 서로 맞는지 DB가 검사한다. Indexer 버그로 반쯤 채워진 줄이 생기지 않는다.
  CONSTRAINT auctions_finalized_fields CHECK (
    (NOT finalized AND winner IS NULL AND winning_bid IS NULL AND forfeited IS NULL)
    OR (finalized AND winning_bid IS NOT NULL AND forfeited IS NOT NULL)
  )
);

-- ───────────────────────────────────────────────────────────────
-- bids: (경매, 입찰자)마다 한 줄. 지갑당 한 경매에 1회만 입찰할 수 있기 때문이다 (design.md 4번 Q10).
-- 입찰됨 → INSERT, 공개됨·종료됨 → UPDATE
-- 사용자 테이블은 두지 않는다. 보증금·입찰가·결과는 "그 사람이 그 경매에 한 입찰"에 붙는 정보다 (design.md 10번).
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bids (
  auction_id  NUMERIC(78, 0) NOT NULL REFERENCES auctions (auction_id),
  bidder      TEXT           NOT NULL CHECK (bidder ~ '^0x[0-9a-f]{40}$'),
  commitment  TEXT           NOT NULL CHECK (commitment ~ '^0x[0-9a-f]{64}$'), -- 해시 (bytes32)
  deposit     NUMERIC(78, 0) NOT NULL CHECK (deposit >= 0),

  -- 공개됨 이벤트에서 채운다. 공개 전에는 입찰가를 알 수 없으므로 NULL이다.
  revealed    BOOLEAN        NOT NULL DEFAULT FALSE,
  value       NUMERIC(78, 0) CHECK (value >= 0),

  -- 결과 (design.md 6번 "결과 칼럼이 바뀌는 순서")
  --   unrevealed(미공개) → 공개됨 → valid(유효) | invalid(무효) → 종료됨 → valid는 won(낙찰) | lost(패찰)
  --   무효와 미공개는 종료 후에도 그대로 남는다 (미공개 = 몰수).
  result      TEXT           NOT NULL DEFAULT 'unrevealed'
              CHECK (result IN ('unrevealed', 'valid', 'invalid', 'won', 'lost')),

  -- PRIMARY KEY = UNIQUE(경매 번호, 입찰자 주소). 같은 입찰됨 이벤트를 두 번 읽어도 한 줄만 남는다 (design.md 9번).
  PRIMARY KEY (auction_id, bidder),

  -- 공개 여부, 입찰가, 결과가 서로 맞는지 DB가 검사한다.
  CONSTRAINT bids_revealed_fields CHECK (
    (NOT revealed AND value IS NULL AND result = 'unrevealed')
    OR (revealed AND value IS NOT NULL AND result IN ('valid', 'invalid', 'won', 'lost'))
  )
);

-- "특정 사용자가 참여한 경매" 조회용 (design.md 11번).
-- PRIMARY KEY는 (auction_id, bidder) 순서라 bidder만으로 찾을 때는 쓰이지 않아서 따로 둔다.
CREATE INDEX IF NOT EXISTS bids_bidder_idx ON bids (bidder);

-- ───────────────────────────────────────────────────────────────
-- indexer_state: Indexer의 책갈피. 한 줄만 둔다 (id = 1).
-- 이벤트 저장과 같은 DB 트랜잭션에서 갱신한다 (design.md 9번).
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS indexer_state (
  id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block       BIGINT   NOT NULL CHECK (last_block >= 0), -- 마지막으로 처리한 블록 번호
  last_block_time  BIGINT   NOT NULL                          -- 그 블록의 시간. 진행 상태 계산의 "현재 시각" (design.md 10번)
);
