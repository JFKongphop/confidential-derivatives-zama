import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, fhevm } from "hardhat";
import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { FhevmType } from "@fhevm/hardhat-plugin";
import {
  Collateral,
  Collateral__factory,
  MockConfidentialToken,
  MockConfidentialToken__factory,
} from "../types";

// ── Constants ────────────────────────────────────────────────────────────────

const DECIMALS_6 = 1_000_000n; // 1 USDC
const USER_MINT = 10_000n * DECIMALS_6; // 10 000 USDC

type Signers = {
  deployer: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  carol: HardhatEthersSigner;
};

interface Contracts {
  token: MockConfidentialToken;
  collateral: Collateral;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function deploy(deployer: HardhatEthersSigner): Promise<Contracts> {
  const token = await new MockConfidentialToken__factory(deployer).deploy();
  const collateral = await new Collateral__factory(deployer).deploy(
    await token.getAddress(),
  );
  return { token, collateral };
}

/// Mint tokens, approve Collateral as operator, create encrypted input, deposit.
async function mintAndDeposit(
  token: MockConfidentialToken,
  collateral: Collateral,
  user: HardhatEthersSigner,
  amount: bigint,
): Promise<void> {
  const collateralAddr = await collateral.getAddress();
  const tokenAddr = await token.getAddress();

  // Mint plain tokens to user (MockConfidentialToken.mint wraps in FHE.asEuint64)
  await token.connect(user).mint(user.address, amount);

  // Approve Collateral as operator so it can call confidentialTransferFrom
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400); // +24 h
  await token.connect(user).setOperator(collateralAddr, expiry);

  // Create encrypted input off-chain and deposit
  // contractAddr = token (InputVerifier checks msg.sender in token = Collateral... no: FHEVMExecutor.msg.sender = token)
  const input = fhevm.createEncryptedInput(tokenAddr, collateralAddr);
  input.add64(amount);
  const { handles, inputProof } = await input.encrypt();
  await collateral.connect(user).deposit(handles[0], inputProof);
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

/// Decrypt a user's encrypted collateral balance.
async function getBalance(
  collateral: Collateral,
  user: HardhatEthersSigner,
  collateralAddr: string,
): Promise<bigint> {
  const enc = await collateral.connect(user).getMyCollateral();
  return fhevm.userDecryptEuint(FhevmType.euint64, enc, collateralAddr, user);
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Collateral (ERC-7984)", function () {
  let signers: Signers;
  let c: Contracts;
  let collateralAddr: string;

  before(async function () {
    const all = await ethers.getSigners();
    signers = { deployer: all[0], alice: all[1], bob: all[2], carol: all[3] };
  });

  beforeEach(async function () {
    if (!fhevm.isMock) this.skip();
    c = await deploy(signers.deployer);
    collateralAddr = await c.collateral.getAddress();
  });

  // ── Deployment ─────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("token address is set correctly", async function () {
      expect(await c.collateral.token()).to.equal(await c.token.getAddress());
    });

    it("deployer is the owner", async function () {
      expect(await c.collateral.owner()).to.equal(signers.deployer.address);
    });
  });

  // ── Deposit ────────────────────────────────────────────────────────────

  describe("Deposit", function () {
    it("emits Deposit event", async function () {
      const collateralAddr = await c.collateral.getAddress();
      const tokenAddr = await c.token.getAddress();
      await c.token
        .connect(signers.alice)
        .mint(signers.alice.address, USER_MINT);
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 86_400);
      await c.token.connect(signers.alice).setOperator(collateralAddr, expiry);

      const input = fhevm.createEncryptedInput(tokenAddr, collateralAddr);
      input.add64(USER_MINT);
      const { handles, inputProof } = await input.encrypt();

      await expect(
        c.collateral.connect(signers.alice).deposit(handles[0], inputProof),
      )
        .to.emit(c.collateral, "Deposit")
        .withArgs(signers.alice.address, anyValue);
    });

    it("encrypted balance increases after deposit", async function () {
      await mintAndDeposit(c.token, c.collateral, signers.alice, USER_MINT);
      const balance = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      expect(balance).to.equal(USER_MINT);
    });

    it("two deposits accumulate correctly", async function () {
      const first = 3_000n * DECIMALS_6;
      const second = 2_000n * DECIMALS_6;

      await mintAndDeposit(c.token, c.collateral, signers.alice, first);
      await mintAndDeposit(c.token, c.collateral, signers.alice, second);

      const balance = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      expect(balance).to.equal(first + second);
    });

    it("multiple users have independent encrypted balances", async function () {
      await mintAndDeposit(c.token, c.collateral, signers.alice, USER_MINT);
      await mintAndDeposit(
        c.token,
        c.collateral,
        signers.bob,
        5_000n * DECIMALS_6,
      );

      const [balA, balB] = await Promise.all([
        getBalance(c.collateral, signers.alice, collateralAddr),
        getBalance(c.collateral, signers.bob, collateralAddr),
      ]);
      expect(balA).to.equal(USER_MINT);
      expect(balB).to.equal(5_000n * DECIMALS_6);
    });

    it("reverts when Collateral is not set as operator", async function () {
      await c.token
        .connect(signers.alice)
        .mint(signers.alice.address, USER_MINT);
      // No setOperator call

      const input = fhevm.createEncryptedInput(
        collateralAddr,
        signers.alice.address,
      );
      input.add64(USER_MINT);
      const { handles, inputProof } = await input.encrypt();

      await expect(
        c.collateral.connect(signers.alice).deposit(handles[0], inputProof),
      ).to.be.reverted; // ERC7984UnauthorizedSpender
    });
  });

  // ── Withdraw ───────────────────────────────────────────────────────────

  describe("Withdraw", function () {
    const DEPOSIT = 5_000n * DECIMALS_6;

    beforeEach(async function () {
      await mintAndDeposit(c.token, c.collateral, signers.alice, DEPOSIT);
    });

    it("emits Withdraw event", async function () {
      const withdrawAmt = 1_000n * DECIMALS_6;
      await expect(encryptWithdraw(c.collateral, signers.alice, withdrawAmt))
        .to.emit(c.collateral, "Withdraw")
        .withArgs(signers.alice.address, anyValue);
    });

    it("encrypted balance decreases after withdraw", async function () {
      const withdrawAmt = 1_000n * DECIMALS_6;
      const before = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );

      await encryptWithdraw(c.collateral, signers.alice, withdrawAmt);

      const after = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      expect(after).to.equal(before - withdrawAmt);
    });

    it("withdrawing full balance leaves zero", async function () {
      await encryptWithdraw(c.collateral, signers.alice, DEPOSIT);
      const after = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      expect(after).to.equal(0n);
    });

    it("withdraw more than balance clamps to available balance (FHE.select)", async function () {
      const overRequest = DEPOSIT * 2n; // 10 000 USDC — more than the 5 000 deposited

      const before = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      await encryptWithdraw(c.collateral, signers.alice, overRequest);
      const after = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );

      // Entire balance was transferred — remainder is 0
      expect(after).to.equal(0n);
      // before was DEPOSIT
      expect(before).to.equal(DEPOSIT);
    });

    it("repeated partial withdraws reduce balance correctly", async function () {
      const chunk = 1_000n * DECIMALS_6;
      await encryptWithdraw(c.collateral, signers.alice, chunk);
      await encryptWithdraw(c.collateral, signers.alice, chunk);
      const after = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      expect(after).to.equal(DEPOSIT - chunk * 2n);
    });
  });

  // ── Protocol helpers (authorised contracts only) ───────────────────────

  describe("Protocol Helpers", function () {
    const DEPOSIT = 5_000n * DECIMALS_6;

    beforeEach(async function () {
      await mintAndDeposit(c.token, c.collateral, signers.alice, DEPOSIT);
      await mintAndDeposit(c.token, c.collateral, signers.bob, DEPOSIT);
    });

    it("increaseCollateral adds to user balance (authorised caller)", async function () {
      const bonus = 500n * DECIMALS_6;
      await c.collateral
        .connect(signers.deployer)
        .increaseCollateral(signers.alice.address, bonus);
      const after = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      expect(after).to.equal(DEPOSIT + bonus);
    });

    it("decreaseCollateral subtracts from user balance (authorised caller)", async function () {
      const fee = 200n * DECIMALS_6;
      await c.collateral
        .connect(signers.deployer)
        .decreaseCollateral(signers.alice.address, fee);
      const after = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      expect(after).to.equal(DEPOSIT - fee);
    });

    it("transferCollateral moves funds between users", async function () {
      const amount = 1_000n * DECIMALS_6;
      await c.collateral
        .connect(signers.deployer)
        .transferCollateral(signers.alice.address, signers.bob.address, amount);

      const [balA, balB] = await Promise.all([
        getBalance(c.collateral, signers.alice, collateralAddr),
        getBalance(c.collateral, signers.bob, collateralAddr),
      ]);
      expect(balA).to.equal(DEPOSIT - amount);
      expect(balB).to.equal(DEPOSIT + amount);
    });

    it("increaseCollateral reverts for unauthorised caller", async function () {
      await expect(
        c.collateral
          .connect(signers.alice)
          .increaseCollateral(signers.alice.address, 100n),
      ).to.be.revertedWith("Not authorised");
    });

    it("decreaseCollateral reverts for unauthorised caller", async function () {
      await expect(
        c.collateral
          .connect(signers.alice)
          .decreaseCollateral(signers.alice.address, 100n),
      ).to.be.revertedWith("Not authorised");
    });

    it("transferCollateral reverts for unauthorised caller", async function () {
      await expect(
        c.collateral
          .connect(signers.alice)
          .transferCollateral(signers.alice.address, signers.bob.address, 100n),
      ).to.be.revertedWith("Not authorised");
    });
  });

  // ── Authorise ──────────────────────────────────────────────────────────

  describe("Authorise", function () {
    it("owner can authorise a new address", async function () {
      await c.collateral
        .connect(signers.deployer)
        .authorise(signers.carol.address);
      expect(await c.collateral.authorised(signers.carol.address)).to.be.true;
    });

    it("non-owner cannot authorise", async function () {
      await expect(
        c.collateral.connect(signers.alice).authorise(signers.carol.address),
      ).to.be.revertedWith("Not owner");
    });

    it("authorised contract can call protocol helpers", async function () {
      await c.collateral
        .connect(signers.deployer)
        .authorise(signers.carol.address);
      await mintAndDeposit(c.token, c.collateral, signers.alice, USER_MINT);
      // carol (authorised) can now increaseCollateral
      await expect(
        c.collateral
          .connect(signers.carol)
          .increaseCollateral(signers.alice.address, 100n),
      ).not.to.be.reverted;
    });
  });

  // ── getMyCollateral view ───────────────────────────────────────────────

  describe("getMyCollateral", function () {
    it("returns zero handle for fresh account", async function () {
      const enc = await c.collateral.connect(signers.alice).getMyCollateral();
      // Uninitialized euint64 — handle is the zero bytes32
      expect(enc).to.equal(
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      );
    });

    it("returns correct handle after deposit", async function () {
      await mintAndDeposit(c.token, c.collateral, signers.alice, USER_MINT);
      const balance = await getBalance(
        c.collateral,
        signers.alice,
        collateralAddr,
      );
      expect(balance).to.equal(USER_MINT);
    });
  });
});
