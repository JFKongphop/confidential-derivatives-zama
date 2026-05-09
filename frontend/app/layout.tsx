import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { Navbar } from '@/components/Navbar';

export const metadata: Metadata = {
  title: 'Confidential Derivatives | FHE-Encrypted Futures & Options on Sepolia',
  description: 'Privacy-preserving perpetual futures and options powered by Zama FHEVM.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ background: '#111111', colorScheme: 'dark' }}>
      <body style={{ background: '#111111', color: '#ffffff' }}>
        <Providers>
          <Navbar />
          <main style={{ paddingTop: 72 }}>
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
