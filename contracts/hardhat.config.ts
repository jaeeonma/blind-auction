import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// 개발용 노드(`npm run node`)만 이 값을 설정한다 (design.md 3번 실행 구성).
// Hardhat 노드는 트랜잭션이 올 때만 블록을 만들어서, 트랜잭션이 없으면 블록 시간이 멈추고
// Indexer가 저장하는 블록 시간과 API의 진행 상태도 멈춘다 (design.md 10번).
const blockIntervalMs = Number(process.env.DEV_BLOCK_INTERVAL_MS ?? 0);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin 5.x가 쓰는 mcopy 명령어는 Cancun 이후 EVM에서만 동작한다.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      // 트랜잭션은 바로 블록에 넣고(auto), 트랜잭션이 없어도 interval마다 빈 블록을 만든다.
      // 테스트에서는 켜지 않는다: 시간을 지정한 블록 사이에 빈 블록이 끼어들면 경계값 테스트가 흔들린다.
      // 변수가 없으면 Hardhat 기본값(트랜잭션마다 블록)이다.
      mining: blockIntervalMs > 0 ? { auto: true, interval: blockIntervalMs } : undefined,
    },
  },
};

export default config;
