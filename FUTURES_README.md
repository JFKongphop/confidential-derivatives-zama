# Confidential Perpetual Futures — FHE Architecture

Built on [fhEVM](https://github.com/zama-ai/fhevm) (Zama). All sensitive trading data is encrypted on-chain using Fully Homomorphic Encryption.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         User (off-chain)                        │
│   createEncryptedInput(contractAddr, userAddr)                  │
│     .add64(collateral)  .addBool(isLong)  .add64(limitPrice)    │
└───────────────┬─────────────────────────────────────────────────┘
                │  (ciphertext handles + ZK proof)
                ▼
┌───────────────────────────────┐    ┌──────────────────────────┐
│        Collateral.sol         │    │     OracleIntegration    │
│  ─────────────────────────    │    │  ─────────────────────   │
│  mapping(addr → euint64)      │    │  getCurrentPrice()       │
│  deposit / withdraw           │    │  → uint256 (plaintext)   │
│  increaseCollateral           │    │  [Chainlink, 8 decimals] │
│  decreaseCollateralEnc        │    └──────────────────────────┘
│  increaseCollateralEnc        │                │
└──────────────┬────────────────┘                │
               │                                 │
               ▼                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                      PerpetualFutures.sol                        │
│  ─────────────────────────────────────────────────────────────   │
│  openPosition(encCollateral, proof, leverage, encIsLong)         │
│  closePosition(positionId)   → async decrypt → fulfillClose      │
│  liquidatePosition(user, id) → async decrypt → fulfillLiquidate  │
│  setStopLoss(id, encPrice, proof)                                │
│  setTakeProfit(id, encPrice, proof)                              │
│  checkTrigger(user, id)      → async decrypt → fulfillTrigger    │
│  getMyRealizedPnL()          → euint64 handle                    │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                       PositionManager.sol                        │
│  ─────────────────────────────────────────────────────────────   │
│  FuturesPosition {                                               │
│    euint64  size           ← encrypted                           │
│    euint64  collateralUsed ← encrypted                           │
│    ebool    isLong         ← encrypted                           │
│    uint256  entryPrice     ← plaintext (see below)               │
│    uint256  openedAt       ← plaintext                           │
│    bool     isOpen         ← plaintext                           │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│                       LimitOrderBook.sol                         │
│  ─────────────────────────────────────────────────────────────   │
│  LimitOrder {                                                    │
│    euint64  collateral  ← encrypted                              │
│    euint64  limitPrice  ← encrypted                              │
│    ebool    isLong      ← encrypted                              │
│    uint64   leverage    ← plaintext (see below)                  │
│    address  user        ← plaintext                              │
│    bool     isOpen      ← plaintext                              │
│  }                                                               │
│  placeLimitOrder / cancelOrder / checkOrder / fulfillOrder       │
└──────────────────────────────────────────────────────────────────┘
```

---

## What Is Encrypted and Why

### ✅ Encrypted fields

| Field | Type | Contract | Why it matters |
|---|---|---|---|
| User collateral balance | `euint64` | `Collateral` | Prevents observers from knowing a trader's total capital |
| Position size | `euint64` | `PositionManager` | Hides the notional value of the position — large sizes are whale-detectable and front-runnable |
| Collateral used per position | `euint64` | `PositionManager` | Hides effective leverage ratio even if size is inferred |
| Position direction (`isLong`) | `ebool` | `PositionManager` | **Most critical** — knowing direction enables copy-trading, sandwich attacks, and liquidation hunting |
| Stop-loss price | `euint64` | `PerpetualFutures` | Plaintext SL orders are front-run by MEV bots that push price to the stop, collect the spread, then reverse |
| Take-profit price | `euint64` | `PerpetualFutures` | Plaintext TP leaks your profit target — adversaries can fade your exit |
| Limit order entry price | `euint64` | `LimitOrderBook` | Plaintext limit orders reveal your intended entry, enabling order book spoofing and front-running |
| Limit order direction | `ebool` | `LimitOrderBook` | Same reason as `isLong` above |
| Limit order collateral | `euint64` | `LimitOrderBook` | Hides order size before fill |
| Realized PnL (cumulative) | `euint64` | `PerpetualFutures` | Trader's profitability history is private — prevents targeted attacks on consistently profitable traders |

---

### ❌ Plaintext fields (and why they must be)

| Field | Type | Contract | Why it cannot be encrypted |
|---|---|---|---|
| Oracle price | `uint256` | `OracleIntegration` | Chainlink delivers prices in plaintext. Encrypting would require a privacy-preserving oracle (out of scope). The price is already public market data — the privacy risk is in *your reaction to it*, not the price itself. |
| Entry price | `uint256` | `PositionManager` | Recorded at the moment of opening — it's the oracle price at that block, which is already public. Encrypting it would prevent efficient on-chain P&L calculation. |
| `openedAt` timestamp | `uint256` | `PositionManager` | Required for funding rate calculation (`intervals = (now - openedAt) / 8h`). Hiding it would break the funding settlement math. |
| `isOpen` flag | `bool` | `PositionManager` | A flag that a position *exists* is not sensitive — only what's *in* the position is private. Hiding existence would prevent liquidation keepers from finding underwater positions. |
| Leverage multiplier | `uint64` | `LimitOrderBook`, `PerpetualFutures` | Only 10 possible values (1–10). An encrypted `euint64` with 10 possible values is trivially brute-forceable by trying all 10 with the ciphertext. Encrypting it would give a false sense of privacy. |
| `hasStopLoss` / `hasTakeProfit` | `bool` | `PerpetualFutures` | Only signals *that* a trigger exists, not its price. Required so keepers know whether to call `checkTrigger`. |
| Liquidation bonus BPS | `uint256` | `PerpetualFutures` | Protocol constant, same for all users — no privacy value. |
| Order `user` address | `address` | `LimitOrderBook` | On-chain address is always public. Full address privacy requires mixers/ZK identity (out of scope). |

---

## Data Flow: Opening a Position

```
1. User (off-chain):
   input = fhevm.createEncryptedInput(futuresAddr, user.address)
   input.add64(1_000_000)   // $1 000 collateral (6 decimals)
   input.addBool(true)      // isLong = true
   { handles, inputProof } = await input.encrypt()
   // handles[0] = euint64 ciphertext for collateral
   // handles[1] = ebool  ciphertext for direction

2. User calls:
   futures.openPosition(handles[0], inputProof, 2, handles[1])
   // leverage = 2 (plaintext)

3. On-chain (PerpetualFutures.openPosition):
   encCollateral = FHE.fromExternal(handles[0], inputProof)
   encDirection  = FHE.fromExternal(handles[1], inputProof)
   encSize       = FHE.mul(encCollateral, FHE.asEuint64(leverage))
   collateral.decreaseCollateralEnc(user, encCollateral)   // vault deduction
   positionManager.addFuturesPosition(user, encSize, encCollateral, encDirection, price)
   // Nothing about size, collateral, or direction is visible on-chain
```

---

## Data Flow: Stop-Loss / Take-Profit (the hardest part)

The FHE comparison must account for direction *without revealing direction*. This uses `FHE.select`:

```solidity
// SL: long hits SL when price < SL; short hits SL when price > SL
ebool slLong  = FHE.lt(encCurrentPrice, trig.stopLoss);
ebool slShort = FHE.gt(encCurrentPrice, trig.stopLoss);
ebool slFired = FHE.select(pos.isLong, slLong, slShort);
// ↑ "if isLong then slLong else slShort" — entirely in FHE
//   no branch, no direction leak, no price leak

// TP: long hits TP when price > TP; short hits TP when price < TP
ebool tpLong  = FHE.gt(encCurrentPrice, trig.takeProfit);
ebool tpShort = FHE.lt(encCurrentPrice, trig.takeProfit);
ebool tpFired = FHE.select(pos.isLong, tpLong, tpShort);

triggered = FHE.or(slFired, tpFired);
FHE.makePubliclyDecryptable(triggered);
// → async decryption → fulfillTrigger callback
```

Nobody — not miners, not MEV bots, not the keeper — knows:
- Whether the trigger fired (until public decryption resolves)
- Whether the position is long or short
- What the trigger prices are

---

## Data Flow: Limit Order Book

```
User places order (all encrypted in one proof bundle):
  input.add64(collateral)    → encCollateral
  input.add64(limitPrice)    → encLimitPrice  
  input.addBool(isLong)      → encIsLong

Keeper calls checkOrder(orderId):
  encCurrentPrice = FHE.asEuint64(oracle.getCurrentPrice())

  // Long limit: fill when price ≤ limit (buying the dip)
  // Short limit: fill when price ≥ limit (selling the rally)
  longCondition  = FHE.le(encCurrentPrice, order.limitPrice)
  shortCondition = FHE.ge(encCurrentPrice, order.limitPrice)
  triggered      = FHE.select(order.isLong, longCondition, shortCondition)
  FHE.makePubliclyDecryptable(triggered)

fulfillOrder callback:
  if triggered → positionManager.addFuturesPosition(...)
  if not      → leave order open (keeper wasted gas, not user's problem)
```

---

## Contract Permissions (ACL)

fhEVM's ACL controls which addresses can read (decrypt or operate on) a ciphertext handle. The permission matrix for a futures position handle is:

| Handle | Granted to |
|---|---|
| `encCollateral` | `PerpetualFutures`, `PositionManager`, `Collateral`, `user` |
| `encSize` | `PerpetualFutures`, `PositionManager`, `user` |
| `encIsLong` | `PerpetualFutures`, `PositionManager`, `user` |
| `encSL / encTP` | `PerpetualFutures`, `user` |
| `encRealizedPnL` | `PerpetualFutures`, `user` |

A liquidator, keeper, or block observer holds **none** of these permissions and sees only opaque `bytes32` handles.

---

## Async Decryption Pattern

Close, liquidation, and trigger settlement all follow the same two-step pattern required by fhEVM:

```
Step 1 — Request (on-chain):
  FHE.makePubliclyDecryptable(handle1, handle2, ...)
  pendingRequests[id] = { handle1, handle2, ... }
  emit RequestCreated(id)

Step 2 — Fulfill (on-chain, called by KMS/keeper with proof):
  FHE.checkSignatures(handles, abiEncodedCleartexts, proof)
  (val1, val2, ...) = abi.decode(abiEncodedCleartexts, (...))
  // proceed with plaintext values
```

The KMS (Key Management Service) decrypts and signs the result. The `checkSignatures` call verifies the KMS signature on-chain, so no trust is placed in the keeper who submits the transaction.

---

## Test Coverage

```
101 passing  (mock fhEVM — instant local execution)
  1 pending  (Sepolia-only test, skipped on localhost)

Collateral        — 14 tests  (deposit, withdraw, helpers, auth)
PerpetualFutures  — 50 tests  (open, close, liquidate, funding, SL/TP, PnL)
LimitOrderBook    — 18 tests  (place, cancel, check, fill — long and short)
OptionsPool       — 18 tests  (mint, buy, exercise, expire)
Integration       —  4 tests  (cross-contract hedge scenarios)
```

---

## Tech Stack

| Component | Version |
|---|---|
| Solidity | 0.8.30 |
| Hardhat | v2 |
| `@fhevm/solidity` | 0.11.1 |
| `@fhevm/hardhat-plugin` | 0.4.2 |
| `@openzeppelin/confidential-contracts` | 0.4.0 (ERC-7984) |
| Node.js | 23 |
| `viaIR` | enabled (avoids stack-too-deep on FHE-heavy contracts) |
