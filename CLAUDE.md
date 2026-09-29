# Blind Auction

EVM 기반 Blind Auction(Commit-Reveal) 시스템. 스마트 컨트랙트 + Blockchain Indexer + PostgreSQL + REST API.
인턴 과제이며, 평가 핵심은 **입찰·공개·낙찰·정산 로직의 설계와 그 이유**다.

## 기준 문서

- **`docs/design.md`가 모든 구현의 기준이다.** 작업 전에 해당 섹션을 먼저 읽는다.
- 설계와 다르게 구현해야 할 이유가 생기면 코드를 먼저 바꾸지 말고, 이유와 변경안을 제시해 승인을 받은 뒤 `docs/design.md`를 함께 수정한다.
- 설계 문서에 없는 규칙을 임의로 추가하지 않는다. 필요하면 질문한다.

## 작업 방식

- **한 번에 한 단계만** 진행한다 (아래 진행 상황 참고). 단계가 끝나면 멈추고 다음을 보고한다:
  - 무엇을 만들었는지 (파일 목록)
  - 테스트 실행 결과
  - 설계 문서와 다르게 한 부분이 있다면 그 내용과 이유
  - 다음 단계에서 할 일
- 단계 안에서도 기능 하나를 만들면 테스트까지 통과시킨 뒤 다음 기능으로 넘어간다.
- 개발자는 Node.js/Express 백엔드 경험은 있지만 **Solidity와 블록체인은 처음**이다.
  - Solidity 코드에는 "왜 이렇게 했는지"를 설명하는 주석을 단다 (특히 보안 관련: CEI 순서, nonReentrant, Pull 방식, 상태 확인).
  - 새로운 블록체인 개념이 나오면 보고할 때 짧게 설명한다.
- 대화와 보고는 **한국어**로 한다. 코드 식별자와 주석 중 기술 용어는 영어를 써도 된다.

## Git 규칙 (평가 대상)

GitHub 저장소의 작업 이력 관리 방식도 평가된다. 상세 규칙은 `docs/design.md` 1.6.

- `main`에 직접 커밋하지 않는다. 단계마다 브랜치를 만든다: `chore/setup`, `feat/contract`, `feat/scripts`, `feat/indexer`, `feat/api`, `test/integration`, `docs/readme`
- **기능 하나가 테스트를 통과할 때마다 작게 커밋한다.** 여러 기능을 한 커밋에 몰지 않는다.
- 커밋 메시지는 Conventional Commits + 한국어 설명: `feat(contract): 입찰(commit) 기능 추가`
- push와 PR 생성은 단계 종료 보고 시 승인을 받은 뒤 한다. PR 본문: 변경 내용, 테스트 결과, 설계와 달라진 점, `Closes #이슈번호`
- 커밋 전 `.env`, `.bids/`, `node_modules/`가 포함되지 않았는지 확인한다.
- 커밋 메시지의 Co-Authored-By 표시는 그대로 둔다. (AI 도구 사용 허용됨, README에 사용 사실 명시)

## 기술 스택과 규칙

- **Contracts:** Solidity 0.8.x, OpenZeppelin, Hardhat (TypeScript), ethers.js v6, Mocha/Chai, hardhat-network-helpers
- **Backend:** TypeScript (strict), Express, node-postgres(`pg`), SQL 마이그레이션 파일(`db/migrations/`)
- **Test:** 컨트랙트는 Hardhat 테스트, 통합 테스트는 Vitest + Supertest
- **실행 환경:** Docker Compose (Hardhat 노드, PostgreSQL, Indexer, API)
- 개발 PC는 **Windows**다. npm 스크립트는 OS에 상관없이 동작하게 작성한다 (셸 전용 문법 대신 Node 스크립트나 cross-env 사용).

코딩 규칙:

- 금액(uint256)은 코드에서 `bigint`, DB는 `NUMERIC(78,0)`, API 응답은 wei **문자열**
- 주소는 DB와 API에서 **소문자**로 통일
- 컨트랙트 에러는 `require` 문자열 대신 custom error (`docs/design.md` 4.6)
- ETH 지급은 반드시 Pull 방식(`pendingWithdrawals` 적립 → `withdraw`). 컨트랙트 안에서 여러 명에게 직접 송금하지 않는다.
- 입찰자 전체를 순회하는 반복문을 컨트랙트에 넣지 않는다.
- **salt와 입찰 원문은 서버·DB에 절대 저장하지 않는다.** 스크립트만 로컬 `.bids/`에 저장한다 (`.gitignore` 대상).
- 비밀값(개인키, DB 비밀번호)은 `.env`로 관리하고 `.env.example`만 커밋한다.

## 진행 상황

현재 단계를 끝내면 체크하고, 다음 단계는 지시를 받은 뒤 시작한다.

- [ ] **0단계. 프로젝트 세팅** — `git init`, GitHub 저장소 연결, 폴더 구조(design.md 1.5), Hardhat 초기화, Docker Compose로 PostgreSQL 실행(named volume, `restart: unless-stopped`), `.env.example`, `.gitignore`, README 뼈대(design.md 1.7 섹션 구성)
- [x] **1단계. 설계 확정** — 완료 (`docs/design.md`)
- [ ] **2단계. 스마트 컨트랙트 + 단위 테스트** — MockNFT → createAuction → bid → reveal → finalize → withdraw → cancel → 비정상 상황 → 보안 점검. design.md 9.1 전체 통과, 커버리지 90% 이상
- [ ] **3단계. Client Script** — design.md 7.5. `scenario.ts`로 전체 흐름 실행
- [ ] **4단계. Indexer** — design.md 6장. 중단 후 재시작 시 누락·중복 없음, 노드 재시작(체인 초기화) 감지(6.9)
- [ ] **5단계. Backend API** — design.md 7장. 7.2 엔드포인트 전체 동작
- [ ] **6단계. 통합 테스트** — design.md 9.2 전체 통과
- [ ] **7단계. 마무리** — README(design.md 1.7 구성: 설계 방식과 이유, 연동 구조, 테스트 방법, 장애 복구, 보안, 개발 과정), `docker compose up` 한 번으로 전체 실행

## 평가 항목 (README와 코드에서 드러나야 함)

결과물 · GitHub 작업 관리 방식 · 구성 요소 설계와 연동 · 테스트 방법 · 장애 발생 시 복구 방식 · 보안 대응 · 설계 방식과 이유(README)

## 확정 사항

- 네트워크: Hardhat 로컬 노드 (design.md 11장)
- 소스 관리: GitHub
- AI 코딩 도구: 사용 가능
