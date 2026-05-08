// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, ebool, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984Receiver} from "@openzeppelin/confidential-contracts/interfaces/IERC7984Receiver.sol";

/// @title Collateral - Encrypted collateral vault for Futures and Options
/// @notice Users deposit ERC-7984 confidential tokens; balances are stored encrypted
///         using FHEVM. Withdrawals are fully synchronous — no oracle round-trip needed.
///
/// Deposit flow:
///   1. User calls token.setOperator(collateralAddr, expiry) once.
///   2. User creates an encrypted input off-chain and calls deposit(handle, proof).
///
/// Withdraw flow (no oracle):
///   1. User calls withdraw(amount) — FHE.select clamps to available balance.
///   2. Token transfer happens in the same transaction.
contract Collateral is ZamaEthereumConfig, IERC7984Receiver {
  // ── State ────────────────────────────────────────────────────────────────

  IERC7984 public immutable token;
  address public immutable owner;

  /// @dev Per-user encrypted balance (euint64 — fits up to ~18.4e18 wei)
  mapping(address => euint64) internal _collateral;
  mapping(address => bool) public authorised;

  // ── Events ───────────────────────────────────────────────────────────────

  /// @dev Handle emitted so the permitted user can decrypt their own history.
  ///      Only ACL-permitted addresses can decrypt the handle — onlookers cannot.
  event Deposit(address indexed user, euint64 amount);
  event Withdraw(address indexed user, euint64 amount);

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(address tokenAddress) {
    token = IERC7984(tokenAddress);
    owner = msg.sender;
  }

  // ── External functions ───────────────────────────────────────────────────

  /// @notice ERC7984 receiver callback — called by the token after a confidentialTransferAndCall.
  ///         User calls token.confidentialTransferAndCall(collateral, handle, proof, "") directly;
  ///         the token verifies the proof and then calls this function with the already-decoded euint64.
  ///         No separate proof verification needed here, eliminating the contractAddress ambiguity.
  /// @param  from    The sender of the confidential transfer (user).
  /// @param  amount  Already-verified encrypted amount.
  function onConfidentialTransferReceived(
    address /* operator */,
    address from,
    euint64 amount,
    bytes calldata /* data */
  ) external override returns (ebool) {
    require(msg.sender == address(token), "Collateral: only token");

    if (FHE.isInitialized(_collateral[from])) {
      _collateral[from] = FHE.add(_collateral[from], amount);
    } else {
      _collateral[from] = amount;
    }

    FHE.allowThis(_collateral[from]);
    FHE.allow(_collateral[from], from);
    FHE.allow(amount, from);

    emit Deposit(from, amount);
    // TOKEN needs transient ACL access to the returned ebool so it can call FHE.select(success, ...) 
    // to decide whether to refund. Without this, TOKEN gets ACLNotAllowed on its FHE.select call.
    ebool success = FHE.asEbool(true);
    FHE.allowTransient(success, msg.sender); // msg.sender = TOKEN
    return success;
  }

  /// @notice Withdraw up to `encAmount` tokens from the vault in a single transaction.
  ///         If the encrypted balance is less than the requested amount, the entire balance
  ///         is returned (FHE.select clamp) — no revert, no oracle. The withdrawal amount
  ///         remains confidential because it is supplied as an encrypted input.
  /// @param  encAmount  Off-chain encrypted amount handle (externalEuint64).
  /// @param  inputProof Proof that the caller knows the plaintext of encAmount.
  function withdraw(externalEuint64 encAmount, bytes calldata inputProof) external {
    euint64 requested = FHE.fromExternal(encAmount, inputProof);
    // actual = min(_collateral, requested) — fully encrypted, never revealed
    euint64 actual = FHE.select(FHE.ge(_collateral[msg.sender], requested), requested, _collateral[msg.sender]);

    _collateral[msg.sender] = FHE.sub(_collateral[msg.sender], actual);
    FHE.allowThis(_collateral[msg.sender]);
    FHE.allow(_collateral[msg.sender], msg.sender);
    // Allow the user to decrypt the emitted handle from the event log.
    FHE.allow(actual, msg.sender);

    // Grant the ERC-7984 token transient ACL access to process the transfer amount.
    FHE.allowTransient(actual, address(token));
    token.confidentialTransfer(msg.sender, actual);

    emit Withdraw(msg.sender, actual);
  }

  /// @notice Returns the encrypted balance handle for `msg.sender`.
  ///         Decrypt client-side with fhevm.userDecryptEuint.
  function getMyCollateral() external view returns (euint64) {
    return _collateral[msg.sender];
  }

  // ── Access control for protocol contracts ─────────────────────────────────
  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "Not authorised");
    _;
  }

  function authorise(address account) external {
    require(msg.sender == owner, "Not owner");
    authorised[account] = true;
  }

  function deauthorise(address account) external {
    require(msg.sender == owner, "Not owner");
    authorised[account] = false;
  }

  // ── Helpers called by Futures / Options contracts ─────────────────────────

  /// @notice Increase `user`'s encrypted balance by `amount`.
  function increaseCollateral(address user, uint64 amount) external onlyAuthorised {
    euint64 enc = FHE.asEuint64(amount);
    _collateral[user] = FHE.add(_collateral[user], enc);
    FHE.allowThis(_collateral[user]);
    FHE.allow(_collateral[user], user);
  }

  /// @notice Decrease `user`'s encrypted balance by `amount`.
  ///         Clamped to available balance via FHE.select — never underflows.
  function decreaseCollateral(address user, uint64 amount) external onlyAuthorised {
    euint64 enc = FHE.asEuint64(amount);
    euint64 actual = FHE.select(FHE.ge(_collateral[user], enc), enc, _collateral[user]);
    _collateral[user] = FHE.sub(_collateral[user], actual);
    FHE.allowThis(_collateral[user]);
    FHE.allow(_collateral[user], user);
  }

  /// @notice Decrease `user`'s encrypted balance by an already-encrypted `amount`.
  ///         Used by PerpetualFutures when collateral is supplied as encrypted input.
  ///         Clamped to available balance — never underflows.
  function decreaseCollateralEnc(address user, euint64 amount) external onlyAuthorised {
    FHE.allowThis(amount); // ensure this contract can read the handle
    euint64 actual = FHE.select(FHE.ge(_collateral[user], amount), amount, _collateral[user]);
    _collateral[user] = FHE.sub(_collateral[user], actual);
    FHE.allowThis(_collateral[user]);
    FHE.allow(_collateral[user], user);
  }

  /// @notice Increase `user`'s encrypted balance by an already-encrypted `amount`.
  ///         Used by LimitOrderBook when a limit order is cancelled.
  function increaseCollateralEnc(address user, euint64 amount) external onlyAuthorised {
    FHE.allowThis(amount);
    _collateral[user] = FHE.add(_collateral[user], amount);
    FHE.allowThis(_collateral[user]);
    FHE.allow(_collateral[user], user);
  }

  /// @notice Encrypted transfer between two users. Uses FHE.select so the
  ///         deduction is clamped to balance if insufficient.
  function transferCollateral(address from, address to, uint64 amount) external onlyAuthorised {
    euint64 enc = FHE.asEuint64(amount);
    euint64 actual = FHE.select(FHE.ge(_collateral[from], enc), enc, FHE.asEuint64(0));
    _collateral[from] = FHE.sub(_collateral[from], actual);
    _collateral[to] = FHE.add(_collateral[to], actual);

    FHE.allowThis(_collateral[from]);
    FHE.allow(_collateral[from], from);
    FHE.allowThis(_collateral[to]);
    FHE.allow(_collateral[to], to);
  }
}
