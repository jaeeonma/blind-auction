import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin 5.x가 쓰는 mcopy 명령어는 Cancun 이후 EVM에서만 동작한다.
      evmVersion: "cancun",
    },
  },
};

export default config;
