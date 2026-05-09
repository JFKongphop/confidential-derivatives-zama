# Confidential Derivatives — FHE on-chain derivatives protocol

A fully on-chain derivatives protocol — perpetual futures, options, and a limit order book — where every sensitive trading value is encrypted using Fully Homomorphic Encryption (FHE) via [fhEVM](https://github.com/zama-ai/fhevm) by Zama.

Position sizes, collateral, direction, strike prices, stop-loss/take-profit levels, and realized PnL are all stored as encrypted ciphertexts. The EVM computes over them without ever seeing the plaintext.

---

## Problems We Solve

On-chain derivatives are broken by default. Everything you submit is public — your position size, your direction, your stop-loss, your strike. This creates a class of attacks that are impossible to prevent on transparent blockchains:

### 1. MEV Front-Running

When you open a position, bots read your calldata in the mempool and place orders ahead of you. Your intended entry price is your public information. With FHE:
- Collateral and size are submitted as ciphertexts — bots see `bytes32` handles, not dollar amounts
- Direction (`isLong`) is an `ebool` — nobody knows if you're going long or short until after settlement

### 2. Stop-Loss Hunting

Market makers and MEV searchers scan the chain for large stop-loss orders, then push price to those levels to trigger them and capture the spread. With FHE:
- Stop-loss and take-profit prices are `euint64` ciphertexts — the trigger price is invisible on-chain
- Keepers only learn *whether* a trigger fired, not at what price

### 3. Copy-Trading Without Consent

Profitable traders are trivially identified on transparent chains — their wallet, position sizes, and directions are all public. Competitors copy every trade in real time. With FHE:
- Position direction is encrypted — nobody can tell if you're long or short
- Realized PnL accumulates as a ciphertext — your profitability history stays private

### 4. Options Strike Leakage

A plaintext strike price on-chain tells the market exactly where you think the asset is going. MEV bots can read it and place orders to move price away from your strike before you exercise. With FHE:
- Strike is encrypted with `FHE.asEuint64` immediately after the Black-Scholes premium is computed
- The ITM check at exercise (`current > strike?`) runs entirely in FHE — the strike is never compared in plaintext
- Strike is only revealed in the decryption callback, at the moment of settlement

### 5. Limit Order Book Spoofing

Visible limit orders reveal your intended entry price, enabling spoofers to place and cancel orders just above/below yours to manipulate your fill. With FHE:
- Limit price, collateral, and direction are all encrypted at order placement
- The order book is blind — matching happens via FHE comparison, not plaintext inspection

---

## Contracts

| Contract | Description |
|---|---|
| `Collateral.sol` | Encrypted USDC-style balance sheet. Deposits, withdrawals, and encrypted transfers. |
| `PerpetualFutures.sol` | Leveraged perpetual futures. Encrypted size, collateral, direction, SL/TP, and PnL. |
| `LimitOrderBook.sol` | Encrypted limit orders. Price, direction, and collateral hidden until fill. |
| `OptionsPool.sol` | European call/put options. Strike price and direction encrypted after Black-Scholes. |
| `PositionManager.sol` | NFT-based position store. All financial fields are FHE ciphertexts. |
| `OracleIntegration.sol` | Chainlink ETH/USD wrapper (Sepolia). Public price feed. |
| `PricingEngine.sol` | On-chain Black-Scholes approximation and settlement math. |

---

## Encrypted Fields at a Glance

| Field | Contract | Type | Privacy Benefit |
|---|---|---|---|
| Collateral balance | `Collateral` | `euint64` | Hides total capital |
| Position size | `PositionManager` | `euint64` | Prevents whale detection and front-running |
| Collateral per position | `PositionManager` | `euint64` | Hides effective leverage |
| Direction (`isLong`) | `PositionManager` | `ebool` | **Most critical** — prevents copy-trading and sandwich attacks |
| Stop-loss price | `PerpetualFutures` | `euint64` | Prevents MEV bots from hunting your stop |
| Take-profit price | `PerpetualFutures` | `euint64` | Prevents adversaries from fading your exit |
| Realized PnL | `PerpetualFutures` | `euint64` | Keeps profitability history private |
| Limit order price | `LimitOrderBook` | `euint64` | Prevents front-running and spoofing |
| Limit order direction | `LimitOrderBook` | `ebool` | Same as `isLong` |
| Limit order collateral | `LimitOrderBook` | `euint64` | Hides order size before fill |
| Strike price | `PositionManager` | `euint64` | Prevents MEV reading strike and placing adversarial orders |
| Option direction (`isCall`) | `PositionManager` | `ebool` | Hides directional view — call/put leaks bull/bear bias |
| Writer locked margin | `OptionsPool` | `euint64` | Hides writer's risk exposure per option |

---

## FHE Highlights

### Perpetual Futures: Encrypted Liquidation

```solidity
// closePosition() — equity check is done over FHE ciphertexts
euint64 encValue = FHE.asEuint64(uint64(currentValue));
ebool isLiquidatable = FHE.lt(encValue, encCollateral);
FHE.makePubliclyDecryptable(isLiquidatable);
```

Collateral and current position value are compared homomorphically — the liquidation keeper gets a true/false without ever seeing the position size or collateral.

### Options: ITM Proof Without Revealing Strike

```solidity
// exerciseOption() — ITM check over encrypted strike
euint64 encCurrent = FHE.asEuint64(uint64(currentPrice));
ebool callITM = FHE.gt(encCurrent, opt.strikePrice);
ebool putITM  = FHE.lt(encCurrent, opt.strikePrice);
ebool encITM  = FHE.select(opt.isCall, callITM, putITM);
FHE.makePubliclyDecryptable(encITM);
```

The oracle network decrypts `encITM` and returns a proof. `fulfillExercise` enforces `require(itm)` on-chain. The strike is revealed only at settlement — not before.

### Stop-Loss / Take-Profit: Private Price Triggers

```solidity
// checkTrigger() — trigger check over encrypted SL/TP
ebool slHit = FHE.lt(encCurrent, pos.stopLoss);
ebool tpHit = FHE.gt(encCurrent, pos.takeProfit);
ebool triggered = FHE.or(slHit, tpHit);
FHE.makePubliclyDecryptable(triggered);
```

The trigger price is never revealed to keepers — only whether it was hit.

---

## Quick Start

## Quick Start

For detailed instructions see:
[FHEVM Hardhat Quick Start Tutorial](https://docs.zama.ai/protocol/solidity-guides/getting-started/quick-start-tutorial)

### Prerequisites

- **Node.js**: Version 20 or higher
- **npm or yarn/pnpm**: Package manager

### Installation

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Set up environment variables**

   ```bash
   npx hardhat vars set MNEMONIC

   # Set your Infura API key for network access
   npx hardhat vars set INFURA_API_KEY

   # Optional: Set Etherscan API key for contract verification
   npx hardhat vars set ETHERSCAN_API_KEY
   ```

3. **Compile and test**

   ```bash
   npm run compile
   npm run test
   ```

4. **Deploy to local network**

   ```bash
   # Start a local FHEVM-ready node
   npx hardhat node
   # Deploy to local network
   npx hardhat deploy --network localhost
   ```

5. **Deploy to Sepolia Testnet**

   ```bash
   # Deploy to Sepolia
   npx hardhat deploy --network sepolia
   # Verify contract on Etherscan
   npx hardhat verify --network sepolia <CONTRACT_ADDRESS>
   ```

6. **Test on Sepolia Testnet**

   ```bash
   # Once deployed, you can run a simple test on Sepolia.
   npx hardhat test --network sepolia
   ```

## Project Structure

```
confidential-derivatives-zama/
├── contracts/
│   ├── Collateral.sol          # Encrypted balance sheet
│   ├── PerpetualFutures.sol    # Leveraged perpetual futures
│   ├── LimitOrderBook.sol      # Encrypted limit orders
│   ├── OptionsPool.sol         # European options with FHE strike privacy
│   ├── PositionManager.sol     # FHE position store (NFT-backed)
│   ├── OracleIntegration.sol   # Chainlink ETH/USD feed
│   ├── PricingEngine.sol       # Black-Scholes + settlement math
│   └── mocks/                  # Test mocks (MockOracle, etc.)
├── test/
│   ├── Collateral.ts
│   ├── Futures.ts
│   ├── LimitOrderBook.ts
│   ├── Options.ts
│   ├── Integration.ts
│   └── SLTPAndPnL.ts
├── frontend/                   # Next.js 15 UI (wagmi v2 + viem)
├── deploy/                     # Hardhat deploy scripts
├── FUTURES_README.md           # Futures + LimitOrderBook FHE architecture
├── OPTIONS_README.md           # Options FHE architecture
├── hardhat.config.ts
└── package.json
```

## Available Scripts

| Script | Description |
|---|---|
| `npm run compile` | Compile all contracts |
| `npm run test` | Run all tests (local FHEVM mock) |
| `npm run coverage` | Generate coverage report |
| `npm run lint` | Run linting checks |
| `npm run clean` | Clean build artifacts |

### Test Results

```
101 passing
1  pending  (Sepolia live test — skip without RPC)
1  failing  (pre-existing FHEVM mock library bug — unrelated to contracts)
```

---

## Deploy to Sepolia

```bash
# 1. Set env vars
npx hardhat vars set MNEMONIC
npx hardhat vars set INFURA_API_KEY

# 2. Deploy
npx hardhat deploy --network sepolia

# 3. Update frontend/.env.local with deployed addresses
cp frontend/.env.local.example frontend/.env.local
# Edit NEXT_PUBLIC_COLLATERAL_ADDRESS, NEXT_PUBLIC_FUTURES_ADDRESS, etc.

# 4. Run frontend
cd frontend && npm install && npm run dev
```

### Verify live Chainlink oracle on Sepolia

```bash
cast call 0x694AA1769357215DE4FAC081bf1f309aDC325306 \
  "latestRoundData()(uint80,int256,uint256,uint256,uint80)" \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# → (roundId, 229484680000, ...) = $2,294.85
```

---

## Further Reading

- [FUTURES_README.md](FUTURES_README.md) — Full FHE architecture for perpetuals and limit orders
- [OPTIONS_README.md](OPTIONS_README.md) — Full FHE architecture for options and the ITM proof
- [fhEVM Documentation](https://docs.zama.ai/fhevm)
- [fhEVM Hardhat Plugin](https://docs.zama.ai/protocol/solidity-guides/development-guide/hardhat)

---

## License

BSD-3-Clause-Clear. See [LICENSE](LICENSE).

## 🆘 Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/zama-ai/fhevm/issues)
- **Documentation**: [FHEVM Docs](https://docs.zama.ai)
- **Community**: [Zama Discord](https://discord.gg/zama)

---

**Built with ❤️ by the Zama team**
