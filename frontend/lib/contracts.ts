// ── Contract Addresses ───────────────────────────────────────────────────────

export const CHAINLINK_ETH_USD = '0x694AA1769357215DE4FAC081bf1f309aDC325306' as const;

export const COLLATERAL_ADDRESS =
  (process.env.NEXT_PUBLIC_COLLATERAL_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

export const ORACLE_ADDRESS =
  (process.env.NEXT_PUBLIC_ORACLE_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

export const FUTURES_ADDRESS =
  (process.env.NEXT_PUBLIC_FUTURES_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

export const OPTIONS_ADDRESS =
  (process.env.NEXT_PUBLIC_OPTIONS_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

export const LIMIT_ORDER_BOOK_ADDRESS =
  (process.env.NEXT_PUBLIC_LIMIT_ORDER_BOOK_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

export const POSITION_MANAGER_ADDRESS =
  (process.env.NEXT_PUBLIC_POSITION_MANAGER_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

// TOKEN_ADDRESS = ConfidentialUSDCWrapper (Sepolia) or MockConfidentialToken (local)
export const TOKEN_ADDRESS =
  (process.env.NEXT_PUBLIC_TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

// UNDERLYING_ADDRESS = MockERC20 faucet (Sepolia wrapper path only)
export const UNDERLYING_ADDRESS =
  (process.env.NEXT_PUBLIC_UNDERLYING_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

// ── ABIs ─────────────────────────────────────────────────────────────────────

// ERC-20 underlying ABI (approve + faucet)
export const ERC20_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'faucet',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// ConfidentialUSDCWrapper ABI (wraps ERC-20 → ERC-7984)
export const TOKEN_ABI = [
  // wrap(address to, uint256 amount) — user must approve first
  {
    inputs: [
      { name: 'to',     type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'wrap',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // unwrap(address from, address to, externalEuint64, bytes inputProof)
  {
    inputs: [
      { name: 'from',             type: 'address' },
      { name: 'to',               type: 'address' },
      { name: 'encryptedAmount',  type: 'bytes32' },
      { name: 'inputProof',       type: 'bytes'   },
    ],
    name: 'unwrap',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // MockConfidentialToken: open mint (local / test only)
  {
    inputs: [
      { name: 'to',     type: 'address' },
      { name: 'amount', type: 'uint64'  },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // confidentialTransferAndCall(address to, bytes32 encAmount, bytes inputProof, bytes data)
  // User calls token directly — token verifies proof then calls onConfidentialTransferReceived on `to`
  {
    inputs: [
      { name: 'to',         type: 'address' },
      { name: 'encAmount',  type: 'bytes32' },
      { name: 'inputProof', type: 'bytes'   },
      { name: 'data',       type: 'bytes'   },
    ],
    name: 'confidentialTransferAndCall',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// setOperator on ERC-7984 (required before Collateral.deposit)
export const ERC7984_OPERATOR_ABI = [
  {
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'until',    type: 'uint48' },
    ],
    name: 'setOperator',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const CHAINLINK_ABI = [
  {
    inputs: [],
    name: 'latestRoundData',
    outputs: [
      { name: 'roundId',         type: 'uint80'  },
      { name: 'answer',          type: 'int256'  },
      { name: 'startedAt',       type: 'uint256' },
      { name: 'updatedAt',       type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80'  },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const ORACLE_ABI = [
  {
    inputs: [],
    name: 'getCurrentPrice',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

export const COLLATERAL_ABI = [
  {
    inputs: [],
    name: 'getMyCollateral',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  // deposit(externalEuint64 encAmount, bytes inputProof)
  {
    inputs: [
      { name: 'encAmount',  type: 'bytes32' },
      { name: 'inputProof', type: 'bytes'   },
    ],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // withdraw(externalEuint64 encAmount, bytes inputProof)
  {
    inputs: [
      { name: 'encAmount',  type: 'bytes32' },
      { name: 'inputProof', type: 'bytes'   },
    ],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

export const FUTURES_ABI = [
  // openPosition(externalEuint64 encAmount, bytes inputProof, uint64 leverage, externalEbool encIsLong)
  {
    inputs: [
      { name: 'encAmount',  type: 'bytes32' },
      { name: 'inputProof', type: 'bytes'   },
      { name: 'leverage',   type: 'uint64'  },
      { name: 'encIsLong',  type: 'bytes32' },
    ],
    name: 'openPosition',
    outputs: [{ name: 'positionId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'positionId', type: 'uint256' }],
    name: 'closePosition',
    outputs: [{ name: 'requestId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { name: 'requestId',             type: 'uint256' },
      { name: 'abiEncodedCleartexts',  type: 'bytes'   },
      { name: 'decryptionProof',        type: 'bytes'   },
    ],
    name: 'fulfillClose',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'requestId', type: 'uint256' }],
    name: 'pendingCloses',
    outputs: [
      { name: 'user',             type: 'address' },
      { name: 'positionId',       type: 'uint256' },
      { name: 'currentPrice',     type: 'uint256' },
      { name: 'sizeHandle',       type: 'bytes32' },
      { name: 'collateralHandle', type: 'bytes32' },
      { name: 'isLongHandle',     type: 'bytes32' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // Events
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'user',       type: 'address' },
      { indexed: false, name: 'positionId', type: 'uint256' },
      { indexed: false, name: 'entryPrice', type: 'uint256' },
    ],
    name: 'PositionOpened',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'user',       type: 'address' },
      { indexed: false, name: 'positionId', type: 'uint256' },
      { indexed: false, name: 'requestId',  type: 'uint256' },
    ],
    name: 'PositionCloseRequested',
    type: 'event',
  },
] as const;

export const OPTIONS_ABI = [
  {
    inputs: [
      { name: 'isCall',      type: 'bool'    },
      { name: 'strikePrice', type: 'uint256' },
      { name: 'size',        type: 'uint64'  },
    ],
    name: 'mintOption',
    outputs: [{ name: 'tokenId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'buyOption',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'exerciseOption',
    outputs: [{ name: 'requestId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'expireOption',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // Read
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'pendingExercises',
    outputs: [
      { name: 'buyer',        type: 'address' },
      { name: 'tokenId',      type: 'uint256' },
      { name: 'currentPrice', type: 'uint256' },
      { name: 'itmHandle',    type: 'bytes32' },
      { name: 'sizeHandle',   type: 'bytes32' },
      { name: 'strikeHandle', type: 'bytes32' },
      { name: 'isCallHandle', type: 'bytes32' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // Events
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'tokenId',           type: 'uint256' },
      { indexed: true,  name: 'writer',             type: 'address' },
      { indexed: false, name: 'expiryTime',         type: 'uint256' },
      { indexed: false, name: 'premiumPerContract', type: 'uint256' },
    ],
    name: 'OptionMinted',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'tokenId', type: 'uint256' },
      { indexed: true,  name: 'buyer',   type: 'address' },
      { indexed: false, name: 'premium', type: 'uint256' },
    ],
    name: 'OptionBought',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'tokenId',          type: 'uint256' },
      { indexed: true,  name: 'buyer',             type: 'address' },
      { indexed: false, name: 'settlementAmount',  type: 'uint256' },
    ],
    name: 'OptionExercised',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, name: 'tokenId', type: 'uint256' }],
    name: 'OptionExpired',
    type: 'event',
  },
] as const;

// ── PositionManager ABI (minimal) ────────────────────────────────────────────
export const POSITION_MANAGER_ABI = [
  {
    inputs: [{ name: 'user', type: 'address' }],
    name: 'futuresPositionCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'user', type: 'address' }, { name: 'positionId', type: 'uint256' }],
    name: 'getFuturesPosition',
    outputs: [
      {
        components: [
          { name: 'size',           type: 'bytes32' },
          { name: 'collateralUsed', type: 'bytes32' },
          { name: 'isLong',         type: 'bytes32' },
          { name: 'entryPrice',     type: 'uint256' },
          { name: 'openedAt',       type: 'uint256' },
          { name: 'isOpen',         type: 'bool'    },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'getOptionPosition',
    outputs: [
      {
        components: [
          { name: 'size',        type: 'bytes32' },
          { name: 'premium',     type: 'bytes32' },
          { name: 'strikePrice', type: 'bytes32' },
          { name: 'isCall',      type: 'bytes32' },
          { name: 'expiryTime',  type: 'uint256' },
          { name: 'writer',      type: 'address' },
          { name: 'holder',      type: 'address' },
          { name: 'tokenId',     type: 'uint256' },
          { name: 'isOpen',      type: 'bool'    },
        ],
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ── Allowed strikes (8 dec, Chainlink format) ────────────────────────────────
export const ALLOWED_STRIKES = [
  { label: '$1,800', value: BigInt('180000000000') },
  { label: '$2,000', value: BigInt('200000000000') },
  { label: '$2,200', value: BigInt('220000000000') },
  { label: '$2,400', value: BigInt('240000000000') },
] as const;

// ── LimitOrderBook ABI ───────────────────────────────────────────────────────
export const LOB_ABI = [
  {
    inputs: [{ name: 'orderId', type: 'uint256' }],
    name: 'limitOrders',
    outputs: [
      { name: 'user',       type: 'address' },
      { name: 'leverage',   type: 'uint64'  },
      { name: 'collateral', type: 'bytes32' },
      { name: 'limitPrice', type: 'bytes32' },
      { name: 'isLong',     type: 'bytes32' },
      { name: 'isOpen',     type: 'bool'    },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'encCollateral', type: 'bytes32' },
      { name: 'encLimitPrice', type: 'bytes32' },
      { name: 'encIsLong',     type: 'bytes32' },
      { name: 'inputProof',    type: 'bytes'   },
      { name: 'leverage',      type: 'uint64'  },
    ],
    name: 'placeLimitOrder',
    outputs: [{ name: 'orderId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'orderId', type: 'uint256' }],
    name: 'cancelOrder',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'orderId', type: 'uint256' }],
    name: 'checkOrder',
    outputs: [{ name: 'requestId', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'user', type: 'address' }],
    name: 'getOrderCount',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'user',    type: 'address' },
      { indexed: false, name: 'orderId', type: 'uint256' },
      { indexed: false, name: 'leverage',type: 'uint64'  },
    ],
    name: 'LimitOrderPlaced',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'user',    type: 'address' },
      { indexed: false, name: 'orderId', type: 'uint256' },
    ],
    name: 'LimitOrderCancelled',
    type: 'event',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true,  name: 'user',       type: 'address' },
      { indexed: false, name: 'orderId',    type: 'uint256' },
      { indexed: false, name: 'fillPrice',  type: 'uint256' },
      { indexed: false, name: 'positionId', type: 'uint256' },
    ],
    name: 'LimitOrderFilled',
    type: 'event',
  },
] as const;
