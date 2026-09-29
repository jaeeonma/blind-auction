# Blind Auction

EVM 기반 Blind Auction(Commit-Reveal) 시스템. 스마트 컨트랙트가 입찰·검증·낙찰·정산을 처리하고, Indexer가 이벤트를 PostgreSQL에 저장하며, REST API가 조회를 제공한다.

> 상세 설계: [docs/design.md](docs/design.md)

## 1. 프로젝트 소개

> TODO: 한 줄 요약, 아키텍처 다이어그램 (design.md 1.4)

## 2. 빠른 시작

### 요구 환경

- Node.js 20 이상, npm
- Docker Desktop (Docker Compose v2)

### 현재 실행 가능한 명령 (0단계)

```bash
# 1. 환경 변수 파일 생성 (Windows: copy .env.example .env)
cp .env.example .env

# 2. PostgreSQL 실행
docker compose up -d postgres

# 3. 컨트랙트 의존성 설치와 컴파일
cd contracts
npm install
npm run compile
npm test
```

> TODO: `docker compose up` 한 번으로 전체 실행, 시나리오 실행 (design.md 7.5)

## 3. 설계 방식과 이유

> TODO: 경매 규칙과 설계 결정 요약표 (design.md 2장, 2.7)

## 4. 구성 요소와 연동

> TODO: 컨트랙트 → 이벤트 → Indexer → DB → API 흐름 (design.md 4~7장)

## 5. 테스트

> TODO: 실행 명령, 테스트 범위, 커버리지 결과 (design.md 9장)

## 6. 장애 발생 시 복구

> TODO: 장애 상황별 감지·복구 방법 표 (design.md 6.9, 6.10)

## 7. 보안

> TODO: 요구사항별 대응, 알려진 한계 (design.md 8장)

## 8. 개발 과정

> TODO: 브랜치·PR 운영 방식, AI 코딩 도구 사용 사실 (design.md 1.6)
