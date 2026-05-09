/**
 * Tests for LimitOrderBook — encrypted limit orders for perpetual futures.
 *
 * Coverage:
 *   • placeLimitOrder stores encrypted handles and locks collateral
 *   • cancelOrder returns locked collateral and marks order closed
 *   • cancelOrder reverts for non-owner
 *   • checkOrder creates a pendingFills entry
 *   • fulfillOrder opens a futures position when triggered
 *   • fulfillOrder does nothing (keeps order open) when not triggered
 *   • fulfillOrder reverts for an unknown requestId
 */

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
  LimitOrderBook,
  LimitOrderBook__factory,
} from "../types";

// ── Constants ────────────────────────────────────────────────────────────────

const INITIAL_PRICE = 200_000_000_000n; // $2 000 (8 dec)
const PRICE_ABOVE = 220_000_000_000n; // $2 200 — above initial
const PRICE_BELOW = 180_000_000_000n; // $1 800 — below initial
const DECIMALS_6 = 1_000_000n;
const USER_MINT = 10_000n * DECIMALS_6;
const COLLATERAL_AMT = 1_000n * DECIMALS_6;

// ── Types ────────────────────────────────────────────────────────────────────

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  keeper: HardhatEthersSigner;
};

interface Contracts {
  token: MockConfidentialToken;
  feed: MockPriceFeed;
  oracle: MockOracleIntegration;
  collateral: Collateral;
  positionManager: PositionManager;
  futures: PerpetualFutures;
  lob: LimitOrderBook;
}

// ── Deployment ───────────────────────────────────────────────────────────────

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
  const lob = await new LimitOrderBook__factory(deployer).deploy(
    await collateral.getAddress(),
    await oracle.getAddress(),
    await positionManager.getAddress(),
    await futures.getAddress(),
  );

  // Authorise
  await collateral.authorise(await futures.getAddress());
  await positionManager.authorise(await futures.getAddress());
  await collateral.authorise(await lob.getAddress());
  await positionManager.authorise(await lob.getAddress());

  return { token, feed, oracle, collateral, positionManager, futures, lob };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Place a limit order — encrypts collateral, limit price, and direction in one
 * proof bundle (same contract / user address pair, three inputs).
 */
async function placeLimitOrder(
  lob: LimitOrderBook,
  user: HardhatEthersSigner,
  collateralAmount: bigint,
  limitPrice: bigint,
  isLong: boolean,
  leverage: bigint,
) {
  const lobAddr = await lob.getAddress();
  const input = fhevm.createEncryptedInput(lobAddr, user.address);
  input.add64(collateralAmount);
  input.add64(limitPrice);
  input.addBool(isLong);
  const { handles, inputProof } = await input.encrypt();
  return lob
    .connect(user)
    .placeLimitOrder(handles[0], handles[1], handles[2], inputProof, leverage);
}

async function doFulfillOrder(
  lob: LimitOrderBook,
  requestId: bigint,
  caller: HardhatEthersSigner,
) {
  const pending = await lob.pendingFills(requestId);
  const result = await fhevm.publicDecrypt([
    pending.triggeredHandle,
    pending.collateralHandle,
    pending.limitPriceHandle,
    pending.isLongHandle,
  ]);
  return lob
    .connect(caller)
    .fulfillOrder(
      requestId,
      result.abiEncodedClearValues,
      result.decryptionProof,
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LimitOrderBook", function () {
  let signers: Signers;
  let c: Contracts;

  before(async function () {
    const all = await ethers.getSigners();
    signers = {
      deployer: all[0],
      alice: all[1],
      bob: all[2],
      keeper: all[3],
    };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    c = await deployAll(signers.deployer);
    await mintAndDeposit(c.token, c.collateral, signers.alice, USER_MINT);
    await mintAndDeposit(c.token, c.collateral, signers.bob, USER_MINT);
  });

  // ── Place order ────────────────────────────────────────────────────────────

  describe("placeLimitOrder", function () {
    it("emits LimitOrderPlaced and assigns orderId starting from 1", async function () {
      await expect(
        placeLimitOrder(
          c.lob,
          signers.alice,
          COLLATERAL_AMT,
          PRICE_ABOVE,
          true,
          2n,
        ),
      )
        .to.emit(c.lob, "LimitOrderPlaced")
        .withArgs(signers.alice.address, 1n, 2n);
    });

    it("stores the order as open", async function () {
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      const order = await c.lob.limitOrders(1n);
      expect(order.user).to.equal(signers.alice.address);
      expect(order.isOpen).to.be.true;
      expect(order.leverage).to.equal(2n);
    });

    it("locks collateral immediately (alice balance decreases)", async function () {
      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await c.collateral.connect(signers.alice).getMyCollateral(),
        await c.collateral.getAddress(),
        signers.alice,
      );
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await c.collateral.connect(signers.alice).getMyCollateral(),
        await c.collateral.getAddress(),
        signers.alice,
      );
      expect(balAfter).to.equal(balBefore - COLLATERAL_AMT);
    });

    it("reverts for leverage 0", async function () {
      await expect(
        placeLimitOrder(
          c.lob,
          signers.alice,
          COLLATERAL_AMT,
          PRICE_ABOVE,
          true,
          0n,
        ),
      ).to.be.revertedWith("Invalid leverage");
    });

    it("reverts for leverage > 10", async function () {
      await expect(
        placeLimitOrder(
          c.lob,
          signers.alice,
          COLLATERAL_AMT,
          PRICE_ABOVE,
          true,
          11n,
        ),
      ).to.be.revertedWith("Invalid leverage");
    });
  });

  // ── Cancel order ───────────────────────────────────────────────────────────

  describe("cancelOrder", function () {
    it("emits LimitOrderCancelled and marks order closed", async function () {
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      await expect(c.lob.connect(signers.alice).cancelOrder(1n))
        .to.emit(c.lob, "LimitOrderCancelled")
        .withArgs(signers.alice.address, 1n);
      const order = await c.lob.limitOrders(1n);
      expect(order.isOpen).to.be.false;
    });

    it("returns collateral to the user", async function () {
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      const balBefore = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await c.collateral.connect(signers.alice).getMyCollateral(),
        await c.collateral.getAddress(),
        signers.alice,
      );
      await c.lob.connect(signers.alice).cancelOrder(1n);
      const balAfter = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await c.collateral.connect(signers.alice).getMyCollateral(),
        await c.collateral.getAddress(),
        signers.alice,
      );
      expect(balAfter).to.equal(balBefore + COLLATERAL_AMT);
    });

    it("reverts when non-owner tries to cancel", async function () {
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      await expect(
        c.lob.connect(signers.bob).cancelOrder(1n),
      ).to.be.revertedWith("Not your order");
    });

    it("reverts when cancelling an already-closed order", async function () {
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      await c.lob.connect(signers.alice).cancelOrder(1n);
      await expect(
        c.lob.connect(signers.alice).cancelOrder(1n),
      ).to.be.revertedWith("Order not open");
    });
  });

  // ── checkOrder ─────────────────────────────────────────────────────────────

  describe("checkOrder", function () {
    it("creates a pendingFills entry", async function () {
      // Long limit at $2 200 — current is $2 000. Condition: price ≤ $2 200 → fires immediately
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      await expect(c.lob.connect(signers.keeper).checkOrder(1n))
        .to.emit(c.lob, "FillCheckRequested")
        .withArgs(1n, 1n);
      const pending = await c.lob.pendingFills(1n);
      expect(pending.orderId).to.equal(1n);
    });

    it("reverts when order is not open", async function () {
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      await c.lob.connect(signers.alice).cancelOrder(1n);
      await expect(
        c.lob.connect(signers.keeper).checkOrder(1n),
      ).to.be.revertedWith("Order not open");
    });
  });

  // ── fulfillOrder ──────────────────────────────────────────────────────────

  describe("fulfillOrder — buy limit (long)", function () {
    it("opens a futures position when the limit condition fires", async function () {
      // Long limit at $2 200: condition = price ≤ $2 200
      // Current price = $2 000 ≤ $2 200 → triggered = true
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      const checkTx = await c.lob.connect(signers.keeper).checkOrder(1n);
      const receipt = await checkTx.wait();
      const ev = receipt!.logs.find(
        (l) =>
          c.lob.interface.parseLog(l as any)?.name === "FillCheckRequested",
      );
      const requestId = c.lob.interface.parseLog(ev as any)!.args[1] as bigint;

      await expect(doFulfillOrder(c.lob, requestId, signers.keeper))
        .to.emit(c.lob, "LimitOrderFilled")
        .withArgs(signers.alice.address, 1n, INITIAL_PRICE, 0n);
    });

    it("does not fill when limit condition is NOT met", async function () {
      // Long limit at $1 800: condition = price ≤ $1 800
      // Current price = $2 000 > $1 800 → triggered = false
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_BELOW,
        true,
        2n,
      );
      const checkTx = await c.lob.connect(signers.keeper).checkOrder(1n);
      const receipt = await checkTx.wait();
      const ev = receipt!.logs.find(
        (l) =>
          c.lob.interface.parseLog(l as any)?.name === "FillCheckRequested",
      );
      const requestId = c.lob.interface.parseLog(ev as any)!.args[1] as bigint;

      const tx = doFulfillOrder(c.lob, requestId, signers.keeper);
      await expect(tx).to.emit(c.lob, "LimitOrderExpired").withArgs(1n);
      await expect(tx).not.to.emit(c.lob, "LimitOrderFilled");

      // Order should still be open
      const order = await c.lob.limitOrders(1n);
      expect(order.isOpen).to.be.true;
    });
  });

  describe("fulfillOrder — sell limit (short)", function () {
    it("opens a short position when price is at or above limit", async function () {
      // Short limit at $1 800: condition = price ≥ $1 800
      // Current price = $2 000 ≥ $1 800 → triggered = true
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_BELOW,
        false,
        2n,
      );
      const checkTx = await c.lob.connect(signers.keeper).checkOrder(1n);
      const receipt = await checkTx.wait();
      const ev = receipt!.logs.find(
        (l) =>
          c.lob.interface.parseLog(l as any)?.name === "FillCheckRequested",
      );
      const requestId = c.lob.interface.parseLog(ev as any)!.args[1] as bigint;

      await expect(doFulfillOrder(c.lob, requestId, signers.keeper))
        .to.emit(c.lob, "LimitOrderFilled")
        .withArgs(signers.alice.address, 1n, INITIAL_PRICE, 0n);
    });
  });

  describe("fulfillOrder — edge cases", function () {
    it("reverts for an unknown requestId", async function () {
      // Craft a fake fulfill call (no prior checkOrder)
      await expect(
        c.lob.connect(signers.keeper).fulfillOrder(999n, "0x", "0x"),
      ).to.be.revertedWith("Unknown request");
    });

    it("second fill on same request reverts (already deleted)", async function () {
      await placeLimitOrder(
        c.lob,
        signers.alice,
        COLLATERAL_AMT,
        PRICE_ABOVE,
        true,
        2n,
      );
      const checkTx = await c.lob.connect(signers.keeper).checkOrder(1n);
      const receipt = await checkTx.wait();
      const ev = receipt!.logs.find(
        (l) =>
          c.lob.interface.parseLog(l as any)?.name === "FillCheckRequested",
      );
      const requestId = c.lob.interface.parseLog(ev as any)!.args[1] as bigint;
      await doFulfillOrder(c.lob, requestId, signers.keeper);
      // Second call on same requestId should revert — pendingFills entry was deleted
      await expect(
        c.lob.connect(signers.keeper).fulfillOrder(requestId, "0x", "0x"),
      ).to.be.revertedWith("Unknown request");
    });
  });
});
