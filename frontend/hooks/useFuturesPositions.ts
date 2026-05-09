import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI } from '@/lib/contracts';

export type ChainPosition = {
  id: number;
  entryPrice: bigint;
  openedAt: bigint;
  collateralHandle: `0x${string}`;
  directionHandle: `0x${string}`;
};

export function useFuturesPositions() {
  const { address } = useAccount();

  // 1. Get how many positions this user has
  const { data: count, refetch } = useReadContract({
    address: POSITION_MANAGER_ADDRESS,
    abi: POSITION_MANAGER_ABI,
    functionName: 'futuresPositionCount',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const positionCount = Number(count ?? 0n);

  // 2. Fetch each position by index
  const { data: positionsRaw } = useReadContracts({
    contracts: Array.from({ length: positionCount }, (_, i) => ({
      address: POSITION_MANAGER_ADDRESS,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getFuturesPosition' as const,
      args: [address!, BigInt(i)] as [`0x${string}`, bigint],
    })),
    query: { enabled: !!address && positionCount > 0 },
  });

  const positions: ChainPosition[] = (positionsRaw ?? [])
    .map((result, i) => {
      if (result.status !== 'success') return null;
      const pos = result.result as { entryPrice: bigint; openedAt: bigint; isOpen: boolean; collateralUsed: `0x${string}`; isLong: `0x${string}` };
      if (!pos.isOpen) return null;
      return {
        id: i,
        entryPrice: pos.entryPrice,
        openedAt: pos.openedAt,
        collateralHandle: pos.collateralUsed,
        directionHandle: pos.isLong,
      };
    })
    .filter((p): p is ChainPosition => p !== null);

  return { positions, refetch };
}
