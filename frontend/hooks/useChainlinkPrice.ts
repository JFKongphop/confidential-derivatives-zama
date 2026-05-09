'use client';

import { useReadContract } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { CHAINLINK_ETH_USD, CHAINLINK_ABI } from '@/lib/contracts';

export function useChainlinkPrice() {
  const { data, isLoading, isError } = useReadContract({
    address: CHAINLINK_ETH_USD,
    abi: CHAINLINK_ABI,
    functionName: 'latestRoundData',
    chainId: sepolia.id,
    query: { refetchInterval: 30_000 },
  });

  const price   = data ? (data[1] < 0n ? 0n : data[1]) : undefined;
  const updated = data ? data[3] : undefined;

  return {
    price,             // bigint, 8 decimals (e.g. 229484680000 = $2294.85)
    updatedAt: updated,
    isLoading,
    isError,
    isLive: !isError && !!data,
  };
}
