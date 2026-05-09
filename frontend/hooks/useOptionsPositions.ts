'use client';

import { useEffect, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { parseAbiItem } from 'viem';
import { readContract } from 'wagmi/actions';
import { wagmiConfig } from '@/lib/wagmi';
import { OPTIONS_ADDRESS, POSITION_MANAGER_ADDRESS, POSITION_MANAGER_ABI } from '@/lib/contracts';

export type ChainOption = {
  tokenId: bigint;
  writer: `0x${string}`;
  expiryTime: bigint;
  premiumPerContract: bigint;
  holder: `0x${string}` | null; // null = not yet bought
  strikeHandle: `0x${string}` | null;
  isCallHandle: `0x${string}` | null;
};

const OPTION_MINTED_ABI = parseAbiItem(
  'event OptionMinted(uint256 indexed tokenId, address indexed writer, uint256 expiryTime, uint256 premiumPerContract)'
);

const OPTION_BOUGHT_ABI = parseAbiItem(
  'event OptionBought(uint256 indexed tokenId, address indexed buyer, uint256 premium)'
);

export function useOptionsPositions() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: sepolia.id });

  const [options, setOptions] = useState<ChainOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [fromBlock, setFromBlock] = useState<bigint | null>(null);

  // Compute fromBlock once at mount — avoids an extra RPC call on every refetch
  useEffect(() => {
    if (!client) return;
    client.getBlockNumber().then(n => setFromBlock(n > 9000n ? n - 9000n : 0n));
  }, [client]);

  async function fetchOptions() {
    if (!client || !OPTIONS_ADDRESS || fromBlock === null) return;
    setIsLoading(true);
    try {

      // Fetch all OptionMinted events (all writers — needed for marketplace view)
      const mintedLogs = await client.getLogs({
        address: OPTIONS_ADDRESS as `0x${string}`,
        event: OPTION_MINTED_ABI,
        fromBlock,
        toBlock: 'latest',
      });

      // Fetch all OptionBought events to know which are taken
      const boughtLogs = await client.getLogs({
        address: OPTIONS_ADDRESS as `0x${string}`,
        event: OPTION_BOUGHT_ABI,
        fromBlock,
        toBlock: 'latest',
      });

      // Build buyer map: tokenId → buyer address
      const buyerMap = new Map<string, `0x${string}`>();
      for (const log of boughtLogs) {
        if (log.args.tokenId !== undefined && log.args.buyer) {
          buyerMap.set(log.args.tokenId.toString(), log.args.buyer as `0x${string}`);
        }
      }

      const now = BigInt(Math.floor(Date.now() / 1000));

      const result: ChainOption[] = await Promise.all(
        mintedLogs
          .filter(log => {
            // Only show non-expired options
            const expiry = log.args.expiryTime ?? 0n;
            return expiry > now;
          })
          .map(async (log) => {
            let strikeHandle: `0x${string}` | null = null;
            let isCallHandle: `0x${string}` | null = null;
            try {
              const pos = await readContract(wagmiConfig, {
                address: POSITION_MANAGER_ADDRESS,
                abi: POSITION_MANAGER_ABI,
                functionName: 'getOptionPosition',
                args: [log.args.tokenId!],
              });
              strikeHandle = pos.strikePrice as `0x${string}`;
              isCallHandle = pos.isCall as `0x${string}`;
            } catch { /* option may be closed/expired */ }
            return {
              tokenId: log.args.tokenId!,
              writer: log.args.writer as `0x${string}`,
              expiryTime: log.args.expiryTime!,
              premiumPerContract: log.args.premiumPerContract!,
              holder: buyerMap.get(log.args.tokenId!.toString()) ?? null,
              strikeHandle,
              isCallHandle,
            };
          })
      );

      // Sort newest first (highest tokenId)
      result.sort((a, b) => (a.tokenId > b.tokenId ? -1 : 1));
      setOptions(result);
    } catch (e) {
      console.error('Failed to fetch options:', e);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (fromBlock === null) return;
    fetchOptions();
  }, [address, client, fromBlock]);

  return { options, isLoading, refetch: fetchOptions };
}
