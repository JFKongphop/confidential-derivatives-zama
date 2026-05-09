'use client';

import { useEffect, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { parseAbiItem } from 'viem';
import { readContract } from 'wagmi/actions';
import { wagmiConfig } from '@/lib/wagmi';
import { LIMIT_ORDER_BOOK_ADDRESS, LOB_ABI } from '@/lib/contracts';

export type ChainOrder = {
  orderId: bigint;
  leverage: bigint;
  status: 'open' | 'cancelled' | 'filled';
  fillPrice?: bigint;
  collateralHandle: `0x${string}` | null;
  limitPriceHandle: `0x${string}` | null;
  isLongHandle: `0x${string}` | null;
};

const PLACED_ABI = parseAbiItem(
  'event LimitOrderPlaced(address indexed user, uint256 orderId, uint64 leverage)'
);
const CANCELLED_ABI = parseAbiItem(
  'event LimitOrderCancelled(address indexed user, uint256 orderId)'
);
const FILLED_ABI = parseAbiItem(
  'event LimitOrderFilled(address indexed user, uint256 orderId, uint256 fillPrice, uint256 positionId)'
);

export function useLimitOrders() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: sepolia.id });

  const [orders, setOrders] = useState<ChainOrder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fromBlock, setFromBlock] = useState<bigint | null>(null);

  // Compute fromBlock once at mount — avoids getBlockNumber() on every refetch
  useEffect(() => {
    if (!client) return;
    client.getBlockNumber().then(n => setFromBlock(n > 9000n ? n - 9000n : 0n));
  }, [client]);

  async function fetchOrders() {
    if (!client || !address || !LIMIT_ORDER_BOOK_ADDRESS || fromBlock === null) return;
    setIsLoading(true);
    try {

      const [placedLogs, cancelledLogs, filledLogs] = await Promise.all([
        client.getLogs({
          address: LIMIT_ORDER_BOOK_ADDRESS as `0x${string}`,
          event: PLACED_ABI,
          args: { user: address },
          fromBlock,
          toBlock: 'latest',
        }),
        client.getLogs({
          address: LIMIT_ORDER_BOOK_ADDRESS as `0x${string}`,
          event: CANCELLED_ABI,
          args: { user: address },
          fromBlock,
          toBlock: 'latest',
        }),
        client.getLogs({
          address: LIMIT_ORDER_BOOK_ADDRESS as `0x${string}`,
          event: FILLED_ABI,
          args: { user: address },
          fromBlock,
          toBlock: 'latest',
        }),
      ]);

      const cancelledIds = new Set(cancelledLogs.map(l => l.args.orderId!.toString()));
      const filledMap = new Map(filledLogs.map(l => [l.args.orderId!.toString(), l.args.fillPrice!]));

      const result: ChainOrder[] = await Promise.all(
        placedLogs.map(async log => {
          const id = log.args.orderId!;
          const key = id.toString();

          // Fetch encrypted handles from the public mapping getter
          let collateralHandle: `0x${string}` | null = null;
          let limitPriceHandle: `0x${string}` | null = null;
          let isLongHandle: `0x${string}` | null = null;
          try {
            const order = await readContract(wagmiConfig, {
              address: LIMIT_ORDER_BOOK_ADDRESS as `0x${string}`,
              abi: LOB_ABI,
              functionName: 'limitOrders',
              args: [id],
            });
            collateralHandle = order[2] as `0x${string}`;
            limitPriceHandle = order[3] as `0x${string}`;
            isLongHandle = order[4] as `0x${string}`;
          } catch {
            // handles unavailable — decrypt buttons won't appear
          }

          return {
            orderId: id,
            leverage: log.args.leverage!,
            status: cancelledIds.has(key) ? 'cancelled' : filledMap.has(key) ? 'filled' : 'open',
            fillPrice: filledMap.get(key),
            collateralHandle,
            limitPriceHandle,
            isLongHandle,
          };
        })
      );

      // Most recent first
      setOrders(result.reverse());
    } catch (e) {
      console.error('useLimitOrders fetch failed', e);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (fromBlock === null) return;
    fetchOrders();
  }, [address, client, fromBlock]);

  return { orders, isLoading, refetch: fetchOrders };
}
