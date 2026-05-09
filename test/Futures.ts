import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { FhevmType } from "@fhevm/hardhat-plugin";
import {
  Collateral,
  Collateral__factory,
  MockConfidentialToken,
  MockConfidentialToken__factory,
  MockOracleIntegration,
  MockOracleIntegration__factory,
  MockPriceFeed,
  MockPriceFeed__factory,
  PositionManager,
  PositionManager__factory,
  PerpetualFutures,
  PerpetualFutures__factory,
} from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────────

const INITIAL_PRICE = 200_000_000_000n; // $2000 with 8 decimals
const DECIMALS_6 = 1_000_000n; // 1 USDC
const USER_MINT = 10_000n * DECIMALS_6; // 10 000 USDC per test user

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  liquidator: HardhatEthersSigner;
};

interface Contracts {
  token: MockConfidentialToken;
  feed: MockPriceFeed;
  oracle: MockOracleIntegration;
  collateral: Collateral;
  positionManager: PositionManager;
  futures: PerpetualFutures;
}

async function deployAll(deployer: HardhatEthersSigner): Promise<Contracts> {
  const token = await new MockConfidentialToken__factory(deployer).deploy();
  const feed = await new MockPriceFeed__factory(deployer).deploy(INITIAL_PRICE);
  const oracle = await new MockOracleIntegration__factory(deployer).deploy(
    await feed.getAddress(),
  );
  const collateral = await new Collateral__factory(deployer).deploy(
    await token.getAddress(),
  );
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
  token: MockConfidentialToken,
  collateral: Collateral,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  const collateralAddr = await collateral.getAddress();
  const tokenAddr = await token.getAddress();
  await token.mint(user.address, amount);
  // user calls TOKEN directly — TOKEN verifies proof then calls onConfidentialTransferReceived
  const input = fhevm.createEncryptedInput(tokenAddr, user.address);
  input.add64(amount);
  const { handles, inputProof } = await input.encrypt();
  await token.connect(user)["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](collateralAddr, handles[0], inputProof, "0x");
}

async function encryptWithdraw(
  collateral: Collateral,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  const collateralAddr = await collateral.getAddress();
  const input = fhevm.createEncryptedInput(collateralAddr, user.address);
  input.add64(amount);
  const { handles, inputProof } = await input.encrypt();
  return collateral.connect(user).withdraw(handles[0], inputProof);
}

async function encryptOpenPosition(
  futures: PerpetualFutures,
  user: HardhatEthersSigner,
  isLong: boolean,
  collateralAmount: bigint,
  leverage: bigint,
) {
  const futuresAddr = await futures.getAddress();
  const input = fhevm.createEncryptedInput(futuresAddr, user.address);
  input.add64(collateralAmount);
  input.addBool(isLong);
  const { handles, inputProof } = await input.encrypt();
  return futures
    .connect(user)
    .openPosition(handles[0], inputProof, leverage, handles[1]);
}

async function doFulfillClose(
  futures: PerpetualFutures,
  requestId: bigint,
  caller: HardhatEthersSigner,
): Promise<void> {
  const pending = await futures.pendingCloses(requestId);
  const result = await fhevm.publicDecrypt([
    pending.sizeHandle,
    pending.collateralHandle,
    pending.isLongHandle,
  ]);
  await futures
    .connect(caller)
    .fulfillClose(
      requestId,
      result.abiEncodedClearValues,
      result.decryptionProof,
    );
}

async function doFulfillLiquidation(
  futures: PerpetualFutures,
  requestId: bigint,
  caller: HardhatEthersSigner,
): Promise<void> {
  const pending = await futures.pendingLiquidations(requestId);
  const result = await fhevm.publicDecrypt([
    pending.sizeHandle,
    pending.collateralHandle,
    pending.isLongHandle,
  ]);
  await futures
    .connect(caller)
    .fulfillLiquidation(
      requestId,
      result.abiEncodedClearValues,
      result.decryptionProof,
    );
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("PerpetualFutures", function () {
  let signers: Signers;
  let c: Contracts;
  let collateralAddr: string;

  before(async function () {
    const all = await ethers.getSigners();
    signers = {
      deployer: all[0],
      alice: all[1],
      bob: all[2],
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
    await mintAndDeposit(c.token, c.collateral, signers.bob, USER_MINT);
  });

  // ── Suite 1: Collateral Management ────────────────────────────────────────

  describe("Collateral Management", function () {
    it("user can deposit collateral and read encrypted balance", async function () {
      const encHandle = await c.collateral
        .connect(signers.alice)
        .getMyCollateral();
      const clear = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encHandle,
        collateralAddr,
        signers.alice,
      );
      expect(clear).to.equal(USER_MINT);
    });

    it("user can withdraw and Withdraw event is emitted", async function () {
      const withdrawAmt = 500n * DECIMALS_6;
      await expect(
        encryptWithdraw(c.collateral, signers.alice, withdrawAmt),
      ).to.emit(c.collateral, "Withdraw");
    });

    it("multiple users have independent encrypted balances", async function () {
      const [encA, encB] = await Promise.all([
        c.collateral.connect(signers.alice).getMyCollateral(),
        c.collateral.connect(signers.bob).getMyCollateral(),
      ]);
      const [clearA, clearB] = await Promise.all([
        fhevm.userDecryptEuint(
          FhevmType.euint64,
          encA,
          collateralAddr,
          signers.alice,
        ),
        fhevm.userDecryptEuint(
          FhevmType.euint64,
          encB,
          collateralAddr,
          signers.bob,
        ),
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
        encryptOpenPosition(
          c.futures,
          signers.alice,
          true,
          collateralAmt,
          leverage,
        ),
      )
        .to.emit(c.futures, "PositionOpened")
        .withArgs(signers.alice.address, 0n, INITIAL_PRICE, anyValue);
    });

    it("user can open a short position", async function () {
      await expect(
        encryptOpenPosition(
          c.futures,
          signers.alice,
          false,
          1_000n * DECIMALS_6,
          3n,
        ),
      ).to.emit(c.futures, "PositionOpened");
    });

    it("collateral is deducted from vault on open", async function () {
      const depositAmt = USER_MINT;
      const marginAmt = 1_000n * DECIMALS_6;

      const encBefore = await c.collateral
        .connect(signers.alice)
        .getMyCollateral();
      const before = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encBefore,
        collateralAddr,
        signers.alice,
      );

      await encryptOpenPosition(c.futures, signers.alice, true, marginAmt, 2n);

      const encAfter = await c.collateral
        .connect(signers.alice)
        .getMyCollateral();
      const after = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encAfter,
        collateralAddr,
        signers.alice,
      );

      expect(after).to.equal(before - marginAmt);
    });

    it("entry price is recorded from oracle", async function () {
      const tx = await encryptOpenPosition(
        c.futures,
        signers.alice,
        true,
        1_000n * DECIMALS_6,
        1n,
      );
      const receipt = await (tx as any).wait();
      const event = receipt!.logs
        .map((l: any) => c.futures.interface.parseLog(l))
        .find((e: any) => e?.name === "PositionOpened");
      expect(event!.args.entryPrice).to.equal(INITIAL_PRICE);
    });

    it("rejects leverage below MIN (< 1)", async function () {
      await expect(
        encryptOpenPosition(
          c.futures,
          signers.alice,
          true,
          1_000n * DECIMALS_6,
          0n,
        ),
      ).to.be.revertedWith("Invalid leverage");
    });

    it("rejects leverage above MAX (> 10)", async function () {
      await expect(
        encryptOpenPosition(
          c.futures,
          signers.alice,
          true,
          1_000n * DECIMALS_6,
          11n,
        ),
      ).to.be.revertedWith("Invalid leverage");
    });
  });

  // ── Suite 3: Position Closing ─────────────────────────────────────────────

  describe("Position Closing", function () {
    let positionId: bigint;

    beforeEach(async function () {
      const tx = await encryptOpenPosition(
        c.futures,
        signers.alice,
        true,
        1_000n * DECIMALS_6,
        2n,
      );
      const receipt = await (tx as any).wait();
      const event = receipt!.logs
        .map((l: any) => c.futures.interface.parseLog(l))
        .find((e: any) => e?.name === "PositionOpened");
      positionId = event!.args.positionId;
    });

    it("emits PositionCloseRequested on closePosition", async function () {
      await expect(
        c.futures.connect(signers.alice).closePosition(positionId),
      ).to.emit(c.futures, "PositionCloseRequested");
    });

    it("close at profit (long, price up) increases collateral", async function () {
      await c.feed.setPrice(250_000_000_000n);

      const encBefore = await c.collateral
        .connect(signers.alice)
        .getMyCollateral();
      const before = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encBefore,
        collateralAddr,
        signers.alice,
      );

      const closeTx = await c.futures
        .connect(signers.alice)
        .closePosition(positionId);
      const closeReceipt = await closeTx.wait();
      const closeEvent = closeReceipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "PositionCloseRequested");
      await doFulfillClose(
        c.futures,
        closeEvent!.args.requestId,
        signers.alice,
      );

      const encAfter = await c.collateral
        .connect(signers.alice)
        .getMyCollateral();
      const after = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encAfter,
        collateralAddr,
        signers.alice,
      );
      expect(after).to.be.greaterThan(before);
    });

    it("close at loss (long, price down) returns less than original margin", async function () {
      await c.feed.setPrice(150_000_000_000n);

      const closeTx = await c.futures
        .connect(signers.alice)
        .closePosition(positionId);
      const closeReceipt = await closeTx.wait();
      const closeEvent = closeReceipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "PositionCloseRequested");
      await doFulfillClose(
        c.futures,
        closeEvent!.args.requestId,
        signers.alice,
      );

      const encAfter = await c.collateral
        .connect(signers.alice)
        .getMyCollateral();
      const after = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encAfter,
        collateralAddr,
        signers.alice,
      );
      expect(after).to.be.lessThan(USER_MINT);
    });

    it("position is removed after closing", async function () {
      const closeTx = await c.futures
        .connect(signers.alice)
        .closePosition(positionId);
      const closeReceipt = await closeTx.wait();
      const closeEvent = closeReceipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "PositionCloseRequested");
      await doFulfillClose(
        c.futures,
        closeEvent!.args.requestId,
        signers.alice,
      );
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
    const MARGIN = 1_000n * DECIMALS_6;
    const LEVERAGE = 5n;

    beforeEach(async function () {
      await mintAndDeposit(
        c.token,
        c.collateral,
        signers.liquidator,
        USER_MINT,
      );

      const tx = await encryptOpenPosition(
        c.futures,
        signers.alice,
        true,
        MARGIN,
        LEVERAGE,
      );
      const receipt = await (tx as any).wait();
      const event = receipt!.logs
        .map((l: any) => c.futures.interface.parseLog(l))
        .find((e: any) => e?.name === "PositionOpened");
      positionId = event!.args.positionId;
    });

    it("liquidation request is emitted when triggered", async function () {
      await c.feed.setPrice(100_000_000_000n);
      await expect(
        c.futures
          .connect(signers.liquidator)
          .liquidatePosition(signers.alice.address, positionId),
      ).to.emit(c.futures, "LiquidationRequested");
    });

    it("liquidation callback emits Liquidated event", async function () {
      await c.feed.setPrice(100_000_000_000n);
      const liqTx = await c.futures
        .connect(signers.liquidator)
        .liquidatePosition(signers.alice.address, positionId);
      const liqReceipt = await liqTx.wait();
      const liqEvent = liqReceipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "LiquidationRequested");
      const requestId = liqEvent!.args.requestId;
      const pending = await c.futures.pendingLiquidations(requestId);
      const result = await fhevm.publicDecrypt([
        pending.sizeHandle,
        pending.collateralHandle,
        pending.isLongHandle,
      ]);
      await expect(
        c.futures
          .connect(signers.liquidator)
          .fulfillLiquidation(
            requestId,
            result.abiEncodedClearValues,
            result.decryptionProof,
          ),
      ).to.emit(c.futures, "Liquidated");
    });

    it("liquidator receives bonus after liquidation", async function () {
      await c.feed.setPrice(100_000_000_000n);

      const encBefore = await c.collateral
        .connect(signers.liquidator)
        .getMyCollateral();
      const before = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encBefore,
        collateralAddr,
        signers.liquidator,
      );

      const liqTx = await c.futures
        .connect(signers.liquidator)
        .liquidatePosition(signers.alice.address, positionId);
      const liqReceipt = await liqTx.wait();
      const liqEvent = liqReceipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "LiquidationRequested");
      await doFulfillLiquidation(
        c.futures,
        liqEvent!.args.requestId,
        signers.liquidator,
      );

      const encAfter = await c.collateral
        .connect(signers.liquidator)
        .getMyCollateral();
      const after = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        encAfter,
        collateralAddr,
        signers.liquidator,
      );
      expect(after).to.be.greaterThan(before);
    });

    it("position is removed after liquidation", async function () {
      await c.feed.setPrice(100_000_000_000n);
      const liqTx = await c.futures
        .connect(signers.liquidator)
        .liquidatePosition(signers.alice.address, positionId);
      const liqReceipt = await liqTx.wait();
      const liqEvent = liqReceipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "LiquidationRequested");
      await doFulfillLiquidation(
        c.futures,
        liqEvent!.args.requestId,
        signers.liquidator,
      );
      await expect(
        c.positionManager.getFuturesPosition(signers.alice.address, positionId),
      ).to.be.revertedWith("Position not open");
    });

    it("cannot liquidate non-existent position", async function () {
      await c.feed.setPrice(100_000_000_000n);
      await expect(
        c.futures
          .connect(signers.liquidator)
          .liquidatePosition(signers.alice.address, 999n),
      ).to.be.revertedWith("Position not open");
    });

    it("cannot liquidate a healthy position (revert in callback)", async function () {
      // Price unchanged — the callback should revert with 'Not liquidatable'
      const liqTx = await c.futures
        .connect(signers.liquidator)
        .liquidatePosition(signers.alice.address, positionId);
      const liqReceipt = await liqTx.wait();
      const liqEvent = liqReceipt!.logs
        .map((l) => c.futures.interface.parseLog(l))
        .find((e) => e?.name === "LiquidationRequested");
      await expect(
        doFulfillLiquidation(
          c.futures,
          liqEvent!.args.requestId,
          signers.liquidator,
        ),
      ).to.be.revertedWith("Not liquidatable");
      // Position should still be open because liquidation failed
      const pos = await c.positionManager.getFuturesPosition(
        signers.alice.address,
        positionId,
      );
      expect(pos.isOpen).to.be.true;
    });
  });
});
