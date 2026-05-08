/**
 * Targeted redeploy: Collateral + all contracts that take it as a constructor arg.
 * Reuses existing MockERC20, ConfidentialWETHWrapper, OracleIntegration, PositionManager.
 * No Etherscan verification (fast).
 *
 * Run: npx hardhat run scripts/redeploy_collateral.ts --network sepolia
 */
import { ethers } from "hardhat";

const TOKEN_ADDRESS        = "0x44528A5CE9229EF951F042D8eb84087a35d949c1"; // MockConfidentialToken (direct mint, no ERC20 wrap)
const ORACLE_ADDRESS       = "0x0B344e1936C479745c6fE6455d706961b91202B1";
const POSITION_MANAGER     = "0x5fdC9af999eEac90B03b2E6f49E06E1C4DA8A58F";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // 1. Collateral
  console.log("\n1/4  Deploying Collateral...");
  const CollateralFactory = await ethers.getContractFactory("Collateral");
  const collateral = await CollateralFactory.deploy(TOKEN_ADDRESS);
  await collateral.waitForDeployment();
  const collateralAddr = await collateral.getAddress();
  console.log("     Collateral:", collateralAddr);

  // 2. PerpetualFutures
  console.log("2/4  Deploying PerpetualFutures...");
  const FuturesFactory = await ethers.getContractFactory("PerpetualFutures");
  const futures = await FuturesFactory.deploy(collateralAddr, ORACLE_ADDRESS, POSITION_MANAGER);
  await futures.waitForDeployment();
  const futuresAddr = await futures.getAddress();
  console.log("     PerpetualFutures:", futuresAddr);

  // 3. LimitOrderBook
  console.log("3/4  Deploying LimitOrderBook...");
  const LobFactory = await ethers.getContractFactory("LimitOrderBook");
  const lob = await LobFactory.deploy(collateralAddr, ORACLE_ADDRESS, POSITION_MANAGER, futuresAddr);
  await lob.waitForDeployment();
  const lobAddr = await lob.getAddress();
  console.log("     LimitOrderBook:", lobAddr);

  // 4. OptionsPool
  console.log("4/4  Deploying OptionsPool...");
  const OptionsFactory = await ethers.getContractFactory("OptionsPool");
  const options = await OptionsFactory.deploy(collateralAddr, ORACLE_ADDRESS, POSITION_MANAGER);
  await options.waitForDeployment();
  const optionsAddr = await options.getAddress();
  console.log("     OptionsPool:", optionsAddr);

  // 5. Authorise trading contracts on Collateral
  console.log("\nAuthorising contracts...");
  await (await collateral.authorise(futuresAddr)).wait();
  console.log("     ✓ PerpetualFutures authorised");
  await (await collateral.authorise(lobAddr)).wait();
  console.log("     ✓ LimitOrderBook authorised");
  await (await collateral.authorise(optionsAddr)).wait();
  console.log("     ✓ OptionsPool authorised");

  console.log("\n✅ Done! Update frontend/.env.local:\n");
  console.log(`NEXT_PUBLIC_COLLATERAL_ADDRESS=${collateralAddr}`);
  console.log(`NEXT_PUBLIC_FUTURES_ADDRESS=${futuresAddr}`);
  console.log(`NEXT_PUBLIC_LIMIT_ORDER_BOOK_ADDRESS=${lobAddr}`);
  console.log(`NEXT_PUBLIC_OPTIONS_ADDRESS=${optionsAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
