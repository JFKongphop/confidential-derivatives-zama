'use client';

import { useEffect } from 'react';
import { useReadContract } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { useAccount } from 'wagmi';
import { COLLATERAL_ADDRESS, COLLATERAL_ABI } from '@/lib/contracts';

export function useEncryptedCollateral() {
  const { address, isConnected } = useAccount();

  const { data: handle, isLoading, refetch } = useReadContract({
    address: COLLATERAL_ADDRESS,
    abi: COLLATERAL_ABI,
    functionName: 'getMyCollateral',
    chainId: sepolia.id,
    account: address,
    query: {
      enabled: isConnected && !!address && COLLATERAL_ADDRESS !== '0x0000000000000000000000000000000000000000',
      refetchInterval: 15_000,
    },
  });

  // Immediately refetch whenever a trade tx lands in any section
  useEffect(() => {
    const handler = () => refetch();
    window.addEventListener('collateral:changed', handler);
    return () => window.removeEventListener('collateral:changed', handler);
  }, [refetch]);

  const isDeployed = COLLATERAL_ADDRESS !== '0x0000000000000000000000000000000000000000';
  const hasBalance = handle && handle !== '0x0000000000000000000000000000000000000000000000000000000000000000';

  return { handle, isLoading, isDeployed, hasBalance };
}
