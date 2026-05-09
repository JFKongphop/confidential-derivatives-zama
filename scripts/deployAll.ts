/**
 * Full redeploy script — deploys all 7 contracts in dependency order
 * and writes the new addresses to frontend/.env.local
 *
 * Usage:
 *   npx hardhat run scripts/deployAll.ts --network sepolia
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // ── 1. MockConfidentialToken ─────────────────────────────────────────────
  console.log("1/7 Deploying MockConfidentialToken...");
  const Token = await ethers.getContractFactory("MockConfidentialToken");
  const token = await Token.deploy();
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("   ✓ MockConfidentialToken:", tokenAddress);

  // ── 2. Collateral ────────────────────────────────────────────────────────
  console.log("2/7 Deploying Collateral...");
  const Collateral = await ethers.getContractFactory("Collateral");
  const collateral = await Collateral.deploy(tokenAddress);
  await collateral.waitForDeployment();
  const collateralAddress = await collateral.getAddress();
  console.log("   ✓ Collateral:", collateralAddress);

  // ── 3. OracleIntegration ─────────────────────────────────────────────────
  console.log("3/7 Deploying OracleIntegration...");
  const Oracle = await ethers.getContractFactory("OracleIntegration");
  const oracle = await Oracle.deploy();
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();
  console.log("   ✓ OracleIntegration:", oracleAddress);

  // ── 4. PositionManager ───────────────────────────────────────────────────
  console.log("4/7 Deploying PositionManager...");
  const PositionManager = await ethers.getContractFactory("PositionManager");
  const positionManager = await PositionManager.deploy();
  await positionManager.waitForDeployment();
  const positionManagerAddress = await positionManager.getAddress();
  console.log("   ✓ PositionManager:", positionManagerAddress);

  // ── 5. PerpetualFutures ──────────────────────────────────────────────────
  console.log("5/7 Deploying PerpetualFutures...");
  const Futures = await ethers.getContractFactory("PerpetualFutures");
  const futures = await Futures.deploy(collateralAddress, oracleAddress, positionManagerAddress);
  await futures.waitForDeployment();
  const futuresAddress = await futures.getAddress();
  console.log("   ✓ PerpetualFutures:", futuresAddress);

  // ── 6. LimitOrderBook ────────────────────────────────────────────────────
  console.log("6/7 Deploying LimitOrderBook...");
  const LOB = await ethers.getContractFactory("LimitOrderBook");
  const lob = await LOB.deploy(collateralAddress, oracleAddress, positionManagerAddress, futuresAddress);
  await lob.waitForDeployment();
  const lobAddress = await lob.getAddress();
  console.log("   ✓ LimitOrderBook:", lobAddress);

  // ── 7. OptionsPool ───────────────────────────────────────────────────────
  console.log("7/7 Deploying OptionsPool...");
  const Options = await ethers.getContractFactory("OptionsPool");
  const options = await Options.deploy(collateralAddress, oracleAddress, positionManagerAddress);
  await options.waitForDeployment();
  const optionsAddress = await options.getAddress();
  console.log("   ✓ OptionsPool:", optionsAddress);

  // ── Authorise contracts in PositionManager ───────────────────────────────
  console.log("\nAuthorising contracts in PositionManager...");
  await (await positionManager.authorise(futuresAddress)).wait();
  console.log("   ✓ Authorised PerpetualFutures");
  await (await positionManager.authorise(lobAddress)).wait();
  console.log("   ✓ Authorised LimitOrderBook");
  await (await positionManager.authorise(optionsAddress)).wait();
  console.log("   ✓ Authorised OptionsPool");

  // ── Authorise contracts in Collateral ────────────────────────────────────
  console.log("\nAuthorising contracts in Collateral...");
  await (await collateral.authorise(futuresAddress)).wait();
  console.log("   ✓ Authorised PerpetualFutures");
  await (await collateral.authorise(lobAddress)).wait();
  console.log("   ✓ Authorised LimitOrderBook");
  await (await collateral.authorise(optionsAddress)).wait();
  console.log("   ✓ Authorised OptionsPool");

  // ── Write .env.local ─────────────────────────────────────────────────────
  const envPath = path.resolve(__dirname, "../frontend/.env.local");
  const rpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://sepolia.infura.io/v3/af5f1e33ac0c4cd69daa3f63a587723e";

  const envContent = `NEXT_PUBLIC_RPC_URL=${rpcUrl}

NEXT_PUBLIC_TOKEN_ADDRESS=${tokenAddress}
NEXT_PUBLIC_ORACLE_ADDRESS=${oracleAddress}
NEXT_PUBLIC_COLLATERAL_ADDRESS=${collateralAddress}
NEXT_PUBLIC_POSITION_MANAGER_ADDRESS=${positionManagerAddress}
NEXT_PUBLIC_FUTURES_ADDRESS=${futuresAddress}
NEXT_PUBLIC_LIMIT_ORDER_BOOK_ADDRESS=${lobAddress}
NEXT_PUBLIC_OPTIONS_ADDRESS=${optionsAddress}
NEXT_PUBLIC_UNDERLYING_ADDRESS=
`;

  fs.writeFileSync(envPath, envContent);
  console.log("\n✅ Written to frontend/.env.local");

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("DEPLOY COMPLETE — new addresses:");
  console.log("  TOKEN:            ", tokenAddress);
  console.log("  COLLATERAL:       ", collateralAddress);
  console.log("  ORACLE:           ", oracleAddress);
  console.log("  POSITION_MANAGER: ", positionManagerAddress);
  console.log("  FUTURES:          ", futuresAddress);
  console.log("  LIMIT_ORDER_BOOK: ", lobAddress);
  console.log("  OPTIONS:          ", optionsAddress);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("\nNext steps:");
  console.log("  cd frontend && npm run build");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
