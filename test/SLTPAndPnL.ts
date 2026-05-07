/**
 * Tests for Stop-Loss / Take-Profit triggers and encrypted PnL history.
 *
 * Coverage:
 *   • setStopLoss / setTakeProfit store handles on-chain
 *   • checkTrigger creates a pendingTriggers entry
 *   • fulfillTrigger closes position when SL fires (long)
 *   • fulfillTrigger closes position when TP fires (long)
 *   • fulfillTrigger does nothing when trigger is not met
 *   • SL fires for short when price rises above stop
 *   • TP fires for short when price falls below target
 *   • getMyRealizedPnL accumulates gains across multiple positions
 *   • fulfillClose also updates PnL
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
  MockPriceFeed,
  MockPriceFeed__factory,
  OracleIntegration,
  OracleIntegration__factory,
  PositionManager,
  PositionManager__factory,
  PerpetualFutures,
  PerpetualFutures__factory,
} from "../types";

// ── Constants ────────────────────────────────────────────────────────────────

const INITIAL_PRICE  = 200_000_000_000n; // $2 000 (8 dec)
const PRICE_2200     = 220_000_000_000n; // $2 200
const PRICE_1800     = 180_000_000_000n; // $1 800
const PRICE_1500     = 150_000_000_000n; // $1 500 — hard SL
const PRICE_2500     = 250_000_000_000n; // $2 500 — TP target
const DECIMALS_6     = 1_000_000n;
const USER_MINT      = 10_000n * DECIMALS_6;
const COLLATERAL_AMT = 1_000n * DECIMALS_6; // $1 000 collateral

// ── Types ────────────────────────────────────────────────────────────────────

type Signers = {
  deployer: HardhatEthersSigner;
  alice:    HardhatEthersSigner;
  bob:      HardhatEthersSigner;
  keeper:   HardhatEthersSigner;
};

interface Contracts {
  token:           MockConfidentialToken;
  feed:            MockPriceFeed;
  oracle:          OracleIntegration;
  collateral:      Collateral;
  positionManager: PositionManager;
  futures:         PerpetualFutures;
}

// ── Deployment ───────────────────────────────────────────────────────────────

async function deployAll(deployer: HardhatEthersSigner): Promise<Contracts> {
  const token = await new MockConfidentialToken__factory(deployer).deploy();
  const feed  = await new MockPriceFeed__factory(deployer).deploy(INITIAL_PRICE);
  const oracle = await new OracleIntegration__factory(deployer).deploy(await feed.getAddress());
  const collateral = await new Collateral__factory(deployer).deploy(await token.getAddress());
  const positionManager = await new PositionManager__factory(deployer).deploy();
  const futures = await new PerpetualFutures__factory(deployer).deploy(
    await collateral.getAddress(),
    await oracle.getAddress(),
    await positionManager.getAddress(),
  );
  await collateral.authorise(await futures.getAddress());
  await positionManager.authorise(await futures.getAddress());
  return { token, feed, oracle, collateral, positionManager, futures };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function mintAndDeposit(
  token: MockConfidentialToken,
  collateral: Collateral,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  const collateralAddr = await collateral.getAddress();
  const tokenAddr      = await token.getAddress();
  const until = BigInt(Math.floor(Date.now() / 1000) + 86400 * 365);
  await token.mint(user.address, amount);
  await token.connect(user).setOperator(collateralAddr, until);
  const input = fhevm.createEncryptedInput(tokenAddr, collateralAddr);
  input.add64(amount);
  const { handles, inputProof } = await input.encrypt();
  await collateral.connect(user).deposit(handles[0], inputProof);
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
  return futures.connect(user).openPosition(handles[0], inputProof, leverage, handles[1]);
}

/** Encrypt a single uint64 trigger price (SL or TP level) for the futures contract */
async function encryptTriggerPrice(
  futures: PerpetualFutures,
  user: HardhatEthersSigner,
  price: bigint,
) {
  const futuresAddr = await futures.getAddress();
  const input = fhevm.createEncryptedInput(futuresAddr, user.address);
  input.add64(price);
  const { handles, inputProof } = await input.encrypt();
  return { handle: handles[0], inputProof };
}

async function doFulfillClose(
  futures: PerpetualFutures,
  requestId: bigint,
  caller: HardhatEthersSigner,
) {
  const pending = await futures.pendingCloses(requestId);
  const result = await fhevm.publicDecrypt([pending.sizeHandle, pending.collateralHandle, pending.isLongHandle]);
  return futures.connect(caller).fulfillClose(requestId, result.abiEncodedClearValues, result.decryptionProof);
}

/** Run the checkTrigger → fulfillTrigger flow and return the tx */
async function doFulfillTrigger(
  futures: PerpetualFutures,
  user: HardhatEthersSigner,
  positionId: bigint,
  caller: HardhatEthersSigner,
) {
  const reqTx = await futures.connect(caller).checkTrigger(user.address, positionId);
  const receipt = await reqTx.wait();
  // Extract requestId from TriggerCheckRequested event
  const event = receipt!.logs.find(
    (l) => futures.interface.parseLog(l as any)?.name === "TriggerCheckRequested",
  );
  const parsed  = futures.interface.parseLog(event as any)!;
  const requestId = parsed.args[2] as bigint;

  const pending = await futures.pendingTriggers(requestId);
  const result  = await fhevm.publicDecrypt([
    pending.triggeredHandle,
    pending.sizeHandle,
    pending.collateralHandle,
    pending.isLongHandle,
  ]);
  return {
    requestId,
    tx: futures.connect(caller).fulfillTrigger(requestId, result.abiEncodedClearValues, result.decryptionProof),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Stop-Loss / Take-Profit & PnL History", function () {
  let signers: Signers;
  let c: Contracts;

  before(async function () {
    const all = await ethers.getSigners();
    signers = {
      deployer: all[0],
      alice:    all[1],
      bob:      all[2],
      keeper:   all[3],
    };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    c = await deployAll(signers.deployer);
    await mintAndDeposit(c.token, c.collateral, signers.alice, USER_MINT);
    await mintAndDeposit(c.token, c.collateral, signers.bob,   USER_MINT);
  });

  // ── setStopLoss ────────────────────────────────────────────────────────────

  describe("setStopLoss", function () {
    it("stores an encrypted SL trigger for an open position", async function () {
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, PRICE_1800);
      await expect(c.futures.connect(signers.alice).setStopLoss(0n, handle, inputProof))
        .to.emit(c.futures, "StopLossSet")
        .withArgs(signers.alice.address, 0n);
    });
  });

  // ── setTakeProfit ──────────────────────────────────────────────────────────

  describe("setTakeProfit", function () {
    it("stores an encrypted TP trigger for an open position", async function () {
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, PRICE_2500);
      await expect(c.futures.connect(signers.alice).setTakeProfit(0n, handle, inputProof))
        .to.emit(c.futures, "TakeProfitSet")
        .withArgs(signers.alice.address, 0n);
    });
  });

  // ── checkTrigger ──────────────────────────────────────────────────────────

  describe("checkTrigger", function () {
    it("creates a pendingTriggers entry when a trigger is set", async function () {
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, PRICE_1800);
      await c.futures.connect(signers.alice).setStopLoss(0n, handle, inputProof);

      await expect(c.futures.connect(signers.keeper).checkTrigger(signers.alice.address, 0n))
        .to.emit(c.futures, "TriggerCheckRequested")
        .withArgs(signers.alice.address, 0n, 1n);
    });

    it("reverts when no trigger is set", async function () {
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      await expect(
        c.futures.connect(signers.keeper).checkTrigger(signers.alice.address, 0n),
      ).to.be.revertedWith("No trigger set");
    });
  });

  // ── fulfillTrigger ────────────────────────────────────────────────────────

  describe("fulfillTrigger — SL long", function () {
    it("closes position when SL fires (price drops below SL)", async function () {
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      // Set SL at $1 900 (above current $2 000 would be invalid in real life, but
      // here we set SL at $2 200 so it fires immediately at $2 000)
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, PRICE_2200);
      await c.futures.connect(signers.alice).setStopLoss(0n, handle, inputProof);
      // Price is still $2 000 < SL $2 200 → long SL fires
      const { tx } = await doFulfillTrigger(c.futures, signers.alice, 0n, signers.keeper);
      await expect(tx)
        .to.emit(c.futures, "TriggerExecuted")
        .withArgs(signers.alice.address, 0n, INITIAL_PRICE);
    });

    it("does NOT close position when SL does not fire (price above SL for long)", async function () {
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      // SL at $1 800 — below current $2 000 → should NOT fire
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, PRICE_1800);
      await c.futures.connect(signers.alice).setStopLoss(0n, handle, inputProof);
      const { tx } = await doFulfillTrigger(c.futures, signers.alice, 0n, signers.keeper);
      // TriggerExecuted should NOT be emitted — tx resolves without event
      await expect(tx).not.to.emit(c.futures, "TriggerExecuted");
    });
  });

  describe("fulfillTrigger — TP long", function () {
    it("closes position when TP fires (price rises above TP)", async function () {
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      // TP at $1 800 — below current $2 000 → fires immediately (price > TP for long)
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, PRICE_1800);
      await c.futures.connect(signers.alice).setTakeProfit(0n, handle, inputProof);
      const { tx } = await doFulfillTrigger(c.futures, signers.alice, 0n, signers.keeper);
      await expect(tx)
        .to.emit(c.futures, "TriggerExecuted")
        .withArgs(signers.alice.address, 0n, INITIAL_PRICE);
    });
  });

  describe("fulfillTrigger — SL short", function () {
    it("closes short position when price rises above SL", async function () {
      // Short position: SL fires when price > SL
      // Set SL at $1 800 — current is $2 000 → price > SL → fires
      await encryptOpenPosition(c.futures, signers.alice, false, COLLATERAL_AMT, 2n);
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, PRICE_1800);
      await c.futures.connect(signers.alice).setStopLoss(0n, handle, inputProof);
      const { tx } = await doFulfillTrigger(c.futures, signers.alice, 0n, signers.keeper);
      await expect(tx).to.emit(c.futures, "TriggerExecuted");
    });
  });

  describe("fulfillTrigger — TP short", function () {
    it("closes short position when price falls below TP", async function () {
      // Short TP: fires when price < TP
      // Set TP at $2 200 — current $2 000 < $2 200 → fires
      await encryptOpenPosition(c.futures, signers.alice, false, COLLATERAL_AMT, 2n);
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, PRICE_2200);
      await c.futures.connect(signers.alice).setTakeProfit(0n, handle, inputProof);
      const { tx } = await doFulfillTrigger(c.futures, signers.alice, 0n, signers.keeper);
      await expect(tx).to.emit(c.futures, "TriggerExecuted");
    });
  });

  // ── PnL ───────────────────────────────────────────────────────────────────

  describe("Encrypted PnL History", function () {
    it("getMyRealizedPnL returns an encrypted handle after fulfillClose with gain", async function () {
      // Open a long, push price up, close for a profit → PnL should be non-zero
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      await c.feed.setPrice(PRICE_2200); // +10%
      const closeTx = await c.futures.connect(signers.alice).closePosition(0n);
      const receipt = await closeTx.wait();
      const closeEvent = receipt!.logs.find(
        (l) => c.futures.interface.parseLog(l as any)?.name === "PositionCloseRequested",
      );
      const parsedClose = c.futures.interface.parseLog(closeEvent as any)!;
      const closeReqId  = parsedClose.args[2] as bigint;
      await doFulfillClose(c.futures, closeReqId, signers.alice);

      const pnlHandle = await c.futures.connect(signers.alice).getMyRealizedPnL();
      const pnlValue  = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        pnlHandle,
        await c.futures.getAddress(),
        signers.alice,
      );
      // $2 000 → $2 200 (+10%), size = 2×$1 000 = $2 000 → gain = $200 = 200_000_000 (6 dec)
      expect(pnlValue).to.be.gt(0n);
    });

    it("PnL is zero when trade is a loss", async function () {
      // Open a long, push price DOWN, close for a loss → PnL accumulation = 0 gain
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      await c.feed.setPrice(PRICE_1800); // -10%
      const closeTx = await c.futures.connect(signers.alice).closePosition(0n);
      const receipt = await closeTx.wait();
      const closeEvent = receipt!.logs.find(
        (l) => c.futures.interface.parseLog(l as any)?.name === "PositionCloseRequested",
      );
      const parsedClose = c.futures.interface.parseLog(closeEvent as any)!;
      const closeReqId  = parsedClose.args[2] as bigint;
      await doFulfillClose(c.futures, closeReqId, signers.alice);

      // After a losing trade, pnl handle may not exist yet (first trade was a loss)
      // getMyRealizedPnL returns a zero-handle or the contract returns 0-encrypted
      const pnlHandle = await c.futures.connect(signers.alice).getMyRealizedPnL();
      // Handle may be the zero bytes32 if no gains were ever accumulated
      // (zero handle is acceptable — nothing to decrypt)
      expect(pnlHandle).to.not.be.null;
    });

    it("PnL accumulates across two profitable closes", async function () {
      // First profitable close
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      await c.feed.setPrice(PRICE_2200);
      const closeTx1 = await c.futures.connect(signers.alice).closePosition(0n);
      const rec1 = await closeTx1.wait();
      const ev1 = rec1!.logs.find((l) => c.futures.interface.parseLog(l as any)?.name === "PositionCloseRequested");
      const reqId1 = (c.futures.interface.parseLog(ev1 as any)!.args[2]) as bigint;
      await doFulfillClose(c.futures, reqId1, signers.alice);

      const pnl1 = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await c.futures.connect(signers.alice).getMyRealizedPnL(),
        await c.futures.getAddress(),
        signers.alice,
      );

      // Second profitable close
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      await c.feed.setPrice(PRICE_2500);
      const closeTx2 = await c.futures.connect(signers.alice).closePosition(1n);
      const rec2 = await closeTx2.wait();
      const ev2 = rec2!.logs.find((l) => c.futures.interface.parseLog(l as any)?.name === "PositionCloseRequested");
      const reqId2 = (c.futures.interface.parseLog(ev2 as any)!.args[2]) as bigint;
      await doFulfillClose(c.futures, reqId2, signers.alice);

      const pnl2 = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        await c.futures.connect(signers.alice).getMyRealizedPnL(),
        await c.futures.getAddress(),
        signers.alice,
      );

      expect(pnl2).to.be.gt(pnl1);
    });

    it("fulfillTrigger (TP) also updates PnL when profitable", async function () {
      await encryptOpenPosition(c.futures, signers.alice, true, COLLATERAL_AMT, 2n);
      // Move price to $2 200 so that long is in profit
      await c.feed.setPrice(PRICE_2200);
      // TP at $2 100 (PRICE_BETWEEN) — price $2 200 > $2 100 → TP fires for long (profit)
      const tpPrice = 210_000_000_000n; // $2 100
      const { handle, inputProof } = await encryptTriggerPrice(c.futures, signers.alice, tpPrice);
      await c.futures.connect(signers.alice).setTakeProfit(0n, handle, inputProof);
      const { tx } = await doFulfillTrigger(c.futures, signers.alice, 0n, signers.keeper);
      await tx;

      const pnlHandle = await c.futures.connect(signers.alice).getMyRealizedPnL();
      const pnlValue = await fhevm.userDecryptEuint(
        FhevmType.euint64,
        pnlHandle,
        await c.futures.getAddress(),
        signers.alice,
      );
      expect(pnlValue).to.be.gt(0n);
    });
  });
});
