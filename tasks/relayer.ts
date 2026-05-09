/**
 * Futures Position Close Relayer
 * ================================
 * After calling closePosition() on-chain, the contract emits PositionCloseRequested
 * and waits for fulfillClose() to be called with KMS-decrypted values + proof.
 * This task acts as the relayer: it reads pending requests, decrypts the handles
 * via the Zama KMS (publicDecrypt), and submits fulfillClose().
 *
 * Usage:
 *   npx hardhat --network sepolia task:fulfill-close --request-id <id>
 *   npx hardhat --network sepolia task:fulfill-all-closes
 */

import { task } from "hardhat/config";
import type { TaskArguments } from "hardhat/types";

const FUTURES_ADDRESS = process.env.FUTURES_ADDRESS ?? process.env.NEXT_PUBLIC_FUTURES_ADDRESS;

// Minimal ABI for the relayer
const FUTURES_ABI = [
  {
    name: "pendingCloses",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "requestId", type: "uint256" }],
    outputs: [
      { name: "user",             type: "address" },
      { name: "positionId",       type: "uint256" },
      { name: "currentPrice",     type: "uint256" },
      { name: "sizeHandle",       type: "bytes32" },
      { name: "collateralHandle", type: "bytes32" },
      { name: "isLongHandle",     type: "bytes32" },
    ],
  },
  {
    name: "fulfillClose",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "requestId",          type: "uint256" },
      { name: "abiEncodedCleartexts", type: "bytes" },
      { name: "decryptionProof",    type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "PositionCloseRequested",
    type: "event",
    inputs: [
      { name: "user",       type: "address", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "requestId",  type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * Fulfill a single pending close request by requestId.
 *
 * npx hardhat --network sepolia task:fulfill-close --request-id 0
 */
task("task:fulfill-close", "Fulfill a pending closePosition request")
  .addParam("requestId", "The requestId emitted by PositionCloseRequested")
  .setAction(async function (taskArgs: TaskArguments, hre) {
    if (!FUTURES_ADDRESS) throw new Error("Set FUTURES_ADDRESS or NEXT_PUBLIC_FUTURES_ADDRESS in .env");

    const { ethers, fhevm } = hre as any;
    const [signer] = await ethers.getSigners();

    const futures = new ethers.Contract(FUTURES_ADDRESS, FUTURES_ABI, signer);
    const requestId = BigInt(taskArgs.requestId as string);

    console.log(`Fetching pendingCloses[${requestId}]...`);
    const req = await futures.pendingCloses(requestId);

    if (req.user === ethers.ZeroAddress) {
      console.log("Request not found or already fulfilled.");
      return;
    }

    console.log(`Request found — user: ${req.user}, positionId: ${req.positionId}`);
    console.log(`  sizeHandle:       ${req.sizeHandle}`);
    console.log(`  collateralHandle: ${req.collateralHandle}`);
    console.log(`  isLongHandle:     ${req.isLongHandle}`);

    const handles: `0x${string}`[] = [req.sizeHandle, req.collateralHandle, req.isLongHandle];

    console.log("Fetching KMS public decryption...");
    const result = await fhevm.publicDecrypt(handles);

    console.log("Decrypted values:", result.clearValues);
    console.log("abiEncodedClearValues:", result.abiEncodedClearValues.slice(0, 20) + "...");
    console.log("decryptionProof:", result.decryptionProof.slice(0, 20) + "...");

    console.log(`Calling fulfillClose(${requestId})...`);
    const tx = await futures.fulfillClose(
      requestId,
      result.abiEncodedClearValues,
      result.decryptionProof,
      { gasLimit: 5_000_000n },
    );

    console.log(`Tx submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Fulfilled! Block: ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);
  });

/**
 * Scan for all PositionCloseRequested events in recent blocks and fulfill any
 * that are still pending.
 *
 * npx hardhat --network sepolia task:fulfill-all-closes
 * npx hardhat --network sepolia task:fulfill-all-closes --from-block 7000000
 */
task("task:fulfill-all-closes", "Scan and fulfill all pending close requests")
  .addOptionalParam("fromBlock", "Block to scan from (default: latest - 50000)")
  .setAction(async function (taskArgs: TaskArguments, hre) {
    if (!FUTURES_ADDRESS) throw new Error("Set FUTURES_ADDRESS or NEXT_PUBLIC_FUTURES_ADDRESS in .env");

    const { ethers, fhevm } = hre as any;
    const [signer] = await ethers.getSigners();

    const futures = new ethers.Contract(FUTURES_ADDRESS, FUTURES_ABI, signer);
    const provider = ethers.provider;

    const latestBlock = await provider.getBlockNumber();
    const fromBlock = taskArgs.fromBlock ? Number(taskArgs.fromBlock) : Math.max(0, latestBlock - 50000);

    console.log(`Scanning PositionCloseRequested events from block ${fromBlock} to ${latestBlock}...`);

    const filter = futures.filters.PositionCloseRequested();
    const events = await futures.queryFilter(filter, fromBlock, latestBlock);

    console.log(`Found ${events.length} PositionCloseRequested event(s).`);

    for (const event of events) {
      const { requestId } = (event as any).args;
      console.log(`\n--- requestId: ${requestId} ---`);

      const req = await futures.pendingCloses(requestId);
      if (req.user === ethers.ZeroAddress) {
        console.log("  Already fulfilled, skipping.");
        continue;
      }

      const handles: `0x${string}`[] = [req.sizeHandle, req.collateralHandle, req.isLongHandle];

      console.log("  Fetching KMS public decryption...");
      const result = await fhevm.publicDecrypt(handles);
      console.log("  Decrypted:", result.clearValues);

      console.log("  Calling fulfillClose...");
      const tx = await futures.fulfillClose(
        requestId,
        result.abiEncodedClearValues,
        result.decryptionProof,
        { gasLimit: 5_000_000n },
      );
      console.log(`  Tx: ${tx.hash}`);
      await tx.wait();
      console.log("  Done!");
    }

    console.log("\nAll pending closes processed.");
  });
