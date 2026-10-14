// User scripts as Hardhat tasks (design.md 12번). Loaded from hardhat.config.ts.
// Task files must not import "hardhat" itself (it would load the config again); they get `hre` instead.
import "./deploy";
import "./auction";
import "./bid";
