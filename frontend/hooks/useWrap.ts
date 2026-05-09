'use client';

import { useState } from 'react';
import { useAccount, useWriteContract } from 'wagmi';
import { useEncrypt } from '@zama-fhe/react-sdk';
import { bytesToHex } from 'viem';
import {
  TOKEN_ADDRESS,
  TOKEN_ABI,
  ERC20_ABI,
  COLLATERAL_ADDRESS,
} from '@/lib/contracts';

/**
 * Handles the full user onboarding flow:
 *
 * WRAPPER path (ConfidentialWETHWrapper — Sepolia with real WETH):
 *   1. weth.approve(TOKEN_ADDRESS, amount)            — allow wrapper to pull WETH
 *   2. wrapper.wrap(userAddress, amount)              — lock WETH, mint cWETH encrypted
 *   3. cWETH.setOperator(COLLATERAL_ADDRESS, expiry)  — allow Collateral to pull cWETH
 *   4. collateral.deposit(encAmount, inputProof)      — FHE-encrypted deposit into vault
 *
 * MOCK path (MockConfidentialToken — local / no WETH set):
 *   1. mockToken.mint(userAddress, amount)            — free test mint
 *   2. cWETH.setOperator(COLLATERAL_ADDRESS, expiry)
 *   3. collateral.deposit(encAmount, inputProof)
 */
export function useWrap() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const encrypt = useEncrypt();

  const [step, setStep]     = useState<string | null>(null);
  const [error, setError]   = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  // isMock: TOKEN_ABI has `mint` but no real ERC-20 underlying
  // Determined by checking env var — if NEXT_PUBLIC_UNDERLYING_ADDRESS is set, use wrap path
  const underlyingAddress = (process.env.NEXT_PUBLIC_UNDERLYING_ADDRESS ?? '') as `0x${string}`;
  const isMockToken = !underlyingAddress || underlyingAddress === '0x0000000000000000000000000000000000000000';

  async function wrapAndDeposit(amount: bigint) {
    if (!address) throw new Error('Wallet not connected');
    setError(null);
    setIsPending(true);
    try {
      if (isMockToken) {
        // ── Mock path ────────────────────────────────────────────────────────
        setStep('Minting test cUSDC…');
        await writeContractAsync({
          address: TOKEN_ADDRESS,
          abi: TOKEN_ABI,
          functionName: 'mint',
          args: [address, amount],         // amount in 6 decimals (uint64)
          gas: 15_000_000n,                // FHE.asEuint64 on-chain
        });
      } else {
        // ── Wrapper path ─────────────────────────────────────────────────────
        setStep('Approving ERC-20…');
        await writeContractAsync({
          address: underlyingAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [TOKEN_ADDRESS, amount],   // amount in underlying decimals
        });

        setStep('Wrapping ERC-20 → cUSDC…');
        await writeContractAsync({
          address: TOKEN_ADDRESS,
          abi: TOKEN_ABI,
          functionName: 'wrap',
          args: [address, amount],
          gas: 15_000_000n,                // FHE.asEuint64 on-chain
        });
      }

      // ── Both paths: encrypt + confidentialTransferAndCall ────────────────
      // User calls TOKEN directly → TOKEN verifies proof (contractAddress = TOKEN) → 
      // TOKEN calls collateral.onConfidentialTransferReceived with already-verified euint64.
      // No setOperator needed. No contractAddress ambiguity.
      setStep('Encrypting deposit amount…');
      const enc = await encrypt.mutateAsync({
        values: [{ value: amount, type: 'euint64' }],
        contractAddress: TOKEN_ADDRESS,   // user is calling TOKEN → proof bound to TOKEN
        userAddress: address,
      });

      setStep('Depositing into vault…');
      await writeContractAsync({
        address: TOKEN_ADDRESS,
        abi: TOKEN_ABI,
        functionName: 'confidentialTransferAndCall',
        args: [
          COLLATERAL_ADDRESS,
          bytesToHex(enc.handles[0]!),
          bytesToHex(enc.inputProof),
          '0x',                           // empty callback data
        ],
        gas: 15_000_000n,
      });

      setStep('Done!');
    } catch (e: any) {
      setError(e?.message ?? 'Transaction failed');
      throw e;
    } finally {
      setIsPending(false);
    }
  }

  return {
    wrapAndDeposit,
    isMockToken,
    isPending,
    step,
    error,
  };
}
