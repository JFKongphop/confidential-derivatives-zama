'use client';

import { useAccount, useWriteContract } from 'wagmi';
import { useEncrypt } from '@zama-fhe/react-sdk';
import { bytesToHex } from 'viem';
import { FUTURES_ADDRESS, FUTURES_ABI } from '@/lib/contracts';

/**
 * Encrypts collateral amount + direction client-side via the Zama SDK,
 * then submits the openPosition transaction with the encrypted handles + inputProof.
 *
 * Solidity signature:
 *   openPosition(externalEuint64 encAmount, bytes inputProof, uint64 leverage, externalEbool encIsLong)
 */
export function useOpenPosition() {
  const { address } = useAccount();
  const encrypt = useEncrypt();
  const { writeContractAsync, isPending: isWriting } = useWriteContract();

  async function openPosition({
    collateralAmount,
    leverage,
    isLong,
  }: {
    collateralAmount: bigint; // 6-decimal units (USDC, e.g. 100 USDC = 100_000_000n)
    leverage: bigint;         // 1–10
    isLong: boolean;
  }) {
    if (!address) throw new Error('Wallet not connected');

    // Step 1: FHE-encrypt collateral + direction client-side.
    // Both values are sent in one encrypt call so they share a single inputProof.
    const enc = await encrypt.mutateAsync({
      values: [
        { value: collateralAmount, type: 'euint64' },
        { value: isLong,           type: 'ebool'   },
      ],
      contractAddress: FUTURES_ADDRESS,
      userAddress: address,
    });

    // handles[0] = externalEuint64 (bytes32), handles[1] = externalEbool (bytes32)
    const encAmount  = bytesToHex(enc.handles[0]!);
    const encIsLong  = bytesToHex(enc.handles[1]!);
    const inputProof = bytesToHex(enc.inputProof);

    // Step 2: submit on-chain.
    // FHE verification is gas-intensive; cap below Sepolia's block gas limit (16,777,216).
    return writeContractAsync({
      address: FUTURES_ADDRESS,
      abi: FUTURES_ABI,
      functionName: 'openPosition',
      args: [encAmount, inputProof, leverage, encIsLong],
      gas: 15_000_000n,
    });
  }

  return {
    openPosition,
    isEncrypting: encrypt.isPending,
    isWriting,
    isPending: encrypt.isPending || isWriting,
  };
}
