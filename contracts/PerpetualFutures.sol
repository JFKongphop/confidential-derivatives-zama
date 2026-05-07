// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, ebool, externalEuint64, externalEbool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Collateral} from "./Collateral.sol";
import {OracleIntegration} from "./OracleIntegration.sol";
import {PositionManager} from "./PositionManager.sol";
import {PricingEngine} from "./PricingEngine.sol";

/// @title PerpetualFutures - Core perpetual futures trading protocol
/// @notice Users open long/short positions with 1-10× leverage.
///         Position sizes, collateral, AND direction are stored encrypted,
///         so observers cannot determine if a user is long or short —
///         preventing front-running and MEV on position direction.
///
/// Decimal conventions:
///   • All prices: 8 decimals  (Chainlink)
///   • Collateral / sizes: 6 decimals (USDC)
contract PerpetualFutures is ZamaEthereumConfig {
  using PricingEngine for *;

  // ── Constants ────────────────────────────────────────────────────────────

  uint256 public constant MAINTENANCE_MARGIN_BPS = 500; // 5%
  uint256 public constant LIQUIDATION_BONUS_BPS = 100; // 1%
  uint256 public constant MIN_LEVERAGE = 1;
  uint256 public constant MAX_LEVERAGE = 10;
  uint256 public constant BPS_DENOMINATOR = 10_000;
  uint256 public constant FUNDING_RATE_BPS = 10;   // 0.1% per interval
  uint256 public constant FUNDING_INTERVAL = 8 hours; // charged every 8 hours

  // ── Immutables ───────────────────────────────────────────────────────────

  Collateral public immutable collateral;
  OracleIntegration public immutable oracle;
  PositionManager public immutable positionManager;

  // ── Request counter ────────────────────────────────────────────────────────

  uint256 private _nextRequestId = 1;

  // ── Pending liquidation requests ─────────────────────────────────────────

  struct LiquidationRequest {
    address user;
    uint256 positionId;
    address liquidator;
    bytes32 sizeHandle;
    bytes32 collateralHandle;
    bytes32 isLongHandle;
  }

  mapping(uint256 => LiquidationRequest) public pendingLiquidations;

  // ── Pending close requests ────────────────────────────────────────────────

  struct CloseRequest {
    address user;
    uint256 positionId;
    uint256 currentPrice;
    bytes32 sizeHandle;
    bytes32 collateralHandle;
    bytes32 isLongHandle;
  }

  mapping(uint256 => CloseRequest) public pendingCloses;

  // ── Events ───────────────────────────────────────────────────────────────

  event PositionOpened(
    address indexed user, 
    uint256 positionId, 
    uint256 entryPrice,
    euint64 collateralHandle
  );
  event PositionCloseRequested(
    address indexed user, 
    uint256 positionId, 
    uint256 requestId
  );
  event PositionClosed(
    address indexed user, 
    uint256 positionId, 
    uint256 exitPrice
  );
  event LiquidationRequested(
    address indexed user, 
    uint256 positionId, 
    address liquidator, 
    uint256 requestId
  );
  event Liquidated(
    address indexed user, 
    uint256 positionId, 
    address indexed liquidator, 
    uint256 liquidationPrice
  );

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor(
    address collateralAddr, 
    address oracleAddr, 
    address positionManagerAddr
  ) {
    collateral = Collateral(collateralAddr);
    oracle = OracleIntegration(oracleAddr);
    positionManager = PositionManager(positionManagerAddr);
  }

  // ── Open position ────────────────────────────────────────────────────────

  /// @notice Open a leveraged long or short position.
  /// @param  encAmount   Off-chain encrypted collateral handle (externalEuint64)
  /// @param  inputProof  Proof bundle covering both encAmount and encIsLong
  /// @param  leverage    Leverage multiplier (1–10) — plaintext for on-chain bounds check
  /// @param  encIsLong   Off-chain encrypted direction: true=long, false=short
  /// @return positionId  The new position identifier
  function openPosition(
    externalEuint64 encAmount,
    bytes calldata inputProof,
    uint64 leverage,
    externalEbool encIsLong
  ) external returns (uint256 positionId) {
    require(leverage >= MIN_LEVERAGE && leverage <= MAX_LEVERAGE, "Invalid leverage");

    uint256 currentPrice = oracle.getCurrentPrice();

    // Verify and decrypt the encrypted inputs
    euint64 encCollateral = FHE.fromExternal(encAmount, inputProof);
    ebool encDirection  = FHE.fromExternal(encIsLong, inputProof);
    euint64 encLeverage   = FHE.asEuint64(leverage);
    euint64 encSize       = FHE.mul(encCollateral, encLeverage);

    // Grant ACL permissions
    FHE.allowThis(encSize);
    FHE.allow(encSize, address(positionManager));
    FHE.allow(encSize, msg.sender);
    FHE.allowThis(encCollateral);
    FHE.allow(encCollateral, address(positionManager));
    FHE.allow(encCollateral, address(collateral));
    FHE.allow(encCollateral, msg.sender);
    FHE.allowThis(encDirection);
    FHE.allow(encDirection, address(positionManager));
    FHE.allow(encDirection, msg.sender);

    // Deduct collateral from vault using encrypted amount — no plaintext leak
    collateral.decreaseCollateralEnc(msg.sender, encCollateral);

    positionId = positionManager.addFuturesPosition(
      msg.sender,
      encSize,
      encCollateral,
      encDirection,
      currentPrice
    );

    emit PositionOpened(msg.sender, positionId, currentPrice, encCollateral);
  }

  // ── Close position (async) ────────────────────────────────────────────────

  /// @notice Initiate position close. Triggers async decryption of size & collateral
  ///         so P&L can be settled in the callback.
  /// @return requestId The decryption request identifier
  function closePosition(uint256 positionId) external returns (uint256 requestId) {
    PositionManager.FuturesPosition memory pos = positionManager.getFuturesPosition(
      msg.sender, 
      positionId
    );

    uint256 currentPrice = oracle.getCurrentPrice();

    bytes32 sizeHandle = euint64.unwrap(pos.size);
    bytes32 collateralHandle = euint64.unwrap(pos.collateralUsed);
    bytes32 isLongHandle = ebool.unwrap(pos.isLong);

    FHE.makePubliclyDecryptable(pos.size);
    FHE.makePubliclyDecryptable(pos.collateralUsed);
    FHE.makePubliclyDecryptable(pos.isLong);

    requestId = _nextRequestId++;
    pendingCloses[requestId] = CloseRequest({
      user: msg.sender,
      positionId: positionId,
      currentPrice: currentPrice,
      sizeHandle: sizeHandle,
      collateralHandle: collateralHandle,
      isLongHandle: isLongHandle
    });

    emit PositionCloseRequested(msg.sender, positionId, requestId);
  }

  /// @notice Callback: settles P&L and returns collateral ± P&L to user.
  function fulfillClose(
    uint256 requestId, 
    bytes calldata abiEncodedCleartexts, 
    bytes calldata decryptionProof
  ) external {
    CloseRequest memory req = pendingCloses[requestId];
    require(req.user != address(0), "Unknown request");

    bytes32[] memory handles = new bytes32[](3);
    handles[0] = req.sizeHandle;
    handles[1] = req.collateralHandle;
    handles[2] = req.isLongHandle;

    FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
    (uint64 decryptedSize, uint64 decryptedCollateral, bool decryptedIsLong) = abi.decode(
      abiEncodedCleartexts, 
      (uint64, uint64, bool)
    );

    delete pendingCloses[requestId];

    PositionManager.FuturesPosition memory pos = positionManager.getFuturesPosition(
      req.user, 
      req.positionId
    );

    // Calculate P&L using public prices and decrypted size
    // P&L = (|currentPrice - entryPrice| / entryPrice) × collateral
    uint256 delta = req.currentPrice > pos.entryPrice
      ? req.currentPrice - pos.entryPrice
      : pos.entryPrice - req.currentPrice;

    // pnlAmount in USDC (6 dec): size × delta / entryPrice
    // (size = collateral × leverage, so this correctly scales P&L)
    uint64 pnlAmount = uint64((uint256(decryptedSize) * delta) / pos.entryPrice);

    // Funding cost: 0.1% per 8h interval held (applies to both longs and shorts)
    uint256 intervals = (block.timestamp - pos.openedAt) / FUNDING_INTERVAL;
    uint64 fundingCost = uint64((uint256(decryptedCollateral) * FUNDING_RATE_BPS * intervals) / BPS_DENOMINATOR);

    bool profitable = (req.currentPrice > pos.entryPrice) == decryptedIsLong;

    if (profitable) {
      uint64 gains = pnlAmount > fundingCost ? pnlAmount - fundingCost : 0;
      collateral.increaseCollateral(req.user, decryptedCollateral + gains);
    } else {
      uint64 totalDeduction = pnlAmount + fundingCost;
      uint64 returnAmt = totalDeduction < decryptedCollateral ? decryptedCollateral - totalDeduction : 0;
      if (returnAmt > 0) {
        collateral.increaseCollateral(req.user, returnAmt);
      }
    }

    positionManager.removeFuturesPosition(req.user, req.positionId);

    emit PositionClosed(req.user, req.positionId, req.currentPrice);
  }

  // ── Liquidation ───────────────────────────────────────────────────────────

  /// @notice Trigger a decryption-based liquidation check.
  ///         If the position is found underwater in the callback, it is liquidated
  ///         and the `liquidator` receives the bonus.
  function liquidatePosition(
    address user, 
    uint256 positionId
  ) external returns (uint256 requestId) {
    PositionManager.FuturesPosition memory pos = positionManager.getFuturesPosition(
      user, 
      positionId
    );

    bytes32 sizeHandle = euint64.unwrap(pos.size);
    bytes32 collateralHandle = euint64.unwrap(pos.collateralUsed);
    bytes32 isLongHandle = ebool.unwrap(pos.isLong);

    FHE.makePubliclyDecryptable(pos.size);
    FHE.makePubliclyDecryptable(pos.collateralUsed);
    FHE.makePubliclyDecryptable(pos.isLong);

    requestId = _nextRequestId++;
    pendingLiquidations[requestId] = LiquidationRequest({
      user: user,
      positionId: positionId,
      liquidator: msg.sender,
      sizeHandle: sizeHandle,
      collateralHandle: collateralHandle,
      isLongHandle: isLongHandle
    });

    emit LiquidationRequested(user, positionId, msg.sender, requestId);
  }

  /// @notice Callback: verifies the position is underwater and executes liquidation.
  function fulfillLiquidation(
    uint256 requestId, 
    bytes calldata abiEncodedCleartexts, 
    bytes calldata decryptionProof
  ) external {
    LiquidationRequest memory req = pendingLiquidations[requestId];
    require(req.user != address(0), "Unknown request");

    bytes32[] memory handles = new bytes32[](3);
    handles[0] = req.sizeHandle;
    handles[1] = req.collateralHandle;
    handles[2] = req.isLongHandle;

    FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
    (uint64 decryptedSize, uint64 decryptedCollateral, bool decryptedIsLong) = abi.decode(
      abiEncodedCleartexts,
      (uint64, uint64, bool)
    );

    delete pendingLiquidations[requestId];

    
    PositionManager.FuturesPosition memory pos = positionManager.getFuturesPosition(
      req.user, 
      req.positionId
    );
    
    // Maintenance required = collateral × 5%
    
    // Mark-to-market loss in USDC (6 dec): size × delta / entryPrice
    uint256 currentPrice = oracle.getCurrentPrice();
    uint256 delta = currentPrice > pos.entryPrice ? currentPrice - pos.entryPrice : pos.entryPrice - currentPrice;
    uint64 mtmLoss = decryptedIsLong && currentPrice < pos.entryPrice
    ? uint64((uint256(decryptedSize) * delta) / pos.entryPrice)
    : (!decryptedIsLong && currentPrice > pos.entryPrice ? uint64((uint256(decryptedSize) * delta) / pos.entryPrice) : 0);
    
    uint64 maintenanceRequired = uint64(
      (uint256(decryptedCollateral) * MAINTENANCE_MARGIN_BPS) 
      / BPS_DENOMINATOR
    );
    uint64 remainingCollateral = mtmLoss < decryptedCollateral ? decryptedCollateral - mtmLoss : 0;
    require(remainingCollateral < maintenanceRequired, "Not liquidatable");

    // Funding cost accrued while position was open
    uint256 intervals = (block.timestamp - pos.openedAt) / FUNDING_INTERVAL;
    uint64 fundingCost = uint64(
      (uint256(decryptedCollateral) * FUNDING_RATE_BPS * intervals) 
      / BPS_DENOMINATOR
    );

    // Liquidator bonus is always paid to incentivise liquidators.
    // In production an insurance fund covers any deficit; here collateral.increaseCollateral handles it.
    uint64 bonus = uint64(
      (uint256(decryptedCollateral) * LIQUIDATION_BONUS_BPS) 
      / BPS_DENOMINATOR
    );
    if (bonus > 0) {
      collateral.increaseCollateral(req.liquidator, bonus);
    }
    // Return whatever remains to the liquidated user (after MTM loss, bonus, and funding)
    uint64 afterBonus = remainingCollateral > bonus ? remainingCollateral - bonus : 0;
    uint64 userReturn = fundingCost < afterBonus ? afterBonus - fundingCost : 0;
    if (userReturn > 0) {
      collateral.increaseCollateral(req.user, userReturn);
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
