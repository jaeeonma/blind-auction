# Blind Auction

NFT를 ETH로 비공개 입찰하는 경매(Commit-Reveal). 입찰가는 해시로 숨겨 내고, 입찰 기간이 끝나면 각자 공개한다. NFT와 ETH의 교환은 스마트 컨트랙트가 보장하고, Indexer가 이벤트를 PostgreSQL에 모으며, REST API가 조회를 제공한다.

- **동작하는 것:** 경매 생성 → 입찰 → 공개 → 낙찰·정산 → 출금 전체, 이벤트 수집(중단 후 재시작 시 누락·중복 없음), 조회 API, 사용자 스크립트
- **테스트:** 컨트랙트 89개(커버리지 줄 100%), 통합 49개(실제 프로세스를 띄워 확인하는 시스템 테스트 포함)
- **설계 문서:** [docs/design.md](docs/design.md). 이 README는 요약과 이유만 담고, 자세한 내용은 "design.md N번"으로 연결한다.

## 목차

1. [빠른 시작](#1-빠른-시작)
2. [설계 방식과 이유](#2-설계-방식과-이유)
3. [구성 요소와 연동](#3-구성-요소와-연동)
4. [테스트](#4-테스트)
5. [장애 발생 시 복구](#5-장애-발생-시-복구)
6. [보안](#6-보안)
7. [개발 과정](#7-개발-과정)

## 1. 빠른 시작

**필요한 것:** Node.js 20.12 이상, Docker Desktop. Windows·macOS·Linux 모두 같은 명령으로 동작한다.

```bash
# 0. 설치 (처음 한 번)
cp .env.example .env              # Windows PowerShell: Copy-Item .env.example .env
npm install                       # 루트: db, indexer, api, 통합 테스트
cd contracts && npm install && cd ..

# 1. PostgreSQL과 테이블
docker compose up -d
npm run db:init

# 2. [터미널 1] 로컬 블록체인. 트랜잭션이 없어도 5초마다 블록을 만든다
cd contracts && npm run node

# 3. 컨트랙트 배포. 출력의 마지막 두 줄을 .env에 넣는다
cd contracts && npm run deploy
#   CONTRACT_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
#   DEPLOY_BLOCK=2

# 4. [터미널 2] Indexer, [터미널 3] API (루트에서)
npm run indexer
npm run api

# 5. design.md 7번 예시를 한 번에 실행하고 API로 확인
cd contracts && npm run demo
curl http://localhost:3000/auctions/0
```

`demo`는 실행할 때마다 새 NFT와 새 경매를 만들어 판매자(계정 0)와 입찰자 A~D(계정 1~4)로 예시를 끝까지 진행하고, 장부가 7번과 같은지 검사한다.

**스크립트 직접 실행** (`cd contracts && npm run <이름> -- <옵션>`, design.md 12번)

| 명령 | 예시 |
|---|---|
| `deploy` | `npm run deploy` |
| `mint-nft` | `npm run mint-nft` (계정 0에게 테스트 NFT 발행) |
| `create-auction` | `npm run create-auction -- --token 1 --bidding 10m --reveal 1d` |
| `bid` | `npm run bid -- --auction 0 --value 3 --deposit 5 --account 1` |
| `reveal` | `npm run reveal -- --auction 0 --account 1` |
| `finalize` | `npm run finalize -- --auction 0` |
| `withdraw` | `npm run withdraw -- --account 1` |
| `time-travel` | `npm run time-travel -- --auction 0 --to reveal` (`--to end`, `--seconds 1d`) |
| `demo` | `npm run demo` |

금액은 ETH, 기간은 `10m`/`1d` 형식이다. 지갑은 로컬 노드의 기본 계정 번호(`--account`)로 고른다. 입찰하면 입찰가와 secret이 `.bids/`에 저장된다. 이 파일이 있어야 공개할 수 있다.

**API** (모두 GET, design.md 11번)

| 주소 | 내용 |
|---|---|
| `/auctions` | 전체 경매 목록 |
| `/auctions?status=active` | 진행 중 (입찰 중·공개 중·종료 대기) |
| `/auctions?status=finalized` | 종료된 경매 |
| `/auctions/:auctionId` | 상세, 진행 상태, 결과, 입찰 목록 |
| `/users/:address/auctions` | 그 주소가 참여한 경매와 그 사람의 입찰 |

금액은 wei 문자열, 주소는 소문자, 시간은 unix 초다. 모든 응답의 `asOf`는 진행 상태를 계산한 기준 블록이다.

**환경 변수** (`.env`, 비밀값이 있어 Git에 올리지 않는다)

| 이름 | 쓰는 곳 | 설명 |
|---|---|---|
| `POSTGRES_*`, `DATABASE_URL` | Docker, 전체 | DB 접속 정보 |
| `RPC_URL`, `CHAIN_ID` | Indexer | 노드 주소, chain id(Hardhat 31337) |
| `CONTRACT_ADDRESS`, `DEPLOY_BLOCK` | Indexer | `deploy`가 출력하는 값 |
| `BATCH_SIZE`, `POLL_INTERVAL_MS`, `RETRY_DELAY_MS` | Indexer | 한 번에 읽을 블록 수, 새 블록 확인 주기, 오류 후 재시도 대기 |
| `API_PORT` | API | 기본 3000 |
