'use client';

import { useAccount, useWriteContract } from 'wagmi';
import { useEncrypt } from '@zama-fhe/react-sdk';
import { bytesToHex } from 'viem';
import { LIMIT_ORDER_BOOK_ADDRESS, LOB_ABI } from '@/lib/contracts';

export function usePlaceOrder() {
  const { address } = useAccount();
  const encrypt = useEncrypt();
  const { writeContractAsync, isPending: isWriting } = useWriteContract();

  async function placeOrder({
    collateralAmount,
    limitPrice,
    isLong,
    leverage,
  }: {
    collateralAmount: bigint; // 6-decimal units (USDC convention)
    limitPrice: bigint;       // 8-decimal units (Chainlink format, e.g. 2300e8)
    isLong: boolean;
    leverage: bigint;         // 1–10
  }) {
    if (!address) throw new Error('Wallet not connected');

    // Encrypt all three values in one call → single shared inputProof
    const enc = await encrypt.mutateAsync({
      values: [
        { value: collateralAmount, type: 'euint64' },
        { value: limitPrice,       type: 'euint64' },
        { value: isLong,           type: 'ebool'   },
      ],
      contractAddress: LIMIT_ORDER_BOOK_ADDRESS,
      userAddress: address,
    });

    const encCollateral  = bytesToHex(enc.handles[0]!);
    const encLimitPrice  = bytesToHex(enc.handles[1]!);
    const encIsLong      = bytesToHex(enc.handles[2]!);
    const inputProof     = bytesToHex(enc.inputProof);

    return writeContractAsync({
      address: LIMIT_ORDER_BOOK_ADDRESS,
      abi: LOB_ABI,
      functionName: 'placeLimitOrder',
      args: [encCollateral, encLimitPrice, encIsLong, inputProof, leverage],
      gas: 15_000_000n,
    });
  }

  return {
    placeOrder,
    isEncrypting: encrypt.isPending,
    isWriting,
    isPending: encrypt.isPending || isWriting,
  };
}
