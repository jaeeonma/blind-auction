# Blind Auction

NFT를 ETH로 비공개 입찰하는 경매(Commit-Reveal). 입찰가는 해시로 숨겨 내고, 입찰 기간이 끝나면 각자 공개한다. NFT와 ETH의 교환은 스마트 컨트랙트가 보장하고, Indexer가 이벤트를 PostgreSQL에 모으며, REST API가 조회를 제공한다.

- **동작하는 것:** 경매 생성 → 입찰 → 공개 → 낙찰·정산 → 출금 전체, 이벤트 수집(중단 후 재시작 시 누락·중복 없음), 조회 API, 사용자 스크립트, 시연용 조회 화면
- **테스트:** 컨트랙트 92개(커버리지 줄 100%), 통합 71개(실제 프로세스를 띄워 확인하는 시스템 테스트 포함)
- **설계 문서:** [docs/design.md](docs/design.md). 이 README는 요약과 이유만 담고, 자세한 내용은 "design.md N번"으로 연결한다.

## 목차

1. [빠른 시작](#1-빠른-시작)
- [Outline 요구사항 대응](#outline-요구사항-대응)
2. [설계 방식과 이유](#2-설계-방식과-이유)
3. [구성 요소와 연동](#3-구성-요소와-연동)
4. [테스트](#4-테스트)
5. [장애 발생 시 복구](#5-장애-발생-시-복구)
6. [보안](#6-보안)
7. [개발 과정](#7-개발-과정)

## 1. 빠른 시작

**필요한 것:** Node.js 22.12 이상(Vitest 5 요구 사항, 개발은 24에서 확인), Docker Desktop. Windows·macOS·Linux에서 동작한다 (Windows PowerShell은 아래 안내 참고).

```bash
# 0. 설치 (처음 한 번)
git clone https://github.com/jaeeonma/blind-auction.git
cd blind-auction
cp .env.example .env              # Windows PowerShell: Copy-Item .env.example .env
npm install                       # 루트: db, indexer, api, 통합 테스트
cd contracts && npm install && cd ..

# 1. PostgreSQL과 테이블
docker compose up -d
npm run db:init

# 2. [터미널 1] 로컬 블록체인. 트랜잭션이 없어도 5초마다 블록을 만든다
cd contracts && npm run node

# 3. 컨트랙트 배포(처음이면 컴파일도 한다). 출력의 마지막 두 줄을 .env에 넣는다
cd contracts && npm run deploy
#   예) CONTRACT_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
#       DEPLOY_BLOCK=13            (노드를 켠 뒤 지난 시간에 따라 달라진다)

# 4. [터미널 2] Indexer, [터미널 3] API (루트에서)
npm run indexer
npm run api

# 5. design.md 7번 예시를 한 번에 실행하고 API로 확인
cd contracts && npm run demo
curl http://localhost:3000/auctions/0    # Windows PowerShell: curl.exe

# 6. 조회 화면: 브라우저로 http://localhost:3000/ 을 연다 (3초마다 새로고침)
```

**Windows PowerShell 5.1에서 실행할 때**
- `npm.ps1 파일을 로드할 수 없습니다`(실행 정책 오류)가 나오면 `npm` 대신 `npm.cmd`로 실행한다. 예: `npm.cmd run demo`
- `&&`를 쓸 수 없으므로 `cd contracts && npm run node`는 `cd contracts`와 `npm.cmd run node`처럼 한 줄씩 나눠 입력한다.
- 명령 프롬프트(cmd)에서는 `npm`과 `&&`를 그대로 쓸 수 있다.

`demo`는 실행할 때마다 새 NFT와 새 경매를 만들어 판매자(계정 0)와 입찰자 A~D(계정 1~4)로 예시를 끝까지 진행하고, 장부가 7번과 같은지 검사한다.

**두 번째 실행부터:** 노드를 다시 켜면 체인이 처음부터 시작한다. `deploy` 후 `.env`를 고치고 `npm run indexer:reset`을 한 다음 Indexer를 켠다 (Indexer가 켜져 있으면 먼저 끈다, 5절 참고).

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

## Outline 요구사항 대응

과제 Outline의 요구사항마다 구현 위치와 확인하는 테스트를 한 줄로 정리했다. 이유와 자세한 내용은 design.md 번호를 따라가면 된다. 테스트 파일은 `contracts/test/`(단위)와 `tests/integration/`(통합)에 있다.

**기능 요구사항**

| Outline | 구현 | 확인하는 테스트 | design.md |
|---|---|---|---|
| 1. 경매 생성 (대상·기간·상태, 입찰 / 입찰 확인 / 종료 단계 구분) | `createAuction`(NFT를 컨트랙트가 보관), `phaseOf`(입찰 중 → 공개 중 → 종료 대기 → 종료). **"입찰 확인 단계"가 이 프로젝트의 공개(reveal) 단계** | `createAuction.test.ts` | 4, 5번 |
| 2. 비공개 입찰 (체인을 봐도 입찰가를 알 수 없음) | `bid`: 해시(입찰가 + secret + 주소)와 보증금만 기록 | `bid.test.ts`, `reveal.test.ts`(해시 복사 공격) | 4번 Q3·Q11 |
| 3. 입찰 확인 = 공개(reveal) (제출 정보가 해시와 일치하는지 검증, 무효 입찰 제외) | `reveal`: `msg.sender`로 해시를 다시 계산해 비교. 보증금 < 입찰가면 무효 | `reveal.test.ts` | 5, 7번 |
| 4. 낙찰 및 정산 (낙찰자 결정, 낙찰 금액, 낙찰 안 된 참여자 자산, 결과 기록, 유효 입찰 없음) | 공개 때 장부 기록(`reveal`), `finalize`(낙찰자·몰수금, `AuctionFinalized` 이벤트), `withdraw` | `finalize.test.ts`, `withdraw.test.ts`, `flow.test.ts` | 7번, Q7 |
| 5. 경매 조회 (전체·진행 중·종료, 상세·상태·결과, 사용자가 참여한 경매) | `api/`: `GET /auctions`, `/auctions/:auctionId`, `/users/:address/auctions` | `api.test.ts`, `system.test.ts` 1 | 11번 |

**Blockchain Indexer**

| Outline | 구현 | 확인하는 테스트 | design.md |
|---|---|---|---|
| Event 수집 | `indexer/indexer.ts`: 블록 범위로 `eth_getLogs` | `indexer.test.ts` | 6, 9번 |
| PostgreSQL 저장 | `indexer/store.ts`, `db/schema.sql` | `schema.test.ts`, `indexer.test.ts` | 10번 |
| 신규 Event 지속 수집 | `indexer/run.ts`: 따라잡은 뒤 주기적으로 새 블록 확인 | `system.test.ts` 1 (시간을 옮기며 상태 반영) | 9번 |
| 중단 이후 데이터 복구 | 책갈피(`indexer_state`)를 이벤트와 한 DB 트랜잭션으로 저장, 다음 블록부터 이어 읽음 | `system.test.ts` 2-a·2-b | 9번 |
| 중복 처리 방지 | PRIMARY KEY + `ON CONFLICT DO NOTHING`, 조건부 UPDATE | `system.test.ts` 3, `indexer.test.ts` | 9번 |

**Client / Script, 데이터 설계**

| Outline | 구현 | 확인하는 테스트 | design.md |
|---|---|---|---|
| 주요 기능을 실행·검증하는 Script | `contracts/tasks/`, `contracts/scripts/lib/`: deploy ~ withdraw, time-travel, demo | `contracts/test/scripts/`, `system.test.ts` | 12번 |
| Blockchain에 기록되는 데이터 | 경매 정보, 해시, 보증금, 장부, 결과 (컨트랙트 상태와 이벤트) | `bid.test.ts`, `finalize.test.ts` | 8번 |
| Database에 저장되는 데이터 | 이벤트를 옮긴 조회용 사본: auctions, bids, indexer_state. 블록체인이 기준 | `schema.test.ts`, `indexer.test.ts` | 8, 10번 |
| 사용자에게 공개되는 데이터 | 체인 데이터 전부와 API 응답. 입찰가는 공개 후에만 | `api.test.ts` (공개 전 입찰가 `null`) | 8번 |
| 입찰 중 공개되면 안 되는 데이터 | 입찰가와 secret: 입찰자 컴퓨터의 `.bids/`에만 저장, 체인·DB·Git에는 없음 | `contracts/test/scripts/bid.test.ts` | 8번 |

**비기능 요구사항**

| Outline | 구현 | 확인하는 테스트 | design.md |
|---|---|---|---|
| 안정성 (노드·Indexer 오류 후 다시 실행하면 누락 없이 수집) | 책갈피, 실패한 범위 재시도(`RETRY_DELAY_MS`) | `system.test.ts` 2-a·2-b, `indexer.test.ts`(노드 끊김·DB 오류) | 9번 |
| 데이터 정합성 (불일치 시 동기화) | 블록체인 기준. `npm run indexer:reset`으로 사본을 다시 만듦 | `system.test.ts` 1, 3-b | 3, 9번 |
| 보안 (권한, 잘못된 상태, 중복 실행, 자산 전송, 취약점) | 6절 표: 단계 검사, 1회 표시, Pull 출금, CEI + `nonReentrant` | 각 함수 테스트의 실패 경우, `withdraw.test.ts`(재진입 공격) | 13번 |

**테스트 요구사항**

| Outline | 확인하는 테스트 |
|---|---|
| Unit: 경매 생성 | `createAuction.test.ts` |
| Unit: 입찰 | `bid.test.ts` |
| Unit: 입찰 확인(공개) | `reveal.test.ts` |
| Unit: 낙찰자 결정 | `reveal.test.ts`(최고가·동점), `finalize.test.ts` |
| Unit: 경매 종료 | `finalize.test.ts` |
| Unit: 자산 정산 | `withdraw.test.ts`, `flow.test.ts`(7번 예시) |
| Unit: 비정상 Transaction | 각 파일의 실패해야 하는 경우 (design.md 14번 목록) |
| Integration: Event 후 DB 반영 | `indexer.test.ts`, `system.test.ts` 1 |
| Integration: Indexer 중단 후 재실행 | `system.test.ts` 2-a·2-b |
| Integration: 중복 처리 방지 | `system.test.ts` 3, `indexer.test.ts` |
| Integration: API로 조회 | `api.test.ts`, `system.test.ts` 1 |

## 2. 설계 방식과 이유

### 경매 규칙 (design.md 4번)

| 규칙 | 이유 |
|---|---|
| 경매 대상은 ERC-721 NFT. 생성 때 컨트랙트가 보관한다 | 블록체인 밖 물건은 전달을 보장할 수 없다. NFT는 컨트랙트가 직접 넘길 수 있다 |
| 기간은 판매자가 정한다: 입찰 10분~5일, 공개 1~2일 | 공개는 입찰자 모두가 직접 해야 하므로 여유 있게 둔다 |
| 해시 = 입찰가 + secret + 입찰자 주소 | 남의 해시를 복사해 입찰해도 주소가 달라 공개할 수 없다 |
| 보증금 ≥ 입찰가여야 유효. 무효면 보증금 전액 반환 | 입찰가를 숨기면서 낙찰자가 낼 돈을 미리 확보한다. 무효는 규칙 위반이 아니라 조건 미달이라 돌려준다 |
| 공개하지 않으면 보증금 몰수(판매자에게) | 남의 공개를 보고 불리하면 빠지는 행동을 막는다 |
| 최고가 낙찰. 동점이면 **먼저 입찰한** 사람 | 결과가 하나로 정해져야 한다. 먼저 입찰한 사람이 나중에 공개할 수 있으므로, 공개 순서가 아니라 저장해 둔 입찰 순서로 비교한다 |
| 지갑당 한 경매에 1회 입찰. 판매자 입찰은 막지 않는다 | 구조가 단순해진다. 판매자는 다른 지갑으로 우회할 수 있어 막아도 의미가 없다 |
| 종료는 공개 마감 후 누구나 1회 | 판매자만 할 수 있으면 결과가 싫은 판매자가 호출하지 않아 보증금이 묶인다 |

최저가, 경매 취소, 여러 번 입찰, 가짜 입찰은 일부러 넣지 않았다 (design.md 16번).

### 핵심 결정

**반환은 종료 때가 아니라 공개 때 장부에 적는다 (design.md 7번).** 종료 때 한꺼번에 돌려주려면 입찰자 전체를 반복문으로 돌아야 하고, 입찰자가 많으면 트랜잭션 가스 상한에 걸려 종료가 실행되지 않는다. 공개는 한 명씩 들어오므로 그때 결과를 적으면 반복문이 없다.

| 공개 결과 | 공개 때 장부에 적는 것 |
|---|---|
| 무효, 또는 유효하지만 현재 최고가에 짐 | 본인 보증금 전액 |
| 새 최고가 | 밀려난 이전 최고가의 보증금 전액 (본인 차액은 종료 때) |

종료 때는 두 줄만 적는다: 낙찰자에게 보증금 − 낙찰가, 판매자에게 낙찰가 + 몰수금. 몰수금은 `보증금 합계 − 공개된 보증금 합계`라서 역시 반복문이 없다.

**예시** (design.md 7번. 공개 순서 A → B → C, D는 공개하지 않음)

| 입찰자 | 보증금 | 입찰가 | 결과 | 장부 |
|---|---|---|---|---|
| A | 5 | 3 | B에게 밀림 | 5 |
| B | 4 | 4 | 낙찰 | 0 |
| C | 2 | 3 | 무효 | 2 |
| D | 3 | 미공개 | 몰수 | - |
| 판매자 | | | | 4 + 3 = 7 |

장부 합계 14 = 보증금 합계 14. 컨트랙트에 남거나 모자라는 돈이 없다. `npm run demo`와 테스트가 이 숫자를 그대로 검사한다.

**돈은 직접 보내지 않고 장부에 적어 각자 출금한다 (Pull).** 컨트랙트가 여러 명에게 송금하면, 받기를 거부하는 한 명 때문에 모두의 정산이 막힌다.

**쓰기는 지갑에서 컨트랙트로, 읽기는 DB로 (design.md 3번).** API가 대신 트랜잭션을 보내면 서버가 돈과 개인키를 쥐어야 하고 `msg.sender`가 서버가 된다. 블록체인에는 검색 기능이 없고 과거 기록은 이벤트로만 남으므로, Indexer가 이벤트를 DB에 모으고 API는 DB만 조회한다. 둘이 다르면 블록체인이 맞고, DB는 다시 읽어 맞춘다.

**진행 상태는 저장하지 않고 블록 시간으로 계산한다 (design.md 10번).** 저장하면 시간이 지나도 값이 안 바뀐다. 서버 시계가 아니라 Indexer가 마지막으로 읽은 블록의 시간을 써서 컨트랙트와 같은 기준으로 판단한다. 트랜잭션이 없으면 블록 시간이 멈추므로 개발용 노드는 5초마다 빈 블록을 만든다.

**secret은 입찰자 컴퓨터에만 둔다 (design.md 8번).** 서버나 DB에 두면 관리자, 해킹, API 버그 중 하나만으로 공개 전에 입찰가가 드러난다. 입찰 스크립트는 secret 파일을 **트랜잭션을 보내기 전에** 저장한다. 보낸 뒤에 저장하면, 성공 직후 프로그램이 죽었을 때 secret을 잃어 공개할 수 없고 보증금이 몰수된다.

## 3. 구성 요소와 연동

```mermaid
flowchart LR
  subgraph user["사용자 컴퓨터"]
    S["사용자 스크립트<br/>(Hardhat task, 지갑)"]
    F[".bids/<br/>입찰가·secret 파일"]
  end
  C["BlindAuction 컨트랙트<br/>(Hardhat 노드)"]
  I["Indexer<br/>별도 프로세스"]
  D[("PostgreSQL<br/>조회용 사본")]
  A["API<br/>별도 프로세스"]

  S -- "1. 저장" --> F
  S -- "2. 트랜잭션" --> C
  C -- "3. 이벤트 (eth_getLogs)" --> I
  I -- "4. 이벤트 + 책갈피<br/>한 DB 트랜잭션" --> D
  A -- "5. 조회 (읽기 전용)" --> D
  S -. "6. GET /auctions/..." .-> A
  W["웹 화면 (브라우저, 시연용)"] -. "7. 화면 조회 (3초마다)" .-> A
```

| 구성 요소 | 하는 일 | 위치 |
|---|---|---|
| 스마트 컨트랙트 | 경매 규칙 실행, NFT·ETH 보관, 결과를 이벤트로 남김 (원본) | `contracts/contracts/BlindAuction.sol` |
| 사용자 스크립트 | 생성·입찰·공개·종료·출금 트랜잭션을 지갑에서 직접 보냄 | `contracts/tasks/`, `contracts/scripts/lib/` |
| Indexer | 이벤트를 블록 범위로 읽어 DB에 저장. 책갈피로 이어 읽음 | `indexer/` |
| PostgreSQL | 검색하기 쉽게 모은 사본. 테이블 정의는 한 곳 | `db/schema.sql` |
| API | DB를 조회해 돌려줌. 쓰기 없음. 시연용 화면 파일도 제공 | `api/` |
| 웹 화면 (시연용) | 경매 목록·상세·사용자별 참여 경매를 보여 줌. API를 3초마다 불러오고, Indexer가 멈추면 표시 (design.md 17번) | `web/` |

**Indexer와 API를 따로 실행하는 이유:** Indexer가 멈추거나 재시작해도 API는 계속 조회에 답한다. `asOf`를 보면 데이터가 어느 블록 기준인지 알 수 있다.

**이벤트 → DB (design.md 6번, 10번):** Indexer는 이벤트 하나만 보고 DB를 채운다.

| 이벤트 | DB |
|---|---|
| `AuctionCreated` | auctions 행 생성 |
| `BidCommitted` | bids 행 생성 (결과 `unrevealed`) |
| `BidRevealed` | 입찰가, 결과 `valid` / `invalid` |
| `AuctionFinalized` | 낙찰자·낙찰가·몰수금, 유효 입찰은 `won` / `lost` |
| `Withdrawn` | 저장하지 않음 (조회에 쓰는 곳이 없음) |

금액은 `NUMERIC(78,0)`(wei, uint256 최댓값까지 정확), 주소는 소문자, 시간은 unix 초로 저장한다. 사용자 테이블은 없다. 보증금·입찰가·결과는 "그 사람이 그 경매에 한 입찰"에 붙는 정보라서다.

**폴더**

```
contracts/   컨트랙트, 컨트랙트 테스트, 사용자 스크립트(tasks/, scripts/lib/)
indexer/     이벤트 수집 → DB, 복구 명령(reset.ts)
api/         조회 API (Express), 화면 파일 제공
web/         시연용 웹 화면 (HTML·CSS·JS, 빌드 없음)
db/          테이블 생성 SQL, db:init
tests/       통합 테스트 (Vitest + Supertest)
docs/        설계 문서
```

## 4. 테스트

```bash
cd contracts && npx hardhat test       # 컨트랙트·스크립트 92개 (몇 초)
cd contracts && npm run coverage       # 커버리지
npm test                               # 통합 71개 (루트, 약 2분)
```

통합 테스트는 PostgreSQL이 떠 있어야 한다(`docker compose up -d`). Hardhat 노드는 테스트가 직접 8546 포트에 띄웠다가 끄므로 개발용 노드(8545)와 겹치지 않는다. 테스트마다 임시 스키마나 임시 데이터베이스를 만들어 쓰고 지워서 개발 데이터는 건드리지 않는다.

| 범위 | 개수 | 확인하는 것 |
|---|---|---|
| 컨트랙트 함수 | 54 | 생성·입찰·공개·종료·출금의 규칙, 실패해야 하는 경우, 재진입 공격, 7번 예시 전체 흐름 |
| 사용자 스크립트 | 38 | secret 파일을 전송 전에 저장하는지, 보내기 전 확인, 손상된 파일, demo 반복 실행, 배포 기록의 주소 확인 |
| DB 스키마 | 11 | 중복 방지, uint256 정확도, 주소·결과 칼럼 검사 |
| Indexer | 13 | DB = 컨트랙트, 재시작, 같은 이벤트 두 번, DB·노드 오류 시 롤백, 시작 확인(설정 오류·노드 재시작) |
| API | 31 | 상태 경계값(마감 −1초, 마감 정각), 필터, 오류 코드, 화면 파일 제공(쓰기 거부, web/ 밖 접근 거부) |
| 시스템 | 6 | 모든 구성 요소를 **실제 프로세스**로 띄워 확인 (아래). 6번째는 틀린 DEPLOY_BLOCK이면 Indexer가 스스로 멈추는지 |
| 웹 화면 | 10 | 상태 이름, 남은 시간, 금액 표시, Indexer 멈춤 판단, 화면 경로. API 값을 HTML로 넣는 코드(innerHTML 등)가 없는지 |

**시스템 테스트** (design.md 14번 통합 테스트). 스크립트로 트랜잭션을 보내고, Indexer·API 프로세스를 띄우거나 강제 종료하며 확인한다.

| 14번 항목 | 테스트 |
|---|---|
| 전체 흐름 후 API 결과가 컨트랙트 상태와 같은지 | `demo` 실행 후 API 응답을 `getAuction`·`phaseOf`·`getBid`와 항목별로 비교. 시간을 옮기며 진행 상태도 비교 |
| Indexer를 끈 동안 입찰이 들어와도 다시 켜면 빠짐없이 들어오는지 | 강제 종료한 사이에 들어온 입찰 3개가 재시작 후 모두 한 번씩 저장됨. 48개 블록을 따라잡는 도중 8번 강제 종료해도 결과가 같음 |
| 같은 이벤트를 두 번 읽어도 한 번만 저장되는지 | 책갈피만 되돌려 다시 읽어도 DB 전체가 이전과 완전히 같음 |

design.md 14번의 컨트랙트 단위 테스트 항목도 모두 테스트가 있다 (`contracts/test/`).

테스트가 실제로 버그를 잡는지도 확인했다. 예를 들어 API의 상태 계산에서 `<`를 `<=`로 일부러 바꾸면 시스템 테스트가 실패한다.

**커버리지** (`npm run coverage`)

| 파일 | 문장 | 분기 | 함수 | 줄 |
|---|---|---|---|---|
| BlindAuction.sol | 100% | 97.92% | 100% | 100% |
| MockNFT.sol | 100% | 100% | 100% | 100% |

BlindAuction에서 빠진 분기 하나는 `finalize`의 재진입 잠금(`nonReentrant`)이 실제로 막는 경우다. design.md 14번이 요구하는 재진입 테스트는 `withdraw`에 있고, `finalize`는 상태를 먼저 바꾸는 순서(CEI)와 잠금으로 막아 두었다.

## 5. 장애 발생 시 복구

복구의 바탕은 두 가지다 (design.md 9번).
- Indexer는 **이벤트 저장과 책갈피(마지막 처리 블록) 갱신을 한 DB 트랜잭션**으로 묶는다. 어느 순간에 죽어도 반쯤 저장된 상태가 남지 않고, 다시 켜면 책갈피 다음 블록부터 이어 읽는다.
- 저장은 다시 해도 결과가 같다(UNIQUE 키와 조건부 UPDATE). 같은 블록을 두 번 읽어도 안전하다.

| 상황 | 자동으로 되는 것 | 사람이 할 일 | 확인한 테스트 |
|---|---|---|---|
| Indexer가 꺼지거나 강제 종료됨 | 다시 켜면 책갈피 다음 블록부터 빠진 이벤트를 채운다 | `npm run indexer` | 시스템 2-a, 2-b |
| DB 연결이 끊김 | 그 묶음이 롤백되고 책갈피도 그대로. `RETRY_DELAY_MS` 뒤 같은 범위를 다시 처리한다 | DB를 다시 띄운다 | Indexer (DB 오류) |
| 노드 연결이 끊김 | DB에 아무것도 쓰지 않고 재시도를 반복한다 | 노드를 다시 띄운다 | Indexer (노드 끊김) |
| API가 꺼짐 | Indexer와 무관하다 | `npm run api` | - |
| DB가 블록체인과 다르다고 의심됨 | - | Indexer를 멈추고 `npm run indexer:reset` → Indexer 다시 실행. 책갈피와 테이블을 비우고 배포 블록부터 다시 만든다 | 시스템 3-b |
| 로컬 노드를 다시 켬 (체인이 처음부터 시작) | 아래 절차를 빠뜨리면 Indexer가 시작할 때 감지하고 할 일을 알려 준 뒤 멈춘다. 스크립트도 배포 기록의 주소에 컨트랙트가 없으면 `deploy`를 먼저 하라고 안내한다 | Indexer를 멈추고 `npm run deploy` → `.env` 갱신 → `npm run indexer:reset` → Indexer 다시 실행 | Indexer (시작 확인), 스크립트 (배포 주소 확인) |
| `CONTRACT_ADDRESS`·`DEPLOY_BLOCK`이 틀림 | Indexer가 시작할 때 멈추고 원인과 할 일을 알려 준다. `DEPLOY_BLOCK`이 늦으면 실제 배포 블록도 알려 준다 | 알려 준 대로 `.env`를 고치고, 저장된 데이터가 있으면 `npm run indexer:reset` 후 다시 실행 | Indexer (시작 확인), 시스템 4 |

**복구 명령이 책갈피만이 아니라 테이블까지 비우는 이유:** 책갈피만 되돌리면 빠진 행은 채워지지만, 이미 있는데 값이 틀린 행은 UNIQUE 때문에 건너뛰어 그대로 남는다. 시스템 테스트 3-b가 이것을 보여 준다.

**멈춤을 알아채는 방법:** API 응답의 `asOf.blockNumber`가 체인의 최신 블록보다 계속 뒤처져 있으면 Indexer가 멈춘 것이다. 개발용 노드는 5초마다 블록을 만들므로 정상이면 `asOf`가 계속 앞으로 간다. Indexer는 시작할 때 노드 재시작과 설정 오류를 확인한다 (design.md 9번). 다만 노드를 다시 켠 뒤 새 체인의 블록 수가 예전 책갈피를 넘은 상태에서 켜면 감지하지 못한다. 블록 해시를 저장해 비교하면 막을 수 있지만 만들지 않았다 (design.md 16번).

## 6. 보안

| 위험 (design.md 13번) | 대책 | 확인 |
|---|---|---|
| 권한 없는 사용자 | 공개는 `msg.sender`로 해시를 다시 계산해서 본인만 가능. 출금은 자기 장부만. 경매 생성은 NFT 주인만(아니면 NFT 이전이 실패) | 남의 입찰 공개, 해시 복사 공격, 주인 아닌 생성 |
| 잘못된 상태 | 모든 함수가 블록 시간으로 단계를 검사하고 아니면 revert | 기간 경계값(마감 −1초, 정각) |
| 중복 실행 | 입찰은 지갑당 1회, 공개는 "공개했음", 종료는 "종료 여부" 표시. 두 번째는 실패 | 두 번째 입찰·공개·종료·출금 |
| 자산 전송 | 직접 보내지 않고 장부에 적어 각자 출금(Pull). 한 명이 받기를 거부해도 다른 사람은 영향 없음 | 받기 거부 컨트랙트 |
| 재진입 | 장부를 먼저 0으로 만든 뒤 송금(CEI) + `nonReentrant`. NFT 전송도 상태 기록 뒤에 한다 | 재진입 공격 컨트랙트(`ReentrantBidder`) |

- **입찰가 비밀 유지:** 체인에는 해시만 올라간다. secret은 입찰자 컴퓨터의 `.bids/`에만 저장되고 서버·DB·Git에는 없다(`.gitignore`). 스크립트는 secret을 화면에 출력하지 않는다.
- **비밀값:** 개인키와 DB 비밀번호는 `.env`에만 두고 `.env.example`만 커밋한다.
- **컨트랙트 코드:** NFT 표준과 재진입 잠금은 직접 만들지 않고 OpenZeppelin 5를 쓴다. 에러는 custom error로 구분한다.

**알려진 한계** (design.md 16번)
- 보증금이 입찰가 이상이어야 하므로, 보증금을 보면 입찰가의 상한이 드러난다. 대응: 보증금을 입찰가보다 넉넉히 내면 상한만 드러나고 실제 금액은 알 수 없다. 남는 보증금은 공개·종료 때 장부에 적혀 그대로 돌려받는다.
- 경매 대상 NFT는 정상 동작하는 ERC-721이라고 가정한다. 전송을 막는 NFT면 종료가 실패해 보증금이 묶일 수 있다.
- 블록 생성자는 블록 시간을 몇 초 조정할 수 있다. 입찰 기간이 최소 10분이라 영향이 작다.
- 로컬 Hardhat 네트워크 기준이라 블록 재구성(reorg)은 다루지 않는다.
- `contracts/`에서 `npm audit`을 실행하면 Hardhat 도구 묶음(hardhat-toolbox)의 개발 의존성에서 경고가 나온다. 컴파일·테스트에만 쓰는 도구이고 배포되는 컨트랙트에는 포함되지 않는다. 컨트랙트가 쓰는 OpenZeppelin(`npm audit --omit=dev`)과 루트 패키지는 경고가 없다.

## 7. 개발 과정

**단계별 진행** (design.md 15번). 단계마다 브랜치를 만들고 PR로 `main`에 합쳤다. `main`은 항상 테스트가 통과하는 상태다.

| 단계 | 브랜치 | PR | 결과 |
|---|---|---|---|
| 0. 프로젝트 세팅 | `chore/setup` | [#2](https://github.com/jaeeonma/blind-auction/pull/2) | 폴더 구조, Hardhat, Docker Compose(PostgreSQL) |
| 1. 설계 | - | (#4에 포함) | 설계 문서 v2 확정 |
| 2. 스마트 컨트랙트 | `feat/contract` | [#4](https://github.com/jaeeonma/blind-auction/pull/4) | v1 코드를 v2로 수정, finalize·withdraw, 단위 테스트 |
| 3. Indexer | `feat/indexer` | [#5](https://github.com/jaeeonma/blind-auction/pull/5) | 이벤트 항목 확정, DB 테이블, Indexer |
| 4. API | `feat/api` | [#6](https://github.com/jaeeonma/blind-auction/pull/6) | 조회 API, 개발용 노드 블록 생성 |
| 5. 스크립트, 통합 테스트 | `feat/scripts`, `test/integration` | [#7](https://github.com/jaeeonma/blind-auction/pull/7), [#8](https://github.com/jaeeonma/blind-auction/pull/8) | 사용자 스크립트·demo, 시스템 테스트, 복구 명령 |
| 6. README | `docs/readme` | [#9](https://github.com/jaeeonma/blind-auction/pull/9) | 이 문서, 빠른 시작 검증 |
| 이후 보완 | `docs/sync-design` | [#10](https://github.com/jaeeonma/blind-auction/pull/10) | design.md 폴더 구조와 노드 재시작 절차, npm audit 한계 |
| | `docs/readme-windows` | [#11](https://github.com/jaeeonma/blind-auction/pull/11) | Windows PowerShell 안내, 두 번째 실행 절차 |
| | `docs/readme-clone` | [#12](https://github.com/jaeeonma/blind-auction/pull/12) | 빠른 시작에 저장소 받는 명령 |
| | `feat/scripts-ko` | [#13](https://github.com/jaeeonma/blind-auction/pull/13) | 스크립트·demo 출력 한국어화 |
| | `docs/final-check` | [#14](https://github.com/jaeeonma/blind-auction/pull/14) | Outline 요구사항 대응 표, 문서 보완 |
| | `feat/startup-checks` | [#15](https://github.com/jaeeonma/blind-auction/pull/15) | 노드 재시작·설정 오류 안내 (스크립트 배포 주소 확인, Indexer 시작 확인) |
| | `feat/web-view` | (PR 후 기재) | 시연용 조회 화면 (design.md 17번 A) |

**작업 규칙**
- 커밋은 기능 하나가 테스트를 통과할 때마다 작게 나눈다. 메시지는 Conventional Commits + 한국어(`feat(contract): 입찰 기능 추가`). 6단계 전까지 `main`에 커밋 48개.
- PR 본문에는 변경 내용, 테스트 결과, 설계와 달라진 점을 적는다.
- 설계와 다르게 해야 할 이유가 생기면 코드보다 먼저 이유와 변경안을 내고, 승인을 받은 뒤 design.md를 함께 고친다.
- 커밋 전 `.env`, `.bids/`, `node_modules/`, 배포 기록이 포함되지 않았는지 확인한다.

**설계 변경 이력**
- **v1 → v2 (1단계):** 최저가, 경매 취소, 여러 번 입찰, 가짜 입찰을 빼고 규칙을 단순하게 했다. 반환 시점을 공개 때로 옮겼다.
- **개발 중 승인을 받아 정하거나 바꾼 것** (design.md에 반영한 것은 번호로 표시)

| 내용 | design.md |
|---|---|
| 입찰가 0·보증금 0 허용 (v2를 글자 그대로 해석) | 16번 |
| 이벤트 항목 확정 | 6번 |
| 패키지 구성과 `db:init` | 3번 |
| 결과 코드는 영어, 시간은 unix 초로 저장 | 10번 |
| `CHAIN_ID`, `RETRY_DELAY_MS` 설정 | 9번 |
| 개발용 노드에서 5초마다 블록 생성 | 3번, 10번 |
| API 주소, 종료 대기는 "진행 중"에 포함 | 11번 |
| `deploy`·`demo` 스크립트, secret 파일을 전송 전에 저장 | 12번 |
| 복구 명령이 테이블까지 비우도록 변경 | 9번 |
| 스크립트 출력 한국어화 (안내·오류 문장과 task 설명. 상태 코드·값·오류 이름은 그대로) | - (출력 문장만 변경) |

**개발 중 찾아서 고친 문제**
- 실제 노드(HTTP)는 revert 오류를 테스트 네트워크와 다른 모양으로 돌려줘서, 스크립트가 "입찰 없음"을 알아보지 못하고 모든 첫 입찰이 실패했다. 개발 노드에서 직접 실행하다 발견했고, 두 모양을 모두 읽게 고친 뒤 그 모양을 테스트에 넣었다.
- ethers가 노드가 꺼져 있을 때 네트워크를 알아내려는 재시도를 끝없이 반복했다. chain id를 미리 주는 설정(`CHAIN_ID`)으로 해결했다.
- 설계 9번의 복구 방법(책갈피만 되돌림)으로는 잘못 저장된 행이 고쳐지지 않는다는 것을 테스트로 확인하고 복구 범위를 바꿨다.
- 이 README의 빠른 시작을 새 폴더에 clone해 그대로 따라 하다가, 처음 받은 저장소에서는 컴파일 전이라 `deploy`가 실패하는 것을 발견했다. `deploy`가 먼저 컴파일하도록 고쳤다.

**AI 도구 사용:** 이 프로젝트는 Claude Code(Anthropic)를 사용해 개발했다. 경매 규칙과 설계 v2는 개발자가 정했고, AI는 단계마다 계획을 제시해 승인을 받은 뒤 구현·테스트하고 결과를 보고했다. 설계와 다른 판단이 필요할 때는 먼저 질문했다. AI가 함께 쓴 커밋에는 `Co-Authored-By: Claude` 표시가 남아 있다.
