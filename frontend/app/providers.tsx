'use client';

import { WagmiProvider } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ZamaProvider, RelayerWeb, indexedDBStorage, SepoliaConfig } from '@zama-fhe/react-sdk';
import { WagmiSigner } from '@zama-fhe/react-sdk/wagmi';
import { wagmiConfig } from '@/lib/wagmi';
import { useMemo, useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  const signer = useMemo(() => new WagmiSigner({ config: wagmiConfig }), []);

  const relayer = useMemo(
    () =>
      new RelayerWeb({
        getChainId: () => signer.getChainId(),
        transports: {
          [sepolia.id]: {
            relayerUrl: SepoliaConfig.relayerUrl,
            network:
              process.env.NEXT_PUBLIC_RPC_URL ?? SepoliaConfig.network,
          },
        },
      }),
    [signer],
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ZamaProvider relayer={relayer} signer={signer} storage={indexedDBStorage}>
          {children}
        </ZamaProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
