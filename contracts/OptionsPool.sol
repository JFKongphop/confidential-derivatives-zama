// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Collateral} from "./Collateral.sol";
import {OracleIntegration} from "./OracleIntegration.sol";
import {PositionManager} from "./PositionManager.sol";
import {PricingEngine} from "./PricingEngine.sol";

/// @title OptionsPool - European call/put options on ETH/USD
/// @notice Writers deposit collateral and mint options.
///         Buyers pay a premium (Black-Scholes approximation).
///         Options are European — exercisable only before expiry.
///
/// Allowed strikes (8 decimals, Chainlink format):
///   1800e8, 2000e8, 2200e8, 2400e8
///
/// Decimal conventions match PerpetualFutures:
///   • Prices   : 8 dec  (Chainlink)
///   • Premiums : 8 dec  (same as price domain)
///   • Sizes    : 6 dec  (USDC)
contract OptionsPool is ZamaEthereumConfig {
  using PricingEngine for *;

  // ── Constants ─────────────────────────────────────────────────────────────

  uint256 public constant TIME_TO_EXPIRY = 7 days;
  uint256 public constant BPS_DENOMINATOR = 10_000;
  uint256 public constant COLLATERAL_RATIO = 20; // 1/20 = 5% of size as extra collateral

  /// @dev Allowed strike prices (8 decimals)
  uint256[4] public STRIKES = [uint256(1800e8), 2000e8, 2200e8, 2400e8];

  // ── Immutables ────────────────────────────────────────────────────────────

  Collateral public immutable collateral;
  OracleIntegration public immutable oracle;
  PositionManager public immutable positionManager;

  // ── Request counter ──────────────────────────────────────────────────────

  uint256 private _nextRequestId = 1;

  /// @dev Tracks collateral locked by each writer per option token.
  ///      Used to return the writer's margin when an option expires worthless.
  mapping(uint256 => uint64) private _writerLockedCollateral;

  // ── Pending exercise requests ──────────────────────────────────────────────

  struct ExerciseRequest {
    address buyer;
    uint256 tokenId;
    uint256 currentPrice;
    bytes32 sizeHandle;
  }

  mapping(uint256 => ExerciseRequest) public pendingExercises;

  // ── Events ────────────────────────────────────────────────────────────────

  event OptionMinted(
    uint256 indexed tokenId,
    address indexed writer,
    bool isCall,
    uint256 strikePrice,
    uint256 expiryTime,
    uint256 premiumPerContract
  );
  event OptionBought(uint256 indexed tokenId, address indexed buyer, uint256 premium);
  event ExerciseRequested(uint256 indexed tokenId, address indexed buyer, uint256 requestId);
  event OptionExercised(uint256 indexed tokenId, address indexed buyer, uint256 settlementAmount);
  event OptionExpired(uint256 indexed tokenId);

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(address collateralAddr, address oracleAddr, address positionManagerAddr) {
    collateral = Collateral(collateralAddr);
    oracle = OracleIntegration(oracleAddr);
    positionManager = PositionManager(positionManagerAddr);
  }

  // ── Write option ──────────────────────────────────────────────────────────

  /// @notice Writer mints a new option, locking collateral proportional to risk.
  /// @param  isCall      true = call, false = put
  /// @param  strikePrice Strike price (8 decimals); must be in STRIKES array
  /// @param  size        USDC notional (6 decimals)
  /// @return tokenId     Newly minted option identifier
  function mintOption(bool isCall, uint256 strikePrice, uint64 size) external returns (uint256 tokenId) {
    require(size > 0, "Invalid size");
    require(_isValidStrike(strikePrice), "Invalid strike");

    uint256 spotPrice = oracle.getCurrentPrice();

    // Compute premium using simplified Black-Scholes
    uint256 premiumPerContract = isCall
      ? PricingEngine.blackScholesCall(spotPrice, strikePrice)
      : PricingEngine.blackScholesPut(spotPrice, strikePrice);

    // Required collateral = premium × size / spotPrice + size / 20
    // (premium is in 8 dec, size in 6 dec, spot in 8 dec)
    // → result in 6 dec
    uint64 requiredCollateral =
      uint64((premiumPerContract * uint256(size)) / spotPrice + uint256(size) / COLLATERAL_RATIO);

    // Lock collateral from writer
    collateral.decreaseCollateral(msg.sender, requiredCollateral);

    euint64 encSize = FHE.asEuint64(size);
    euint64 encPremium = FHE.asEuint64(uint64(premiumPerContract));

    // Grant ACL permissions before passing handles to PositionManager
    FHE.allowThis(encSize);
    FHE.allow(encSize, address(positionManager));
    FHE.allow(encSize, msg.sender);
    FHE.allowThis(encPremium);
    FHE.allow(encPremium, address(positionManager));
    FHE.allow(encPremium, msg.sender);

    tokenId = positionManager.addOptionPosition(
      msg.sender, encSize, encPremium, strikePrice, block.timestamp + TIME_TO_EXPIRY, isCall
    );
    _writerLockedCollateral[tokenId] = requiredCollateral;

    FHE.allowThis(encSize);
    FHE.allowThis(encPremium);

    emit OptionMinted(tokenId, msg.sender, isCall, strikePrice, block.timestamp + TIME_TO_EXPIRY, premiumPerContract);
  }

  // ── Buy option ────────────────────────────────────────────────────────────

  /// @notice Buyer purchases an existing option, paying the stored premium.
  ///         Premium is in 8-decimal price units, so we convert to 6-dec USDC.
  /// @param  tokenId The option to purchase
  function buyOption(uint256 tokenId) external {
    PositionManager.OptionPosition memory opt = positionManager.getOptionPosition(tokenId);

    require(block.timestamp < opt.expiryTime, "Option expired");
    require(opt.holder == address(0), "Already sold");
    require(opt.writer != msg.sender, "Writer cannot buy own option");

    uint256 spotPrice = oracle.getCurrentPrice();

    // Recalculate premium at current price for the buyer (fair pricing)
    uint256 premiumPerContract = opt.isCall
      ? PricingEngine.blackScholesCall(spotPrice, opt.strikePrice)
      : PricingEngine.blackScholesPut(spotPrice, opt.strikePrice);

    // Transfer premium (8 dec converted to 6 dec): premium * size / spot
    uint64 totalPremium = uint64((premiumPerContract /* opt.size as plain */ * 1_000_000) / spotPrice);
    // Note: In production, size would be decrypted; for MVP we use unit size = 1e6

    // Deduct premium from buyer and credit writer
    collateral.transferCollateral(msg.sender, opt.writer, totalPremium);

    // Grant buyer ACL access to the option's encrypted fields
    FHE.allow(opt.size, msg.sender);
    FHE.allow(opt.premium, msg.sender);

    // Register buyer as holder
    positionManager.setOptionHolder(tokenId, msg.sender);

    emit OptionBought(tokenId, msg.sender, totalPremium);
  }

  // ── Exercise option ────────────────────────────────────────────────────────

  /// @notice Holder exercises the option, triggering async decryption of size
  ///         to compute the settlement amount.
  /// @param  tokenId The option token to exercise
  /// @return requestId The decryption request identifier
  function exerciseOption(uint256 tokenId) external returns (uint256) {
    PositionManager.OptionPosition memory opt = positionManager.getOptionPosition(tokenId);

    require(opt.holder == msg.sender, "Not option holder");
    require(block.timestamp < opt.expiryTime, "Option expired");

    uint256 currentPrice = oracle.getCurrentPrice();

    // Verify the option is in-the-money before decrypting (saves gas if OTM)
    require(PricingEngine.getOptionValue(currentPrice, opt.strikePrice, opt.isCall) > 0, "Option out of the money");

    bytes32 sizeH = euint64.unwrap(opt.size);
    FHE.makePubliclyDecryptable(opt.size);

    uint256 requestId = _nextRequestId++;
    pendingExercises[requestId] = ExerciseRequest({buyer: msg.sender, tokenId: tokenId, currentPrice: currentPrice, sizeHandle: sizeH});

    emit ExerciseRequested(tokenId, msg.sender, requestId);
    return requestId;
  }

  /// @notice Callback: computes settlement and pays buyer.
  function fulfillExercise(uint256 requestId, bytes calldata abiEncodedCleartexts, bytes calldata decryptionProof) external {
    ExerciseRequest memory req = pendingExercises[requestId];
    require(req.buyer != address(0), "Unknown request");

    bytes32[] memory handles = new bytes32[](1);
    handles[0] = req.sizeHandle;

    FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);
    uint64 decryptedSize = abi.decode(abiEncodedCleartexts, (uint64));

    delete pendingExercises[requestId];

    PositionManager.OptionPosition memory opt = positionManager.getOptionPosition(req.tokenId);

    // Settlement in USDC (6 dec): (priceDelta / currentPrice) × size
    uint256 priceDelta = PricingEngine.getOptionValue(req.currentPrice, opt.strikePrice, opt.isCall);
    uint64 settlement = uint64((priceDelta * uint256(decryptedSize)) / req.currentPrice);

    if (settlement > 0) {
      // Transfer settlement from writer's collateral to buyer
      collateral.transferCollateral(opt.writer, req.buyer, settlement);
    }

    positionManager.removeOptionPosition(req.tokenId);

    emit OptionExercised(req.tokenId, req.buyer, settlement);
  }

  /// @notice Expire an OTM / unexercised option, releasing writer collateral.
  function expireOption(uint256 tokenId) external {
    PositionManager.OptionPosition memory opt = positionManager.getOptionPosition(tokenId);
    require(block.timestamp >= opt.expiryTime, "Not yet expired");
    // Return the writer's locked collateral now that the option has expired worthless.
    uint64 locked = _writerLockedCollateral[tokenId];
    delete _writerLockedCollateral[tokenId];
    if (locked > 0) {
      collateral.increaseCollateral(opt.writer, locked);
    }
    positionManager.removeOptionPosition(tokenId);
    emit OptionExpired(tokenId);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  function _isValidStrike(uint256 strike) internal view returns (bool) {
    for (uint256 i = 0; i < STRIKES.length; i++) {
      if (STRIKES[i] == strike) return true;
    }
    return false;
  }
}
