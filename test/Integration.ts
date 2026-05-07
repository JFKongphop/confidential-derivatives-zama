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
  OptionsPool,
  OptionsPool__factory,
  PerpetualFutures,
  PerpetualFutures__factory,
  PositionManager,
  PositionManager__factory,
} from "../types";

// ── Constants ────────────────────────────────────────────────────────────────

const PRICE_2000 = 200_000_000_000n;
const PRICE_2500 = 250_000_000_000n;
const PRICE_1500 = 150_000_000_000n;
const STRIKE_2000 = 200_000_000_000n;
const DECIMALS_6 = 1_000_000n;
const USER_MINT = 50_000n * DECIMALS_6;
const OPTION_SIZE = 1n * DECIMALS_6;
const MARGIN = 2_000n * DECIMALS_6;

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  liquidator: HardhatEthersSigner;
};

interface Suite {
  token: MockConfidentialToken;
  feed: MockPriceFeed;
  collateral: Collateral;
  positionManager: PositionManager;
  futures: PerpetualFutures;
  options: OptionsPool;
}

async function deployAll(deployer: HardhatEthersSigner): Promise<Suite> {
  const token = await new MockConfidentialToken__factory(deployer).deploy();
  const feed = await new MockPriceFeed__factory(deployer).deploy(PRICE_2000);
  const oracle = await new OracleIntegration__factory(deployer).deploy(
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
  const options = await new OptionsPool__factory(deployer).deploy(
    await collateral.getAddress(),
    await oracle.getAddress(),
    await positionManager.getAddress(),
  );

  // Authorise both protocol contracts
  await collateral.authorise(await futures.getAddress());
  await collateral.authorise(await options.getAddress());
  await positionManager.authorise(await futures.getAddress());
  await positionManager.authorise(await options.getAddress());

  return { token, feed, collateral, positionManager, futures, options };
}

async function mintAndDeposit(
  token: MockConfidentialToken,
  collateral: Collateral,
  user: HardhatEthersSigner,
  amount: bigint,
) {
  const collateralAddr = await collateral.getAddress();
  const tokenAddr = await token.getAddress();
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

async function doFulfillExercise(
  options: OptionsPool,
  requestId: bigint,
  caller: HardhatEthersSigner,
): Promise<void> {
  const pending = await options.pendingExercises(requestId);
  const result = await fhevm.publicDecrypt([
    pending.itmHandle,
    pending.sizeHandle,
    pending.strikeHandle,
    pending.isCallHandle,
  ]);
  await options
    .connect(caller)
    .fulfillExercise(
      requestId,
      result.abiEncodedClearValues,
      result.decryptionProof,
    );
}

async function getBalance(
  collateral: Collateral,
  user: HardhatEthersSigner,
  collateralAddr: string,
): Promise<bigint> {
  const enc = await collateral.connect(user).getMyCollateral();
  return fhevm.userDecryptEuint(FhevmType.euint64, enc, collateralAddr, user);
}

// ── Integration Test Suite ───────────────────────────────────────────────────

describe("Futures + Options Integration", function () {
  let signers: Signers;
  let s: Suite;
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
    s = await deployAll(signers.deployer);
    collateralAddr = await s.collateral.getAddress();

    // Fund alice, bob, and liquidator
    for (const user of [signers.alice, signers.bob, signers.liquidator]) {
      await mintAndDeposit(s.token, s.collateral, user, USER_MINT);
    }
  });

  // ── Hedge: long futures + protective put ─────────────────────────────────

  it("user hedges long futures position with a put option (crash scenario)", async function () {
    // Alice: writer mints put, bob buys it as insurance on alice's long
    // (simplified: alice opens long, bob writes and alice buys put)
    const writeTx = await s.options
      .connect(signers.bob)
      .mintOption(false, STRIKE_2000, OPTION_SIZE);
    const writeReceipt = await writeTx.wait();
    const writeEvent = writeReceipt!.logs
      .map((l) => s.options.interface.parseLog(l))
      .find((e) => e?.name === "OptionMinted");
    const putTokenId = writeEvent!.args.tokenId;

    // Alice opens long futures
    await encryptOpenPosition(s.futures, signers.alice, true, MARGIN, 2n);

    // Alice buys the put from bob as hedge
    await s.options.connect(signers.alice).buyOption(putTokenId);

    // Price crashes to $1500
    await s.feed.setPrice(PRICE_1500);

    const aliceBefore = await getBalance(
      s.collateral,
      signers.alice,
      collateralAddr,
    );

    // Alice closes losing long (returns partial collateral)
    const closeTx = await s.futures.connect(signers.alice).closePosition(0n);
    const closeReceipt = await closeTx.wait();
    const closeEvent = closeReceipt!.logs
      .map((l) => s.futures.interface.parseLog(l))
      .find((e) => e?.name === "PositionCloseRequested");
    await doFulfillClose(s.futures, closeEvent!.args.requestId, signers.alice);

    // Alice exercises ITM put — receives settlement
    const exTx = await s.options
      .connect(signers.alice)
      .exerciseOption(putTokenId);
    const exReceipt = await exTx.wait();
    const exEvent = exReceipt!.logs
      .map((l) => s.options.interface.parseLog(l))
      .find((e) => e?.name === "ExerciseRequested");
    await doFulfillExercise(s.options, exEvent!.args.requestId, signers.alice);

    const aliceAfter = await getBalance(
      s.collateral,
      signers.alice,
      collateralAddr,
    );

    // The put settlement partially offsets the futures loss
    // Net should be more than just the futures loss alone
    expect(aliceAfter).to.be.greaterThan(aliceBefore);
  });

  // ── Hedge: short futures + protective call ────────────────────────────────

  it("user hedges short futures position with a call option (rally scenario)", async function () {
    // Alice opens short futures
    await encryptOpenPosition(s.futures, signers.alice, false, MARGIN, 2n);

    // Bob writes a call, alice buys it as hedge
    const writeTx = await s.options
      .connect(signers.bob)
      .mintOption(true, STRIKE_2000, OPTION_SIZE);
    const writeReceipt = await writeTx.wait();
    const writeEvent = writeReceipt!.logs
      .map((l) => s.options.interface.parseLog(l))
      .find((e) => e?.name === "OptionMinted");
    const callTokenId = writeEvent!.args.tokenId;
    await s.options.connect(signers.alice).buyOption(callTokenId);

    // Price rallies to $2500 — short loses, call wins
    await s.feed.setPrice(PRICE_2500);

    const aliceBefore = await getBalance(
      s.collateral,
      signers.alice,
      collateralAddr,
    );

    const closeTx = await s.futures.connect(signers.alice).closePosition(0n); // loss on short
    const closeReceipt = await closeTx.wait();
    const closeEvent = closeReceipt!.logs
      .map((l) => s.futures.interface.parseLog(l))
      .find((e) => e?.name === "PositionCloseRequested");
    await doFulfillClose(s.futures, closeEvent!.args.requestId, signers.alice);

    const exTx = await s.options
      .connect(signers.alice)
      .exerciseOption(callTokenId); // gain on call
    const exReceipt = await exTx.wait();
    const exEvent = exReceipt!.logs
      .map((l) => s.options.interface.parseLog(l))
      .find((e) => e?.name === "ExerciseRequested");
    await doFulfillExercise(s.options, exEvent!.args.requestId, signers.alice);

    const aliceAfter = await getBalance(
      s.collateral,
      signers.alice,
      collateralAddr,
    );

    // The call offsets the short futures loss
    expect(aliceAfter).to.be.greaterThan(aliceBefore);
  });

  // ── Multiple users trade simultaneously ──────────────────────────────────

  it("multiple users can open and close positions independently", async function () {
    // Alice: long, Bob: short
    await encryptOpenPosition(s.futures, signers.alice, true, MARGIN, 2n);
    await encryptOpenPosition(s.futures, signers.bob, false, MARGIN, 2n);

    // Price moves up → alice profitable, bob at loss
    await s.feed.setPrice(PRICE_2500);

    const aliceBefore = await getBalance(
      s.collateral,
      signers.alice,
      collateralAddr,
    );

    const closeTx = await s.futures.connect(signers.alice).closePosition(0n);
    const closeReceipt = await closeTx.wait();
    const closeEvent = closeReceipt!.logs
      .map((l) => s.futures.interface.parseLog(l))
      .find((e) => e?.name === "PositionCloseRequested");
    await doFulfillClose(s.futures, closeEvent!.args.requestId, signers.alice);
    const aliceAfter = await getBalance(
      s.collateral,
      signers.alice,
      collateralAddr,
    );

    expect(aliceAfter).to.be.greaterThan(aliceBefore); // alice profited

    // Bob can still close (independently)
    const bobCloseTx = await s.futures.connect(signers.bob).closePosition(0n);
    const bobCloseReceipt = await bobCloseTx.wait();
    const bobCloseEvent = bobCloseReceipt!.logs
      .map((l) => s.futures.interface.parseLog(l))
      .find((e) => e?.name === "PositionCloseRequested");
    expect(bobCloseEvent).to.not.be.undefined;
    await doFulfillClose(s.futures, bobCloseEvent!.args.requestId, signers.bob);
  });

  // ── Liquidation doesn't affect other users ────────────────────────────────

  it("liquidating alice does not affect bob's position or collateral", async function () {
    // Alice: 10× leverage long (very exposed)
    await encryptOpenPosition(s.futures, signers.alice, true, MARGIN, 10n);
    // Bob: conservative 2× long
    await encryptOpenPosition(s.futures, signers.bob, true, MARGIN, 2n);

    const bobBefore = await getBalance(
      s.collateral,
      signers.bob,
      collateralAddr,
    );

    // Price crashes — alice is liquidatable
    await s.feed.setPrice(PRICE_1500);
    const liqTx = await s.futures
      .connect(signers.liquidator)
      .liquidatePosition(signers.alice.address, 0n);
    const liqReceipt = await liqTx.wait();
    const liqEvent = liqReceipt!.logs
      .map((l) => s.futures.interface.parseLog(l))
      .find((e) => e?.name === "LiquidationRequested");
    await doFulfillLiquidation(
      s.futures,
      liqEvent!.args.requestId,
      signers.liquidator,
    );

    // Bob's collateral should be unchanged (his position is still open)
    const bobAfter = await getBalance(
      s.collateral,
      signers.bob,
      collateralAddr,
    );
    expect(bobAfter).to.equal(bobBefore);

    // Bob's position still exists
    const bobPos = await s.positionManager.getFuturesPosition(
      signers.bob.address,
      0n,
    );
    expect(bobPos.isOpen).to.be.true;
  });

  // ── Shared vault: deposit once, use for both protocols ───────────────────

  it("one deposit funds both futures and options in the shared vault", async function () {
    // Charlie (alice) uses a single deposit for futures margin and option premium

    // Use some collateral for futures
    await encryptOpenPosition(s.futures, signers.alice, true, MARGIN, 1n);

    // Use remaining for buying an option
    const writeTx = await s.options
      .connect(signers.bob)
      .mintOption(true, STRIKE_2000, OPTION_SIZE);
    const writeReceipt = await writeTx.wait();
    const writeEvent = writeReceipt!.logs
      .map((l) => s.options.interface.parseLog(l))
      .find((e) => e?.name === "OptionMinted");
    const tokenId = writeEvent!.args.tokenId;

    await expect(s.options.connect(signers.alice).buyOption(tokenId)).to.emit(
      s.options,
      "OptionBought",
    );

    // Alice still has a positive encrypted balance
    const aliceBal = await getBalance(
      s.collateral,
      signers.alice,
      collateralAddr,
    );
    expect(aliceBal).to.be.greaterThan(0n);
  });

  // ── OracleIntegration staleness check ────────────────────────────────────

  it("reverts when oracle price is stale (> 1 hour old)", async function () {
    // Advance time by 2 hours without updating the feed
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    await expect(
      encryptOpenPosition(s.futures, signers.alice, true, MARGIN, 1n),
    ).to.be.revertedWith("Price feed stale");
  });
});
