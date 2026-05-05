// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @title Collateral - Encrypted collateral vault for Futures and Options
/// @notice Users deposit ERC20 tokens; balances are stored encrypted using FHEVM.
///         Withdrawals use a two-step requestDecryption → callback pattern.
contract Collateral is SepoliaConfig {
  // ── State ────────────────────────────────────────────────────────────────

  MockERC20 public immutable token;

  /// @dev Per-user encrypted balance (euint64 — fits up to ~18.4e18 wei)
  mapping(address => euint64) internal _collateral;

  /// @dev Pending withdrawals: requestId → (user, amount)
  struct PendingWithdraw {
    address user;
    uint64 amount;
  }
  mapping(uint256 => PendingWithdraw) public pendingWithdraws;

  // ── Events ───────────────────────────────────────────────────────────────

  event Deposit(address indexed user, uint256 amount);
  event WithdrawRequested(
    address indexed user,
    uint256 amount,
    uint256 requestId
  );
  event Withdraw(address indexed user, uint256 amount);

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(address tokenAddress) {
    token = MockERC20(tokenAddress);
    owner = msg.sender;
  }

  // ── External functions ───────────────────────────────────────────────────

  /// @notice Deposit `amount` tokens into the encrypted vault.
  ///         Caller must have approved this contract for at least `amount`.
  function deposit(uint64 amount) external {
    require(amount > 0, "Invalid amount");
    require(
      token.transferFrom(msg.sender, address(this), amount),
      "Transfer failed"
    );

    euint64 enc = FHE.asEuint64(amount);
    _collateral[msg.sender] = FHE.add(_collateral[msg.sender], enc);

    // Grant the user access to read their own balance handle
    FHE.allowThis(_collateral[msg.sender]);
    FHE.allow(_collateral[msg.sender], msg.sender);

    emit Deposit(msg.sender, amount);
  }

  /// @notice Initiate a withdrawal. Triggers async decryption to verify
  ///         the caller actually has enough balance before transferring.
  /// @param  amount Amount to withdraw (plain – the user already knows what they deposited)
  /// @return requestId The decryption request identifier
  function withdraw(uint64 amount) external returns (uint256 requestId) {
    require(amount > 0, "Invalid amount");

    bytes32[] memory handles = new bytes32[](1);
    handles[0] = euint64.unwrap(_collateral[msg.sender]);

    requestId = FHE.requestDecryption(handles, this.fulfillWithdraw.selector);
    pendingWithdraws[requestId] = PendingWithdraw({
      user: msg.sender,
      amount: amount
    });

    emit WithdrawRequested(msg.sender, amount, requestId);
  }

  /// @notice Callback invoked by the Decryption Oracle after balance is revealed.
  ///         Verifies signatures, checks balance, and transfers tokens.
  function fulfillWithdraw(
    uint256 requestId,
    bytes calldata cleartexts,
    bytes calldata decryptionProof
  ) external {
    FHE.checkSignatures(requestId, cleartexts, decryptionProof);
    uint64 decryptedBalance = abi.decode(cleartexts, (uint64));

    PendingWithdraw memory req = pendingWithdraws[requestId];
    delete pendingWithdraws[requestId];

    require(decryptedBalance >= req.amount, "Insufficient collateral");

    // Deduct from encrypted balance
    euint64 newBal = FHE.sub(_collateral[req.user], FHE.asEuint64(req.amount));
    _collateral[req.user] = newBal;
    FHE.allowThis(newBal);
    FHE.allow(newBal, req.user);

    token.transfer(req.user, req.amount);

    emit Withdraw(req.user, req.amount);
  }

  /// @notice Returns the encrypted balance handle for `msg.sender`.
  ///         Decrypt client-side with fhevm.userDecryptEuint.
  function getMyCollateral() external view returns (euint64) {
    return _collateral[msg.sender];
  }

  // ── Access control for protocol contracts ─────────────────────────────────

  mapping(address => bool) public authorised;
  address public immutable owner;

  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "Not authorised");
    _;
  }

  function authorise(address account) external {
    require(msg.sender == owner, "Not owner");
    authorised[account] = true;
  }

  // ── Helpers called by Futures / Options contracts ─────────────────────────

  /// @notice Increase `user`'s encrypted balance by `amount`.
  function increaseCollateral(
    address user,
    uint64 amount
  ) external onlyAuthorised {
    euint64 enc = FHE.asEuint64(amount);
    _collateral[user] = FHE.add(_collateral[user], enc);
    FHE.allowThis(_collateral[user]);
    FHE.allow(_collateral[user], user);
  }

  /// @notice Decrease `user`'s encrypted balance by `amount`.
  ///         Caller is responsible for ensuring balance ≥ amount before calling.
  function decreaseCollateral(
    address user,
    uint64 amount
  ) external onlyAuthorised {
    euint64 enc = FHE.asEuint64(amount);
    _collateral[user] = FHE.sub(_collateral[user], enc);
    FHE.allowThis(_collateral[user]);
    FHE.allow(_collateral[user], user);
  }

  /// @notice Encrypted transfer between two users. Uses FHE.select so the
  ///         deduction is clamped to balance if insufficient.
  function transferCollateral(
    address from,
    address to,
    uint64 amount
  ) external onlyAuthorised {
    euint64 enc = FHE.asEuint64(amount);
    euint64 actual = FHE.select(
      FHE.ge(_collateral[from], enc),
      enc,
      FHE.asEuint64(0)
    );
    _collateral[from] = FHE.sub(_collateral[from], actual);
    _collateral[to] = FHE.add(_collateral[to], actual);

    FHE.allowThis(_collateral[from]);
    FHE.allow(_collateral[from], from);
    FHE.allowThis(_collateral[to]);
    FHE.allow(_collateral[to], to);
  }
}
