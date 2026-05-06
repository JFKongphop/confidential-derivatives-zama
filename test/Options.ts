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
  OptionsPool,
  OptionsPool__factory,
  PositionManager,
  PositionManager__factory,
} from "../types";

// ── Constants ────────────────────────────────────────────────────────────────

const PRICE_2000  = 200_000_000_000n; // $2000 (8 dec)
const PRICE_2500  = 250_000_000_000n; // $2500
const PRICE_1500  = 150_000_000_000n; // $1500
const STRIKE_2000 = 200_000_000_000n; // ATM strike
const STRIKE_2200 = 220_000_000_000n; // OTM call strike
const STRIKE_1800 = 180_000_000_000n; // OTM put strike
const INVALID_STRIKE = 190_000_000_000n; // Not in allowed set
const DECIMALS_6  = 1_000_000n;      // 1 USDC (6 dec)
const USER_MINT   = 50_000n * DECIMALS_6;
const OPTION_SIZE = 1n * DECIMALS_6; // 1 unit (6 dec)

type Signers = {
  deployer: HardhatEthersSigner;
  writer:   HardhatEthersSigner;
  buyer:    HardhatEthersSigner;
};

interface Contracts {
  token:           MockERC20;
  feed:            MockPriceFeed;
  oracle:          OracleIntegration;
  collateral:      Collateral;
  positionManager: PositionManager;
  options:         OptionsPool;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function deployAll(deployer: HardhatEthersSigner): Promise<Contracts> {
  const token           = await new MockERC20__factory(deployer).deploy("Mock USDC", "USDC", 6);
  const feed            = await new MockPriceFeed__factory(deployer).deploy(PRICE_2000);
  const oracle          = await new OracleIntegration__factory(deployer).deploy(await feed.getAddress());
  const collateral      = await new Collateral__factory(deployer).deploy(await token.getAddress());
  const positionManager = await new PositionManager__factory(deployer).deploy();
  const options         = await new OptionsPool__factory(deployer).deploy(
    await collateral.getAddress(),
    await oracle.getAddress(),
    await positionManager.getAddress(),
  );

  await collateral.authorise(await options.getAddress());
  await positionManager.authorise(await options.getAddress());

  return { token, feed, oracle, collateral, positionManager, options };
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

describe("OptionsPool", function () {
  let signers: Signers;
  let c: Contracts;
  let collateralAddr: string;

  before(async function () {
    const all = await ethers.getSigners();
    signers = { deployer: all[0], writer: all[1], buyer: all[2] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) {
      this.skip();
    }
    c = await deployAll(signers.deployer);
    collateralAddr = await c.collateral.getAddress();

    await mintAndDeposit(c.token, c.collateral, signers.writer, USER_MINT);
    await mintAndDeposit(c.token, c.collateral, signers.buyer,  USER_MINT);
  });

  // ── Suite 1: Option Minting ───────────────────────────────────────────────

  describe("Option Minting", function () {
    it("writer can mint a call option and OptionMinted is emitted", async function () {
      await expect(
        c.options.connect(signers.writer).mintOption(true, STRIKE_2000, OPTION_SIZE),
      )
        .to.emit(c.options, "OptionMinted")
        .withArgs(
          1n,                          // first tokenId
          signers.writer.address,
          true,                        // isCall
          STRIKE_2000,
          (v: bigint) => v > 0n,       // expiryTime > 0
          (v: bigint) => v > 0n,       // premium > 0
        );
    });

    it("writer can mint a put option", async function () {
      await expect(
        c.options.connect(signers.writer).mintOption(false, STRIKE_2000, OPTION_SIZE),
      )
        .to.emit(c.options, "OptionMinted")
        .withArgs(1n, signers.writer.address, false, STRIKE_2000, (v: bigint) => v > 0n, (v: bigint) => v > 0n);
    });

    it("rejects invalid strike price", async function () {
      await expect(
        c.options.connect(signers.writer).mintOption(true, INVALID_STRIKE, OPTION_SIZE),
      ).to.be.revertedWith("Invalid strike");
    });

    it("rejects zero size", async function () {
      await expect(
        c.options.connect(signers.writer).mintOption(true, STRIKE_2000, 0n),
      ).to.be.revertedWith("Invalid size");
    });

    it("ATM call premium is approximately 4% of spot", async function () {
      const tx      = await c.options.connect(signers.writer).mintOption(true, STRIKE_2000, OPTION_SIZE);
      const receipt = await tx.wait();
      const event   = receipt!.logs
        .map((l) => c.options.interface.parseLog(l))
        .find((e) => e?.name === "OptionMinted");

      const premium = event!.args.premiumPerContract as bigint;
      // 4% of $2000 (8 dec) = 8_000_000_00
      const expectedApprox = (PRICE_2000 * 400n) / 10_000n;
      expect(premium).to.equal(expectedApprox);
    });

    it("expiry is set to 7 days from block timestamp", async function () {
      const tx      = await c.options.connect(signers.writer).mintOption(true, STRIKE_2000, OPTION_SIZE);
      const receipt = await tx.wait();
      const block   = await ethers.provider.getBlock(receipt!.blockNumber);
      const event   = receipt!.logs
        .map((l) => c.options.interface.parseLog(l))
        .find((e) => e?.name === "OptionMinted");

      const expiryTime = event!.args.expiryTime as bigint;
      const sevenDays  = 7n * 24n * 60n * 60n;
      expect(expiryTime).to.equal(BigInt(block!.timestamp) + sevenDays);
    });

    it("writer collateral decreases after minting", async function () {
      const encBefore = await c.collateral.connect(signers.writer).getMyCollateral();
      const before    = await fhevm.userDecryptEuint(FhevmType.euint64, encBefore, collateralAddr, signers.writer);

      await c.options.connect(signers.writer).mintOption(true, STRIKE_2000, OPTION_SIZE);

      const encAfter = await c.collateral.connect(signers.writer).getMyCollateral();
      const after    = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, collateralAddr, signers.writer);

      expect(after).to.be.lessThan(before);
    });
  });

  // ── Suite 2: Option Buying ────────────────────────────────────────────────

  describe("Option Buying", function () {
    let tokenId: bigint;

    beforeEach(async function () {
      const tx      = await c.options.connect(signers.writer).mintOption(true, STRIKE_2000, OPTION_SIZE);
      const receipt = await tx.wait();
      const event   = receipt!.logs
        .map((l) => c.options.interface.parseLog(l))
        .find((e) => e?.name === "OptionMinted");
      tokenId = event!.args.tokenId;
    });

    it("buyer can buy a minted option and OptionBought is emitted", async function () {
      await expect(
        c.options.connect(signers.buyer).buyOption(tokenId),
      )
        .to.emit(c.options, "OptionBought")
        .withArgs(tokenId, signers.buyer.address, (v: bigint) => v >= 0n);
    });

    it("premium is deducted from buyer collateral", async function () {
      const encBefore = await c.collateral.connect(signers.buyer).getMyCollateral();
      const before    = await fhevm.userDecryptEuint(FhevmType.euint64, encBefore, collateralAddr, signers.buyer);

      await c.options.connect(signers.buyer).buyOption(tokenId);

      const encAfter = await c.collateral.connect(signers.buyer).getMyCollateral();
      const after    = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, collateralAddr, signers.buyer);

      expect(after).to.be.lessThan(before);
    });

    it("writer collateral increases by premium after sale", async function () {
      const encBefore = await c.collateral.connect(signers.writer).getMyCollateral();
      const before    = await fhevm.userDecryptEuint(FhevmType.euint64, encBefore, collateralAddr, signers.writer);

      await c.options.connect(signers.buyer).buyOption(tokenId);

      const encAfter = await c.collateral.connect(signers.writer).getMyCollateral();
      const after    = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, collateralAddr, signers.writer);

      expect(after).to.be.greaterThan(before);
    });

    it("cannot buy an expired option", async function () {
      // Fast-forward time past expiry (7 days + 1 second)
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        c.options.connect(signers.buyer).buyOption(tokenId),
      ).to.be.revertedWith("Option expired");
    });

    it("writer cannot buy their own option", async function () {
      await expect(
        c.options.connect(signers.writer).buyOption(tokenId),
      ).to.be.revertedWith("Writer cannot buy own option");
    });
  });

  // ── Suite 3: Option Exercise ──────────────────────────────────────────────

  describe("Option Exercise", function () {
    let callTokenId: bigint;
    let putTokenId:  bigint;

    beforeEach(async function () {
      // Mint and buy a call at strike $2000
      let tx      = await c.options.connect(signers.writer).mintOption(true, STRIKE_2000, OPTION_SIZE);
      let receipt = await tx.wait();
      let event   = receipt!.logs
        .map((l) => c.options.interface.parseLog(l))
        .find((e) => e?.name === "OptionMinted");
      callTokenId = event!.args.tokenId;
      await c.options.connect(signers.buyer).buyOption(callTokenId);

      // Mint and buy a put at strike $2000
      tx      = await c.options.connect(signers.writer).mintOption(false, STRIKE_2000, OPTION_SIZE);
      receipt = await tx.wait();
      event   = receipt!.logs
        .map((l) => c.options.interface.parseLog(l))
        .find((e) => e?.name === "OptionMinted");
      putTokenId = event!.args.tokenId;
      await c.options.connect(signers.buyer).buyOption(putTokenId);
    });

    it("buyer can exercise ITM call (price up) and receives settlement", async function () {
      await c.feed.setPrice(PRICE_2500);

      const encBefore = await c.collateral.connect(signers.buyer).getMyCollateral();
      const before    = await fhevm.userDecryptEuint(FhevmType.euint64, encBefore, collateralAddr, signers.buyer);

      await c.options.connect(signers.buyer).exerciseOption(callTokenId);
      await fhevm.awaitDecryptionOracle(); // oracle auto-calls fulfillExercise

      const encAfter = await c.collateral.connect(signers.buyer).getMyCollateral();
      const after    = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, collateralAddr, signers.buyer);
      expect(after).to.be.greaterThan(before);
    });

    it("buyer can exercise ITM put (price down) and receives settlement", async function () {
      await c.feed.setPrice(PRICE_1500);

      const encBefore = await c.collateral.connect(signers.buyer).getMyCollateral();
      const before    = await fhevm.userDecryptEuint(FhevmType.euint64, encBefore, collateralAddr, signers.buyer);

      await c.options.connect(signers.buyer).exerciseOption(putTokenId);
      await fhevm.awaitDecryptionOracle();

      const encAfter = await c.collateral.connect(signers.buyer).getMyCollateral();
      const after    = await fhevm.userDecryptEuint(FhevmType.euint64, encAfter, collateralAddr, signers.buyer);
      expect(after).to.be.greaterThan(before);
    });

    it("emits ExerciseRequested when exercising ITM call", async function () {
      await c.feed.setPrice(PRICE_2500);
      await expect(
        c.options.connect(signers.buyer).exerciseOption(callTokenId),
      ).to.emit(c.options, "ExerciseRequested");
    });

    it("emits ExerciseRequested when exercising ITM put", async function () {
      await c.feed.setPrice(PRICE_1500);
      await expect(
        c.options.connect(signers.buyer).exerciseOption(putTokenId),
      ).to.emit(c.options, "ExerciseRequested");
    });

    it("cannot exercise OTM call (price below strike)", async function () {
      await c.feed.setPrice(PRICE_1500);
      await expect(
        c.options.connect(signers.buyer).exerciseOption(callTokenId),
      ).to.be.revertedWith("Option out of the money");
    });

    it("cannot exercise OTM put (price above strike)", async function () {
      await c.feed.setPrice(PRICE_2500);
      await expect(
        c.options.connect(signers.buyer).exerciseOption(putTokenId),
      ).to.be.revertedWith("Option out of the money");
    });

    it("cannot exercise expired option", async function () {
      await c.feed.setPrice(PRICE_2500);
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        c.options.connect(signers.buyer).exerciseOption(callTokenId),
      ).to.be.revertedWith("Option expired");
    });

    it("option is removed from PositionManager after exercise", async function () {
      await c.feed.setPrice(PRICE_2500);
      await c.options.connect(signers.buyer).exerciseOption(callTokenId);
      await fhevm.awaitDecryptionOracle();

      await expect(
        c.positionManager.getOptionPosition(callTokenId),
      ).to.be.revertedWith("Option not open");
    });

    it("expireOption removes an expired option and emits OptionExpired", async function () {
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        c.options.expireOption(callTokenId),
      ).to.emit(c.options, "OptionExpired").withArgs(callTokenId);

      await expect(
        c.positionManager.getOptionPosition(callTokenId),
      ).to.be.revertedWith("Option not open");
    });
  });
});
