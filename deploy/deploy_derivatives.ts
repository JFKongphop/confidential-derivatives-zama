import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

// OracleIntegration has the Chainlink ETH/USD feed hardcoded — no address needed.
// MockPriceFeed is only deployed on local networks.


const LOCAL_NETWORKS = new Set(["hardhat", "localhost", "anvil"]);

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, execute } = hre.deployments;
  const network = hre.network.name;
  const isLocal = LOCAL_NETWORKS.has(network);

  // Helper: verify a contract on Etherscan (skipped on local networks)
  async function verify(address: string, constructorArguments: unknown[] = []) {
    if (isLocal) return;
    try {
      await hre.run("verify:verify", { address, constructorArguments });
      console.log(`   ✓ Verified ${address}`);
    } catch (e: any) {
      if (e?.message?.toLowerCase().includes("already verified")) {
        console.log(`   ℹ Already verified ${address}`);
      } else {
        console.warn(`   ⚠ Verification failed for ${address}: ${e?.message}`);
      }
    }
  }

  console.log(`\n🚀 Deploying Confidential Derivatives to: ${network}`);
  console.log(`   Deployer: ${deployer}\n`);

  // ── 1. Confidential token ─────────────────────────────────────────────────
  //   Sepolia → deploy MockERC20 faucet + ConfidentialWETHWrapper (wraps WETH 1:1)
  //   Local   → deploy MockConfidentialToken (open mint, no ERC-20 needed)
  let tokenAddress: string;

  if (!isLocal) {
    // Sepolia path: deploy MockERC20 faucet → wrap into cWETH via ConfidentialWETHWrapper
    const mockERC20 = await deploy("MockERC20", {
      from: deployer,
      log: true,
      args: [],
    });
    console.log(`   MockERC20 (WETH faucet): ${mockERC20.address}`);
    await verify(mockERC20.address, []);

    const wrapper = await deploy("ConfidentialWETHWrapper", {
      from: deployer,
      log: true,
      args: [mockERC20.address],
    });
    tokenAddress = wrapper.address;
    console.log(`   ConfidentialWETHWrapper : ${tokenAddress}  (underlying: ${mockERC20.address})`);
    await verify(tokenAddress, [mockERC20.address]);
  } else {
    // Local / hardhat path: open-mint mock token
    const mockToken = await deploy("MockConfidentialToken", {
      from: deployer,
      log: true,
      args: [],
    });
    tokenAddress = mockToken.address;
    console.log(`   MockConfidentialToken : ${tokenAddress}  (open mint, test only)`);
    await verify(tokenAddress, []);
  }

  // ── 2. Oracle ─────────────────────────────────────────────────────────────
  let oracleProxyAddress: string;

  // ── 2. Oracle ─────────────────────────────────────────────────────────────
  if (isLocal) {
    const mockFeed = await deploy("MockPriceFeed", {
      from: deployer,
      log: true,
      args: [229484680000], // ~$2,294.85 (8 decimals)
    });
    console.log(`   MockPriceFeed         : ${mockFeed.address}`);
  }

  // OracleIntegration has the Chainlink feed hardcoded — no constructor args needed.
  const oracle = await deploy("OracleIntegration", {
    from: deployer,
    log: true,
    args: [],
  });
  oracleProxyAddress = oracle.address;
  console.log(`   OracleIntegration     : ${oracleProxyAddress}  (feed: 0x694AA1769357215DE4FAC081bf1f309aDC325306)`);
  if (!isLocal) await verify(oracleProxyAddress, []);

  // ── 3. Collateral vault ───────────────────────────────────────────────────
  const collateral = await deploy("Collateral", {
    from: deployer,
    log: true,
    args: [tokenAddress],
  });
  console.log(`   Collateral            : ${collateral.address}`);
  await verify(collateral.address, [tokenAddress]);

  // ── 4. PositionManager ────────────────────────────────────────────────────
  const positionManager = await deploy("PositionManager", {
    from: deployer,
    log: true,
    args: [],
  });
  console.log(`   PositionManager       : ${positionManager.address}`);
  await verify(positionManager.address, []);

  // ── 5. PerpetualFutures ───────────────────────────────────────────────────
  const futures = await deploy("PerpetualFutures", {
    from: deployer,
    log: true,
    args: [collateral.address, oracleProxyAddress, positionManager.address],
  });
  console.log(`   PerpetualFutures      : ${futures.address}`);
  await verify(futures.address, [collateral.address, oracleProxyAddress, positionManager.address]);

  // ── 6. LimitOrderBook ─────────────────────────────────────────────────────
  const limitOrderBook = await deploy("LimitOrderBook", {
    from: deployer,
    log: true,
    args: [collateral.address, oracleProxyAddress, positionManager.address, futures.address],
  });
  console.log(`   LimitOrderBook        : ${limitOrderBook.address}`);
  await verify(limitOrderBook.address, [
    collateral.address,
    oracleProxyAddress,
    positionManager.address,
    futures.address,
  ]);

  // ── 7. OptionsPool ────────────────────────────────────────────────────────
  const optionsPool = await deploy("OptionsPool", {
    from: deployer,
    log: true,
    args: [collateral.address, oracleProxyAddress, positionManager.address],
  });
  console.log(`   OptionsPool           : ${optionsPool.address}`);
  await verify(optionsPool.address, [collateral.address, oracleProxyAddress, positionManager.address]);

  // ── 8. Authorise trading contracts on Collateral ──────────────────────────
  console.log("\n🔑 Authorising contracts on Collateral...");

  await execute("Collateral", { from: deployer, log: true }, "authorise", futures.address);
  console.log(`   ✓ PerpetualFutures authorised`);

  await execute("Collateral", { from: deployer, log: true }, "authorise", limitOrderBook.address);
  console.log(`   ✓ LimitOrderBook authorised`);

  await execute("Collateral", { from: deployer, log: true }, "authorise", optionsPool.address);
  console.log(`   ✓ OptionsPool authorised`);

  // ── 9. Summary ────────────────────────────────────────────────────────────
  console.log("\n✅ Deployment complete!\n");
  console.log("   Copy these into frontend/.env.local:\n");
  console.log(`   NEXT_PUBLIC_TOKEN_ADDRESS=${tokenAddress}`);
  console.log(`   NEXT_PUBLIC_ORACLE_ADDRESS=${oracleProxyAddress}`);
  console.log(`   NEXT_PUBLIC_COLLATERAL_ADDRESS=${collateral.address}`);
  console.log(`   NEXT_PUBLIC_POSITION_MANAGER_ADDRESS=${positionManager.address}`);
  console.log(`   NEXT_PUBLIC_FUTURES_ADDRESS=${futures.address}`);
  console.log(`   NEXT_PUBLIC_LIMIT_ORDER_BOOK_ADDRESS=${limitOrderBook.address}`);
  console.log(`   NEXT_PUBLIC_OPTIONS_ADDRESS=${optionsPool.address}`);
};

export default func;
func.id = "deploy_confidential_derivatives";
func.tags = ["ConfidentialDerivatives", "Futures", "Options"];
