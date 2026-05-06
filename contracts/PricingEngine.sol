// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";

/// @title PricingEngine - Mark-to-market and option premium calculations
/// @notice All Futures P&L math uses encrypted × public arithmetic so the
///         result stays encrypted.  Black-Scholes is a deterministic
///         approximation (IV = 20%, RFR = 5%, T = 7 days) — suitable for MVP.
///
/// Decimal conventions used throughout:
///   • Prices  : 8 decimals  (Chainlink format,  e.g. $2 000 → 200_000_000_00)
///   • Sizes   : 6 decimals  (USDC-denominated,  e.g. 1 unit → 1_000_000)
///   • Premiums: 6 decimals  (same as sizes)
///   • PRECISION constant = 1e8 to keep intermediate math in the price domain
library PricingEngine {
  uint256 public constant PRECISION = 1e8; // matches Chainlink decimals
  uint256 public constant SIZE_PRECISION = 1e6; // USDC 6 decimals
  uint256 public constant FUNDING_RATE_BPS = 1; // 0.01% per hour (1 basis point)
  uint256 public constant BPS_DENOMINATOR = 10_000;

  // ── Futures ──────────────────────────────────────────────────────────────

  /// @notice Compute encrypted P&L for a futures position.
  /// @dev    P&L = |currentPrice - entryPrice| × size / entryPrice
  ///         The result is encrypted (multiplied by encrypted `encryptedSize`).
  ///         Caller must determine profitability separately using public prices.
  /// @param  currentPrice  Current mark price (8 decimals)
  /// @param  entryPrice    Entry price       (8 decimals)
  /// @param  encryptedSize Encrypted position size (6 decimals)
  /// @return pnl           Encrypted absolute P&L in USDC (6 decimals)
  function calculateFuturesPnL(
    uint256 currentPrice,
    uint256 entryPrice,
    euint64 encryptedSize
  )
    internal
    returns (euint64 pnl)
  {
    // Compute plain price delta first (stays public)
    uint256 delta = currentPrice > entryPrice ? currentPrice - entryPrice : entryPrice - currentPrice;

    // pnl = size × delta / entryPrice  (all in their respective precisions)
    // size(6dec) × delta(8dec) / entryPrice(8dec) → result in 6dec
    euint64 encDelta = FHE.asEuint64(uint64(delta));
    euint64 rawPnl = FHE.mul(encryptedSize, encDelta);
    euint64 encEntry = FHE.asEuint64(uint64(entryPrice));

    // Integer division: divide by entryPrice
    // NOTE: FHE does not expose div; we emulate with known-public divisor.
    // We compute the multiplier as a plain fraction and apply it encrypted.
    // Approximation: use (delta * SIZE_PRECISION / entryPrice) as a uint64 scalar.
    uint64 scalar = uint64((delta * SIZE_PRECISION) / entryPrice);
    pnl = FHE.mul(encryptedSize, FHE.asEuint64(scalar));

    // suppress unused variable warning
    rawPnl;
    encEntry;
    encDelta;
  }

  /// @notice Compute encrypted funding payment for a position.
  /// @dev    payment = size × FUNDING_RATE_BPS × hoursOpen / BPS_DENOMINATOR
  /// @param  encryptedSize Encrypted position size
  /// @param  hoursOpen     Number of full hours the position has been open
  /// @return payment       Encrypted funding amount (positive = long pays short)
  function calculateFundingPayment(euint64 encryptedSize, uint64 hoursOpen) internal returns (euint64 payment) {
    // scalar = FUNDING_RATE_BPS * hoursOpen / BPS_DENOMINATOR
    // = 1 * hoursOpen / 10_000  → expressed in units of 1/10_000
    // We scale by SIZE_PRECISION to preserve precision:
    // payment = size * hoursOpen * FUNDING_RATE_BPS / BPS_DENOMINATOR
    uint64 rateScaled = uint64((uint256(hoursOpen) * FUNDING_RATE_BPS * SIZE_PRECISION) / BPS_DENOMINATOR);
    payment = FHE.mul(encryptedSize, FHE.asEuint64(rateScaled));
  }

  // ── Options (public — no encrypted inputs needed for premium) ────────────

  /// @notice Simplified Black-Scholes premium for a CALL option.
  ///         IV = 20%, RFR = 5%, T = 7 days (hardcoded for MVP).
  ///         Returns premium in same decimal units as spotPrice.
  /// @param  spotPrice   Current market price (8 decimals)
  /// @param  strikePrice Strike price         (8 decimals)
  /// @return premium     Estimated call premium (8 decimals)
  function blackScholesCall(uint256 spotPrice, uint256 strikePrice) internal pure returns (uint256 premium) {
    // Extrinsic value ≈ 4% of spot (approximation for 7-day, 20% IV)
    uint256 extrinsic = (spotPrice * 400) / BPS_DENOMINATOR; // 4% = 400 bps

    if (spotPrice >= strikePrice) {
      // ITM or ATM: intrinsic + extrinsic
      uint256 intrinsic = spotPrice - strikePrice;
      premium = intrinsic + extrinsic;
    } else {
      // OTM: extrinsic - out-of-moneyness (floor at 0)
      uint256 otm = strikePrice - spotPrice;
      premium = extrinsic > otm ? extrinsic - otm : 0;
    }
  }

  /// @notice Simplified Black-Scholes premium for a PUT option.
  /// @param  spotPrice   Current market price (8 decimals)
  /// @param  strikePrice Strike price         (8 decimals)
  /// @return premium     Estimated put premium (8 decimals)
  function blackScholesPut(uint256 spotPrice, uint256 strikePrice) internal pure returns (uint256 premium) {
    uint256 extrinsic = (spotPrice * 400) / BPS_DENOMINATOR; // 4%

    if (strikePrice >= spotPrice) {
      // ITM or ATM
      uint256 intrinsic = strikePrice - spotPrice;
      premium = intrinsic + extrinsic;
    } else {
      uint256 otm = spotPrice - strikePrice;
      premium = extrinsic > otm ? extrinsic - otm : 0;
    }
  }

  /// @notice Compute settlement value of an option at exercise.
  /// @param  currentPrice Current market price (8 decimals)
  /// @param  strikePrice  Strike price         (8 decimals)
  /// @param  isCall       true = call, false = put
  /// @return value        Settlement value (8 decimals); 0 if OTM
  function getOptionValue(uint256 currentPrice, uint256 strikePrice, bool isCall) internal pure returns (uint256 value) {
    if (isCall) {
      value = currentPrice > strikePrice ? currentPrice - strikePrice : 0;
    } else {
      value = strikePrice > currentPrice ? strikePrice - currentPrice : 0;
    }
  }
}
