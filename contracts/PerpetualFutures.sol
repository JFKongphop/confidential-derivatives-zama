// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Collateral} from "./Collateral.sol";
import {OracleIntegration} from "./OracleIntegration.sol";
import {PositionManager} from "./PositionManager.sol";
import {PricingEngine} from "./PricingEngine.sol";

/// @title PerpetualFutures - Core perpetual futures trading protocol
/// @notice Users open long/short positions with 1-10× leverage.
///         Position sizes and collateral are stored encrypted; entry prices
///         and direction flags are public (required for P&L computation).
///
/// Decimal conventions:
///   • All prices: 8 decimals  (Chainlink)
///   • Collateral / sizes: 6 decimals (USDC)
contract PerpetualFutures is SepoliaConfig {
  using PricingEngine for *;

  // ── Constants ────────────────────────────────────────────────────────────

  uint256 public constant MAINTENANCE_MARGIN_BPS = 500; // 5%
  uint256 public constant LIQUIDATION_BONUS_BPS = 100; // 1%
  uint256 public constant MIN_LEVERAGE = 1;
  uint256 public constant MAX_LEVERAGE = 10;
  uint256 public constant BPS_DENOMINATOR = 10_000;

  // ── Immutables ───────────────────────────────────────────────────────────

  Collateral public immutable collateral;
  OracleIntegration public immutable oracle;
  PositionManager public immutable positionManager;

  // ── Pending liquidation requests ─────────────────────────────────────────

  struct LiquidationRequest {
    address user;
    uint256 positionId;
    address liquidator;
  }

  mapping(uint256 => LiquidationRequest) public pendingLiquidations;

  // ── Pending close requests ────────────────────────────────────────────────

  struct CloseRequest {
    address user;
    uint256 positionId;
    uint256 currentPrice;
  }

  mapping(uint256 => CloseRequest) public pendingCloses;

  // ── Events ───────────────────────────────────────────────────────────────

  event PositionOpened(
    address indexed user, uint256 positionId, bool isLong, uint256 entryPrice, uint256 collateralAmount
  );
  event PositionCloseRequested(address indexed user, uint256 positionId, uint256 requestId);
  event PositionClosed(address indexed user, uint256 positionId, uint256 exitPrice, bool profitable);
  event LiquidationRequested(address indexed user, uint256 positionId, address liquidator, uint256 requestId);
  event Liquidated(address indexed user, uint256 positionId, address indexed liquidator, uint256 liquidationPrice);

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(address collateralAddr, address oracleAddr, address positionManagerAddr) {
    collateral = Collateral(collateralAddr);
    oracle = OracleIntegration(oracleAddr);
    positionManager = PositionManager(positionManagerAddr);
  }

  // ── Open position ────────────────────────────────────────────────────────

  /// @notice Open a leveraged long or short position.
  /// @param  isLong           true = long, false = short
  /// @param  collateralAmount Plain USDC amount (6 decimals) to lock as margin
  /// @param  leverage         Leverage multiplier (1–10)
  /// @return positionId       The new position identifier
  function openPosition(bool isLong, uint64 collateralAmount, uint64 leverage) external returns (uint256 positionId) {
    require(leverage >= MIN_LEVERAGE && leverage <= MAX_LEVERAGE, "Invalid leverage");
    require(collateralAmount > 0, "Invalid collateral amount");

    uint256 currentPrice = oracle.getCurrentPrice();

    // Encrypted size = collateral × leverage (stays encrypted)
    euint64 encCollateral = FHE.asEuint64(collateralAmount);
    euint64 encLeverage = FHE.asEuint64(leverage);
    euint64 encSize = FHE.mul(encCollateral, encLeverage);

    // Grant ACL permissions before passing handles to PositionManager
    FHE.allowThis(encSize);
    FHE.allow(encSize, address(positionManager));
    FHE.allow(encSize, msg.sender);
    FHE.allowThis(encCollateral);
    FHE.allow(encCollateral, address(positionManager));
    FHE.allow(encCollateral, msg.sender);

    // Deduct collateral from vault (encrypted op — no leak)
    collateral.decreaseCollateral(msg.sender, collateralAmount);

    positionId = positionManager.addFuturesPosition(msg.sender, encSize, encCollateral, currentPrice, isLong);

    emit PositionOpened(msg.sender, positionId, isLong, currentPrice, collateralAmount);
  }

  // ── Close position (async) ────────────────────────────────────────────────

  /// @notice Initiate position close. Triggers async decryption of size & collateral
  ///         so P&L can be settled in the callback.
  /// @return requestId The decryption request identifier
  function closePosition(uint256 positionId) external returns (uint256 requestId) {
    PositionManager.FuturesPosition memory pos = positionManager.getFuturesPosition(msg.sender, positionId);

    uint256 currentPrice = oracle.getCurrentPrice();

    bytes32[] memory handles = new bytes32[](2);
    handles[0] = euint64.unwrap(pos.size);
    handles[1] = euint64.unwrap(pos.collateralUsed);

    requestId = FHE.requestDecryption(handles, this.fulfillClose.selector);
    pendingCloses[requestId] = CloseRequest({user: msg.sender, positionId: positionId, currentPrice: currentPrice});

    emit PositionCloseRequested(msg.sender, positionId, requestId);
  }

  /// @notice Callback: settles P&L and returns collateral ± P&L to user.
  function fulfillClose(uint256 requestId, bytes calldata cleartexts, bytes calldata decryptionProof) external {
    FHE.checkSignatures(requestId, cleartexts, decryptionProof);
    (uint64 decryptedSize, uint64 decryptedCollateral) = abi.decode(cleartexts, (uint64, uint64));

    CloseRequest memory req = pendingCloses[requestId];
    delete pendingCloses[requestId];

    PositionManager.FuturesPosition memory pos = positionManager.getFuturesPosition(req.user, req.positionId);

    // Calculate P&L using public prices and decrypted size
    // P&L = (|currentPrice - entryPrice| / entryPrice) × collateral
    uint256 delta =
      req.currentPrice > pos.entryPrice ? req.currentPrice - pos.entryPrice : pos.entryPrice - req.currentPrice;

    // pnlAmount in USDC (6 dec): size × delta / entryPrice
    // (size = collateral × leverage, so this correctly scales P&L)
    uint64 pnlAmount = uint64((uint256(decryptedSize) * delta) / pos.entryPrice);

    bool profitable = (req.currentPrice > pos.entryPrice) == pos.isLong;

    if (profitable) {
      collateral.increaseCollateral(req.user, decryptedCollateral + pnlAmount);
    } else {
      uint64 returnAmt = pnlAmount < decryptedCollateral ? decryptedCollateral - pnlAmount : 0;
      if (returnAmt > 0) {
        collateral.increaseCollateral(req.user, returnAmt);
      }
    }

    positionManager.removeFuturesPosition(req.user, req.positionId);

    emit PositionClosed(req.user, req.positionId, req.currentPrice, profitable);
  }

  // ── Liquidation ───────────────────────────────────────────────────────────

  /// @notice Trigger a decryption-based liquidation check.
  ///         If the position is found underwater in the callback, it is liquidated
  ///         and the `liquidator` receives the bonus.
  function liquidatePosition(address user, uint256 positionId) external returns (uint256 requestId) {
    PositionManager.FuturesPosition memory pos = positionManager.getFuturesPosition(user, positionId);

    bytes32[] memory handles = new bytes32[](2);
    handles[0] = euint64.unwrap(pos.size);
    handles[1] = euint64.unwrap(pos.collateralUsed);

    requestId = FHE.requestDecryption(handles, this.fulfillLiquidation.selector);
    pendingLiquidations[requestId] = LiquidationRequest({user: user, positionId: positionId, liquidator: msg.sender});

    emit LiquidationRequested(user, positionId, msg.sender, requestId);
  }

  /// @notice Callback: verifies the position is underwater and executes liquidation.
  function fulfillLiquidation(uint256 requestId, bytes calldata cleartexts, bytes calldata decryptionProof) external {
    FHE.checkSignatures(requestId, cleartexts, decryptionProof);
    (uint64 decryptedSize, uint64 decryptedCollateral) = abi.decode(cleartexts, (uint64, uint64));

    LiquidationRequest memory req = pendingLiquidations[requestId];
    delete pendingLiquidations[requestId];

    uint256 currentPrice = oracle.getCurrentPrice();

    PositionManager.FuturesPosition memory pos = positionManager.getFuturesPosition(req.user, req.positionId);

    // Maintenance required = collateral × 5%
    uint64 maintenanceRequired = uint64((uint256(decryptedCollateral) * MAINTENANCE_MARGIN_BPS) / BPS_DENOMINATOR);

    // Mark-to-market loss in USDC (6 dec): size × delta / entryPrice
    uint256 delta = currentPrice > pos.entryPrice ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
    uint64 mtmLoss = pos.isLong && currentPrice < pos.entryPrice
      ? uint64((uint256(decryptedSize) * delta) / pos.entryPrice)
      : (!pos.isLong && currentPrice > pos.entryPrice ? uint64((uint256(decryptedSize) * delta) / pos.entryPrice) : 0);

    uint64 remainingCollateral = mtmLoss < decryptedCollateral ? decryptedCollateral - mtmLoss : 0;

    require(remainingCollateral < maintenanceRequired, "Not liquidatable");

    // Pay liquidator bonus from remaining collateral
    uint64 bonus = uint64((uint256(decryptedCollateral) * LIQUIDATION_BONUS_BPS) / BPS_DENOMINATOR);
    if (bonus > 0) {
      collateral.increaseCollateral(req.liquidator, bonus);
    }

    positionManager.removeFuturesPosition(req.user, req.positionId);

    emit Liquidated(req.user, req.positionId, req.liquidator, currentPrice);
  }

  // ── View ─────────────────────────────────────────────────────────────────

  /// @notice Returns the encrypted size handle for a position (caller must own it).
  function getPositionSize(uint256 positionId) external view returns (euint64) {
    return positionManager.getFuturesPosition(msg.sender, positionId).size;
  }

  /// @notice Returns the encrypted collateral handle for a position.
  function getPositionCollateral(uint256 positionId) external view returns (euint64) {
    return positionManager.getFuturesPosition(msg.sender, positionId).collateralUsed;
  }
}
