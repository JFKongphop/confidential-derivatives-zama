// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title PositionManager - Encrypted position state for Futures and Options
/// @notice Manages creation, retrieval, update, and deletion of positions.
///         Position sizes and collateral are stored encrypted; prices and
///         direction flags remain public (required for P&L calculations).
contract PositionManager is ZamaEthereumConfig {
  // ── Futures Position ─────────────────────────────────────────────────────

  struct FuturesPosition {
    euint64 size;           // Encrypted position size (in USDC with 6 decimals)
    euint64 collateralUsed; // Encrypted collateral locked for this position
    ebool   isLong;         // Encrypted direction: true=long, false=short
    uint256 entryPrice;     // Public entry price (8 decimals, Chainlink format)
    uint256 openedAt;       // Timestamp of position open
    bool    isOpen;         // Existence flag
  }

  // user → positionId → position
  mapping(address => mapping(uint256 => FuturesPosition)) public futuresPositions;
  mapping(address => uint256) public futuresPositionCount; // next positionId

  // ── Option Position ──────────────────────────────────────────────────────

  struct OptionPosition {
    euint64 size; // Encrypted notional size
    euint64 premium; // Encrypted premium paid by buyer
    uint256 strikePrice; // Public strike (8 decimals)
    uint256 expiryTime; // Public expiry timestamp
    address writer; // Option writer
    address holder; // Current holder (set after buyOption)
    uint256 tokenId; // Unique option token ID
    bool isCall; // Call=true, Put=false
    bool isOpen; // Existence flag
  }

  mapping(uint256 => OptionPosition) public optionsByTokenId;
  mapping(address => uint256[]) public userOptionTokenIds;
  uint256 public nextTokenId = 1;

  // ── Access control ───────────────────────────────────────────────────────

  mapping(address => bool) public authorised;
  address public immutable owner;

  modifier onlyAuthorised() {
    require(authorised[msg.sender] || msg.sender == owner, "Not authorised");
    _;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  event FuturesPositionAdded(
    address indexed user, 
    uint256 positionId, 
    uint256 entryPrice
  );
  event FuturesPositionClosed(
    address indexed user, 
    uint256 positionId
  );
  event OptionPositionAdded(
    uint256 indexed tokenId, 
    address writer, 
    bool isCall, 
    uint256 strikePrice
  );
  event OptionPositionClosed(uint256 indexed tokenId);

  // ── Constructor ──────────────────────────────────────────────────────────

  constructor() {
    owner = msg.sender;
  }

  function authorise(address account) external {
    require(msg.sender == owner, "Not owner");
    authorised[account] = true;
  }

  // ── Futures helpers ──────────────────────────────────────────────────────

  function addFuturesPosition(
    address user,
    euint64 size,
    euint64 collateralUsed,
    ebool isLong,
    uint256 entryPrice
  )
    external
    onlyAuthorised
    returns (uint256 positionId)
  {
    positionId = futuresPositionCount[user];
    futuresPositions[user][positionId] = FuturesPosition({
      size: size,
      collateralUsed: collateralUsed,
      isLong: isLong,
      entryPrice: entryPrice,
      openedAt: block.timestamp,
      isOpen: true
    });
    futuresPositionCount[user]++;

    emit FuturesPositionAdded(user, positionId, entryPrice);
  }

  function getFuturesPosition(address user, uint256 positionId) external view returns (FuturesPosition memory) {
    require(futuresPositions[user][positionId].isOpen, "Position not open");
    return futuresPositions[user][positionId];
  }

  function updateFuturesPosition(
    address user,
    uint256 positionId,
    euint64 newSize,
    euint64 newCollateral
  )
    external
    onlyAuthorised
  {
    require(futuresPositions[user][positionId].isOpen, "Position not open");
    futuresPositions[user][positionId].size = newSize;
    futuresPositions[user][positionId].collateralUsed = newCollateral;
  }

  function removeFuturesPosition(address user, uint256 positionId) external onlyAuthorised {
    require(futuresPositions[user][positionId].isOpen, "Position not open");
    delete futuresPositions[user][positionId];
    emit FuturesPositionClosed(user, positionId);
  }

  // ── Options helpers ──────────────────────────────────────────────────────

  function addOptionPosition(
    address writer,
    euint64 size,
    euint64 premium,
    uint256 strikePrice,
    uint256 expiryTime,
    bool isCall
  )
    external
    onlyAuthorised
    returns (uint256 tokenId)
  {
    tokenId = nextTokenId++;
    optionsByTokenId[tokenId] = OptionPosition({
      size: size,
      premium: premium,
      strikePrice: strikePrice,
      expiryTime: expiryTime,
      writer: writer,
      holder: address(0),
      tokenId: tokenId,
      isCall: isCall,
      isOpen: true
    });
    userOptionTokenIds[writer].push(tokenId);

    emit OptionPositionAdded(tokenId, writer, isCall, strikePrice);
  }

  function getOptionPosition(uint256 tokenId) external view returns (OptionPosition memory) {
    require(optionsByTokenId[tokenId].isOpen, "Option not open");
    return optionsByTokenId[tokenId];
  }

  function setOptionHolder(uint256 tokenId, address holder) external onlyAuthorised {
    require(optionsByTokenId[tokenId].isOpen, "Option not open");
    optionsByTokenId[tokenId].holder = holder;
  }

  function removeOptionPosition(uint256 tokenId) external onlyAuthorised {
    require(optionsByTokenId[tokenId].isOpen, "Option not open");
    delete optionsByTokenId[tokenId];
    emit OptionPositionClosed(tokenId);
  }
}
