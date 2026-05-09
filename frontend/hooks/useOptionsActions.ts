'use client';

import { useState } from 'react';
import { useWriteContract } from 'wagmi';
import { OPTIONS_ADDRESS, OPTIONS_ABI } from '@/lib/contracts';

/**
 * Options contract interactions.
 *
 * mintOption  — writer locks collateral; contract internally calls FHE.asEuint64()
 *               to encrypt strike/size/direction. No client-side encryption needed.
 * buyOption   — buyer pays premium; contract grants FHE ACL on-chain.
 * exerciseOption — triggers async FHE decryption to prove ITM and settle P&L.
 *
 * All three involve on-chain FHE operations, so gas is capped at 15 000 000
 * (below Sepolia's block gas limit of 16 777 216).
 */
export function useOptionsActions() {
  const { writeContractAsync, isPending } = useWriteContract();
  const [actionId, setActionId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mintOption({
    isCall,
    strikePrice,
    size,
  }: {
    isCall: boolean;
    strikePrice: bigint; // 8-decimal Chainlink price
    size: bigint;        // 6-decimal USDC notional
  }) {
    setError(null);
    // mintOption(bool isCall, uint256 strikePrice, uint64 size)
    // Contract encrypts all values internally via FHE.asEuint64 — no client encryption needed.
    return writeContractAsync({
      address: OPTIONS_ADDRESS,
      abi: OPTIONS_ABI,
      functionName: 'mintOption',
      args: [isCall, strikePrice, size],
      gas: 15_000_000n, // FHE.asEuint64 × 4 + ACL grants on-chain
    });
  }

  async function buyOption(tokenId: number) {
    setError(null);
    setActionId(tokenId);
    try {
      // buyOption(uint256 tokenId)
      // Contract calls FHE.allow() to grant buyer ACL access on-chain.
      return await writeContractAsync({
        address: OPTIONS_ADDRESS,
        abi: OPTIONS_ABI,
        functionName: 'buyOption',
        args: [BigInt(tokenId)],
        gas: 15_000_000n, // FHE ACL grants on-chain
      });
    } catch (e: any) {
      setError(e?.message ?? 'buyOption failed');
      throw e;
    } finally {
      setActionId(null);
    }
  }

  async function exerciseOption(tokenId: number) {
    setError(null);
    setActionId(tokenId);
    try {
      // exerciseOption(uint256 tokenId)
      // Contract runs FHE comparison (ITM proof) and calls FHE.makePubliclyDecryptable
      // to trigger async oracle decryption. Very gas-intensive.
      return await writeContractAsync({
        address: OPTIONS_ADDRESS,
        abi: OPTIONS_ABI,
        functionName: 'exerciseOption',
        args: [BigInt(tokenId)],
        gas: 15_000_000n, // FHE ITM proof + makePubliclyDecryptable on-chain
      });
    } catch (e: any) {
      setError(e?.message ?? 'exerciseOption failed');
      throw e;
    } finally {
      setActionId(null);
    }
  }

  async function expireOption(tokenId: number) {
    setError(null);
    setActionId(tokenId);
    try {
      return await writeContractAsync({
        address: OPTIONS_ADDRESS,
        abi: OPTIONS_ABI,
        functionName: 'expireOption',
        args: [BigInt(tokenId)],
        gas: 15_000_000n,
      });
    } catch (e: any) {
      setError(e?.message ?? 'expireOption failed');
      throw e;
    } finally {
      setActionId(null);
    }
  }

  return {
    mintOption,
    buyOption,
    exerciseOption,
    expireOption,
    isPending,
    actionId,
    error,
  };
}
