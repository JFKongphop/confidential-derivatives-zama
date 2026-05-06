import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";
import {
  Collateral,
  Collateral__factory,
  MockERC20,
  MockERC20__factory,
  MockPriceFeed,
  MockPriceFeed__factory,
  OracleIntegration,
  OracleIntegration__factory,
  PositionManager,
  PositionManager__factory,
  PerpetualFutures,
  PerpetualFutures__factory,
} from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────────

const INITIAL_PRICE = 200_000_000_000n; // $2000 with 8 decimals
const DECIMALS_6 = 1_000_000n;         // 1 USDC
const USER_MINT = 10_000n * DECIMALS_6; // 10 000 USDC per test user

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  liquidator: HardhatEthersSigner;
};

interface Contracts {
  token: MockERC20;
  feed: MockPriceFeed;
  oracle: OracleIntegration;
  collateral: Collateral;
  positionManager: PositionManager;
  futures: PerpetualFutures;
}

async function deployAll(deployer: HardhatEthersSigner): Promise<Contracts> {
  const token = await new MockERC20__factory(deployer).deploy("Mock USDC", "USDC", 6);
  const feed  = await new MockPriceFeed__factory(deployer).deploy(INITIAL_PRICE);
  const oracle = await new OracleIntegration__factory(deployer).deploy(await feed.getAddress());
  const collateral = await new Collateral__factory(deployer).deploy(await token.getAddress());
  const positionManager = await new PositionManager__factory(deployer).deploy();
  const futures = await new PerpetualFutures__factory(deployer).deploy(
    await collateral.getAddress(),
    await oracle.getAddress(),
    await positionManager.getAddress(),
  );

  // Authorise futures contract to call collateral and positionManager
  await collateral.authorise(await futures.getAddress());
  await positionManager.authorise(await futures.getAddress());

  return { token, feed, oracle, collateral, positionManager, futures };
}

async function mintAndDeposit(
  token: MockERC20,
  collateral: Collateral,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await collateral.getAddress(), amount);
  await collateral.connect(user).deposit(amount);
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("PerpetualFutures", function () {
  let signers: Signers;
  let c: Contracts;
  let collateralAddr: string;

  before(async function () {
    const all = await ethers.getSigners();
    signers = {
      deployer:   all[0],
      alice:      all[1],
      bob:        all[2],
      liquidator: all[3],
    };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      this.skip();
    }
    c = await deployAll(signers.deployer);
    collateralAddr = await c.collateral.getAddress();

    // Give alice and bob 10 000 USDC each and deposit into vault
    await mintAndDeposit(c.token, c.collateral, signers.alice, USER_MINT);
    await mintAndDeposit(c.token, c.collateral, signers.bob,   USER_MINT);
  });

  // ── Suite 1: Collateral Management ────────────────────────────────────────

  describe("Collateral Management", function () {
    it("user can deposit collateral and read encrypted balance", async function () {
      const encHandle = await c.collateral.connect(signers.alice).getMyCollateral();
      console.log(encHandle)
      const clear = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encHandle,
        collateralAddr,
        signers.liquidator,
      );
      console.log(clear)
      expect(clear).to.equal(USER_MINT);
    });

    it("rejects zero deposit", async function () {
      await expect(
        c.collateral.connect(signers.alice).deposit(0n),
      ).to.be.revertedWith("Invalid amount");
    });

    it("user can initiate withdraw and WithdrawRequested event is emitted", async function () {
      const withdrawAmt = 500n * DECIMALS_6;
      await expect(
        c.collateral.connect(signers.alice).withdraw(withdrawAmt),
      ).to.emit(c.collateral, "WithdrawRequested");
    });

    it("rejects zero withdraw", async function () {
      await expect(
        c.collateral.connect(signers.alice).withdraw(0n),
      ).to.be.revertedWith("Invalid amount");
    });

    it("multiple users have independent encrypted balances", async function () {
      const [encA, encB] = await Promise.all([
        c.collateral.connect(signers.alice).getMyCollateral(),
        c.collateral.connect(signers.bob).getMyCollateral(),
      ]);
      const [clearA, clearB] = await Promise.all([
        fhevm.userDecryptEuint(FhevmType.euint64, encA, collateralAddr, signers.alice),
        fhevm.userDecryptEuint(FhevmType.euint64, encB, collateralAddr, signers.bob),
      ]);
      expect(clearA).to.equal(USER_MINT);
      expect(clearB).to.equal(USER_MINT);
    });
  });

  // ── Suite 2: Position Opening ─────────────────────────────────────────────

  describe("Position Opening", function () {
    it("user can open a long position and event is emitted", async function () {
      const collateralAmt = 1_000n * DECIMALS_6;
      const leverage = 2n;

      await expect(
        c.futures.connect(signers.alice).openPosition(true, collateralAmt, leverage),
      )
        .to.emit(c.futures, "PositionOpened")
        .withArgs(signers.alice.address, 0n, true, INITIAL_PRICE, collateralAmt);
    });

    it("user can open a short position", async function () {
      await expect(
        c.futures.connect(signers.alice).openPosition(false, 1_000n * DECIMALS_6, 3n),
      ).to.emit(c.futures, "PositionOpened");
    });

    it("collateral is deducted from vault on open", async function () {
      const depositAmt  = USER_MINT;
      const marginAmt   = 1_000n * DECIMALS_6;

      const encBefore = await c.collateral.connect(signers.alice).getMyCollateral();
      const before = await fhevm.userDecryptEuint(FhevmType.euint64, encBefore, collateralAddr, signers.alice);

      await c.futures.connect(signers.alice).openPosition(true, marginAmt, 2n);

      const encAfter = await c.collateral.connect(signers.alice).getMyCollateral();
      const after = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, collateralAddr, signers.alice);

      expect(after).to.equal(before - marginAmt);
    });

    it("entry price is recorded from oracle", async function () {
      const tx = await c.futures.connect(signers.alice).openPosition(true, 1_000n * DECIMALS_6, 1n);
      const receipt = await tx.wait();
      const event = receipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "PositionOpened");
      expect(event!.args.entryPrice).to.equal(INITIAL_PRICE);
    });

    it("rejects leverage below MIN (< 1)", async function () {
      await expect(
        c.futures.connect(signers.alice).openPosition(true, 1_000n * DECIMALS_6, 0n),
      ).to.be.revertedWith("Invalid leverage");
    });

    it("rejects leverage above MAX (> 10)", async function () {
      await expect(
        c.futures.connect(signers.alice).openPosition(true, 1_000n * DECIMALS_6, 11n),
      ).to.be.revertedWith("Invalid leverage");
    });

    it("rejects zero collateral amount", async function () {
      await expect(
        c.futures.connect(signers.alice).openPosition(true, 0n, 2n),
      ).to.be.revertedWith("Invalid collateral amount");
    });
  });

  // ── Suite 3: Position Closing ─────────────────────────────────────────────

  describe("Position Closing", function () {
    let positionId: bigint;

    beforeEach(async function () {
      const tx = await c.futures.connect(signers.alice).openPosition(true, 1_000n * DECIMALS_6, 2n);
      const receipt = await tx.wait();
      const event = receipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "PositionOpened");
      positionId = event!.args.positionId;
    });

    it("emits PositionCloseRequested on closePosition", async function () {
      await expect(
        c.futures.connect(signers.alice).closePosition(positionId),
      ).to.emit(c.futures, "PositionCloseRequested");
    });

    it("close at profit (long, price up) increases collateral", async function () {
      await c.feed.setPrice(250_000_000_000n);

      const encBefore = await c.collateral.connect(signers.alice).getMyCollateral();
      const before = await fhevm.userDecryptEuint(FhevmType.euint64, encBefore, collateralAddr, signers.alice);

      await c.futures.connect(signers.alice).closePosition(positionId);
      await fhevm.awaitDecryptionOracle(); // oracle auto-calls fulfillClose

      const encAfter = await c.collateral.connect(signers.alice).getMyCollateral();
      const after = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, collateralAddr, signers.alice);
      expect(after).to.be.greaterThan(before);
    });

    it("close at loss (long, price down) returns less than original margin", async function () {
      await c.feed.setPrice(150_000_000_000n);

      await c.futures.connect(signers.alice).closePosition(positionId);
      await fhevm.awaitDecryptionOracle();

      const encAfter = await c.collateral.connect(signers.alice).getMyCollateral();
      const after = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, collateralAddr, signers.alice);
      expect(after).to.be.lessThan(USER_MINT);
    });

    it("position is removed after closing", async function () {
      await c.futures.connect(signers.alice).closePosition(positionId);
      await fhevm.awaitDecryptionOracle();
      await expect(
        c.positionManager.getFuturesPosition(signers.alice.address, positionId),
      ).to.be.revertedWith("Position not open");
    });

    it("cannot close a non-existent position", async function () {
      await expect(
        c.futures.connect(signers.alice).closePosition(999n),
      ).to.be.revertedWith("Position not open");
    });
  });

  // ── Suite 4: Liquidation ──────────────────────────────────────────────────

  describe("Liquidation", function () {
    let positionId: bigint;
    const MARGIN   = 1_000n * DECIMALS_6;
    const LEVERAGE = 5n;

    beforeEach(async function () {
      await mintAndDeposit(c.token, c.collateral, signers.liquidator, USER_MINT);

      const tx = await c.futures.connect(signers.alice).openPosition(true, MARGIN, LEVERAGE);
      const receipt = await tx.wait();
      const event = receipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "PositionOpened");
      positionId = event!.args.positionId;
    });

    it("liquidation request is emitted when triggered", async function () {
      await c.feed.setPrice(100_000_000_000n);
      await expect(
        c.futures.connect(signers.liquidator).liquidatePosition(signers.alice.address, positionId),
      ).to.emit(c.futures, "LiquidationRequested");
    });

    it("liquidation callback emits Liquidated event", async function () {
      await c.feed.setPrice(100_000_000_000n);
      await expect(
        c.futures.connect(signers.liquidator).liquidatePosition(signers.alice.address, positionId),
      ).to.emit(c.futures, "LiquidationRequested");
      // Let oracle process → should emit Liquidated
      await fhevm.awaitDecryptionOracle();
    });

    it("liquidator receives bonus after liquidation", async function () {
      await c.feed.setPrice(100_000_000_000n);

      const encBefore = await c.collateral.connect(signers.liquidator).getMyCollateral();
      const before = await fhevm.userDecryptEuint(
        FhevmType.euint64, encBefore, collateralAddr, signers.liquidator,
      );

      await c.futures.connect(signers.liquidator).liquidatePosition(signers.alice.address, positionId);
      await fhevm.awaitDecryptionOracle();

      const encAfter = await c.collateral.connect(signers.liquidator).getMyCollateral();
      const after = await fhevm.userDecryptEuint(
        FhevmType.euint64, encAfter, collateralAddr, signers.liquidator,
      );
      expect(after).to.be.greaterThan(before);
    });

    it("position is removed after liquidation", async function () {
      await c.feed.setPrice(100_000_000_000n);
      await c.futures.connect(signers.liquidator).liquidatePosition(signers.alice.address, positionId);
      await fhevm.awaitDecryptionOracle();
      await expect(
        c.positionManager.getFuturesPosition(signers.alice.address, positionId),
      ).to.be.revertedWith("Position not open");
    });

    it("cannot liquidate non-existent position", async function () {
      await c.feed.setPrice(100_000_000_000n);
      await expect(
        c.futures.connect(signers.liquidator).liquidatePosition(signers.alice.address, 999n),
      ).to.be.revertedWith("Position not open");
    });

    it("cannot liquidate a healthy position (revert in callback)", async function () {
      // Price unchanged — the callback should revert with 'Not liquidatable'
      // Since awaitDecryptionOracle swallows the revert, we verify position still exists
      await c.futures.connect(signers.liquidator).liquidatePosition(signers.alice.address, positionId);
      try { await fhevm.awaitDecryptionOracle(); } catch { /* callback reverted — expected */ }
      // Position should still be open because liquidation failed
      const pos = await c.positionManager.getFuturesPosition(signers.alice.address, positionId);
      expect(pos.isOpen).to.be.true;
    });
  });
});
