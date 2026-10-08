# Blind Auction

EVM 기반 Blind Auction(Commit-Reveal) 시스템. 스마트 컨트랙트 + Blockchain Indexer + PostgreSQL + REST API.
인턴 과제이며, 평가 핵심은 **입찰·공개·낙찰·정산 로직의 설계와 그 이유**다.

## 기준 문서

- **`docs/design.md`(설계 문서 v2, 2026-10-07)가 모든 구현의 기준이다.** 작업 전에 해당 번호를 먼저 읽는다.
- 설계 v2는 개발자가 직접 정한 규칙이다. **설계에 없는 기능이나 규칙을 임의로 추가하지 않는다.** (가짜 입찰, 여러 번 입찰, 최저가, 경매 취소, reorg 처리 등은 의도적으로 뺐다)
- 설계와 다르게 구현해야 할 이유가 생기면 코드를 먼저 바꾸지 말고, 이유와 변경안을 제시해 승인을 받은 뒤 `docs/design.md`를 함께 수정한다.
- 이전 설계(v1) 기준으로 작성된 코드가 있다. v1과 v2가 다르면 **v2를 따른다.**

## 작업 방식

- **한 번에 한 단계만** 진행한다 (아래 진행 상황 참고). 단계 안에서도 기능 하나를 만들면 테스트까지 통과시키고 멈춰서 보고한다:
  - 무엇을 만들었는지 (파일 목록)
  - 테스트 실행 결과
  - 설계 문서와 다르게 한 부분이 있다면 그 내용과 이유
  - 다음에 할 일
- 개발자는 Node.js/Express 백엔드 경험은 있지만 **Solidity와 블록체인은 처음**이다.
  - Solidity 코드에는 "왜 이렇게 했는지"를 설명하는 주석을 단다 (특히 보안: CEI 순서, nonReentrant, Pull 방식, 단계 검사). 주석에서 설계 문서를 가리킬 때는 "design.md 7번"처럼 번호로 쓴다.
  - 새로운 블록체인 개념이 나오면 보고할 때 짧게 설명한다.
- 대화와 보고는 **한국어**로 한다. 코드 식별자와 주석 중 기술 용어는 영어를 써도 된다.

## 경매 규칙 요약 (design.md 4~7번)

- 경매 대상은 ERC-721 NFT. 생성 시 NFT를 컨트랙트로 옮겨 보관한다 (호출자가 NFT 주인이어야 함, 사전 approve 필요).
- 기간은 판매자가 정한다: **입찰 10분~5일, 공개 1일~2일.** 최저가 없음, 경매 취소 없음.
- 입찰: 해시 + 보증금(ETH). **지갑당 한 경매에 1회.** 판매자 입찰은 막지 않는다. 입찰 순서를 저장한다.
- 해시 = 입찰가 + secret + 입찰자 주소. 공개 시 `msg.sender`로 다시 계산해 비교하고, 다르면 revert.
- 해시가 맞으면: 보증금이 입찰가 이상이면 유효, 아니면 무효(보증금 전액 반환).
- 최고가 낙찰. **동점이면 먼저 입찰한 사람** (공개 순서가 아니라 입찰 순서로 비교).
- **반환은 공개 때 장부에 적는다**: 무효 → 본인 보증금 전액 / 유효지만 짐 → 본인 보증금 전액 / 새 최고가 → 밀려난 이전 최고가 보증금 전액.
- 종료는 공개 마감 후 **누구나** 1회 호출. 낙찰자: NFT + (보증금 − 낙찰가)를 장부에. 판매자: 낙찰가 + 몰수금을 장부에. 몰수금 = 보증금 전체 합계 − 공개된 보증금 합계. 유효 입찰이 없으면 NFT는 판매자에게 돌려주고 몰수금만 판매자 장부에.
- 공개하지 않은 입찰의 보증금은 몰수되어 판매자에게 간다.
- 돈은 장부에 적고 각자 `withdraw`로 출금한다 (Pull).

## Git 규칙 (평가 대상)

GitHub 저장소의 작업 이력 관리 방식도 평가된다. 상세 규칙은 `docs/design.md` 15번.

- `main`에 직접 커밋하지 않는다. 단계마다 브랜치를 만든다: `feat/contract`, `feat/indexer`, `feat/api`, `feat/scripts`, `test/integration`, `docs/readme`
- **기능 하나가 테스트를 통과할 때마다 작게 커밋한다.** 여러 기능을 한 커밋에 몰지 않는다.
- 커밋 메시지는 Conventional Commits + 한국어 설명: `feat(contract): 입찰 기능 추가`
- push와 PR 생성은 단계 종료 보고 시 승인을 받은 뒤 한다. PR 본문: 변경 내용, 테스트 결과, 설계와 달라진 점
- 커밋 전 `.env`, `.bids/`, `node_modules/`가 포함되지 않았는지 확인한다.
- 커밋 메시지의 Co-Authored-By 표시는 그대로 둔다. (AI 도구 사용 허용됨, README에 사용 사실 명시)

## 기술 스택과 규칙 (design.md 2, 3번)

- **Contracts:** Solidity 0.8.28, OpenZeppelin 5, Hardhat 2 (TypeScript), ethers.js v6, Mocha/Chai, hardhat-network-helpers
- **Backend:** TypeScript (strict), Express, node-postgres(`pg`). Indexer(`indexer/`)와 API(`api/`)는 **별도 프로세스**. 테이블 정의는 `db/`의 SQL 파일.
- **Test:** 컨트랙트는 Hardhat 테스트, 통합 테스트(`tests/`)는 Vitest + Supertest
- **실행 환경:** Hardhat 로컬 노드, PostgreSQL은 Docker Compose
- 개발 PC는 **Windows**다. npm 스크립트는 OS에 상관없이 동작하게 작성한다 (셸 전용 문법 대신 Node 스크립트나 cross-env 사용).

코딩 규칙:

- 금액(uint256)은 코드에서 `bigint`, DB는 `NUMERIC(78,0)`, API 응답은 wei **문자열**
- 주소는 DB와 API에서 **소문자**로 통일
- 컨트랙트 에러는 `require` 문자열 대신 custom error
- ETH 지급은 반드시 Pull 방식(장부 적립 → `withdraw`). 컨트랙트 안에서 여러 명에게 직접 송금하지 않는다.
- 입찰자 전체를 순회하는 반복문을 컨트랙트에 넣지 않는다.
- **secret과 입찰가 원문은 서버·DB에 절대 저장하지 않는다.** 스크립트만 로컬 `.bids/`에 저장한다 (`.gitignore` 대상).
- 비밀값(개인키, DB 비밀번호)은 `.env`로 관리하고 `.env.example`만 커밋한다.
- 진행 상태는 DB에 저장하지 않고 블록 시간으로 계산한다 (design.md 10번).

## 진행 상황

현재 단계를 끝내면 체크하고, 다음 단계는 지시를 받은 뒤 시작한다.

- [x] **0단계. 프로젝트 세팅**
- [x] **1단계. 설계** — 설계 문서 v2 확정 (2026-10-07)
- [ ] **2단계. 스마트 컨트랙트 + 단위 테스트** (`feat/contract`) — v1 기준으로 작성된 기존 코드(createAuction, bid, reveal)를 v2에 맞게 수정 → finalize → withdraw → design.md 14번 단위 테스트 전체 통과
- [ ] **3단계. 이벤트 항목 확정 + DB 테이블 + Indexer** (`feat/indexer`) — 이벤트 항목을 design.md 6번에 추가, 중단 후 재시작 시 누락·중복 없음
- [ ] **4단계. Backend API** (`feat/api`) — design.md 11번 조회 전체, API 주소를 design.md에 추가
- [ ] **5단계. 사용자 스크립트 + 통합 테스트** (`feat/scripts`, `test/integration`) — design.md 12번, 14번 통합 테스트
- [ ] **6단계. README** (`docs/readme`) — 실행 방법, 설계 이유, 구성 요소와 연동, 테스트, 장애 복구, 보안, 개발 과정

## 평가 항목 (README와 코드에서 드러나야 함)

결과물 · GitHub 작업 관리 방식 · 구성 요소 설계와 연동 · 테스트 방법 · 장애 발생 시 복구 방식 · 보안 대응 · 설계 방식과 이유(README)
