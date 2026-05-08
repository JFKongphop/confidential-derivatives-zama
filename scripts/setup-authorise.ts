/**
 * One-time setup: authorise protocol contracts on Collateral and PositionManager.
 * Run with:  npx hardhat run scripts/setup-authorise.ts --network sepolia
 */
import { ethers } from "hardhat";

const COLLATERAL_ADDRESS      = "0x7ADCF6616CD0A0B82530a877E6E91BFeFCFbc360";
const POSITION_MANAGER_ADDRESS = "0x5fdC9af999eEac90B03b2E6f49E06E1C4DA8A58F";
const FUTURES_ADDRESS          = "0x0C8aeB7260B2ee7B54749e1bEE55e2108C562eD5";
const LIMIT_ORDER_BOOK_ADDRESS = "0x8f882fF36f8f2Bf6cb1B270e4a7Dd1DeC80D3EE7";
const OPTIONS_ADDRESS          = "0xd86C56B6Ea88514A0CBf6FC9eB2d9eAE543D5f22";

const ABI = ["function authorise(address account) external"];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);

  const collateral      = new ethers.Contract(COLLATERAL_ADDRESS,       ABI, signer);
  const positionManager = new ethers.Contract(POSITION_MANAGER_ADDRESS, ABI, signer);

  const calls: [string, string, string][] = [
    ["Collateral",       "Futures",         FUTURES_ADDRESS],
    ["Collateral",       "LimitOrderBook",  LIMIT_ORDER_BOOK_ADDRESS],
    ["Collateral",       "Options",         OPTIONS_ADDRESS],
    ["PositionManager",  "Futures",         FUTURES_ADDRESS],
    ["PositionManager",  "LimitOrderBook",  LIMIT_ORDER_BOOK_ADDRESS],
    ["PositionManager",  "Options",         OPTIONS_ADDRESS],
  ];

  for (const [contract, name, addr] of calls) {
    const target = contract === "Collateral" ? collateral : positionManager;
    console.log(`Authorising ${name} on ${contract}...`);
    const tx = await target.authorise(addr);
    await tx.wait();
    console.log(`  ✓ tx: ${tx.hash}`);
  }

  console.log("\nAll authorisations set.");
}

main().catch(err => { console.error(err); process.exit(1); });
