'use client';

import { useState, useEffect } from 'react';
import { useAccount, useBalance } from 'wagmi';
import { sepolia } from 'wagmi/chains';
import { useEncryptedCollateral } from '@/hooks/useEncryptedCollateral';
import { COLLATERAL_ADDRESS, FUTURES_ADDRESS, OPTIONS_ADDRESS } from '@/lib/contracts';
import { shorten } from '@/lib/utils';
import { WrapPanel } from '@/components/WrapPanel';
import { DecryptBalance } from '@/components/DecryptBalance';

export function AccountSection({ tab }: { tab: 'futures' | 'options' | 'lob' }) {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { data: ethBalance } = useBalance({
    address,
    chainId: sepolia.id,
    query: { enabled: isConnected && !!address },
  });

  const { handle, isLoading, isDeployed, hasBalance } = useEncryptedCollateral();

  async function handleConnect() {
    if (typeof window !== 'undefined' && (window as any).ethereum) {
      try {
        await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
      } catch (e) {
        console.error('Connect failed', e);
      }
    }
  }

  if (!mounted || !isConnected) {
    return (
      <div className="glass" style={{ padding: 24, textAlign: 'center' }}>
        <p className="panel-title" style={{ marginBottom: 16 }}>Account</p>
        <p className="label" style={{ marginBottom: 20 }}>Connect MetaMask to trade</p>
        <div style={{
          padding: '12px 16px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12,
          color: 'var(--text-dim)',
          lineHeight: 1.6,
        }}>
          Use the <strong style={{ color: 'var(--text)' }}>Connect</strong> button in the top nav to connect your wallet.
        </div>
      </div>
    );
  }

  const ethFmt = ethBalance
    ? `${Number(ethBalance.formatted).toFixed(4)} ETH`
    : '—';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Wallet card */}
      <div className="glass" style={{ padding: 24 }}>
        <p className="panel-title">Account</p>

        {/* Address */}
        <div className="card" style={{ padding: '10px 14px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="label">Wallet</span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {shorten(address!)}
          </span>
        </div>

        {/* ETH balance */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span className="label">ETH (gas)</span>
            <span className="mono" style={{ fontSize: 13 }}>{ethFmt}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span className="label">Network</span>
            <span style={{ fontSize: 12, color: 'var(--yellow)' }}>Sepolia Testnet</span>
          </div>
        </div>

        <div className="divider" />

        {/* Encrypted collateral */}
        {isDeployed && handle && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <span className="label">Collateral Balance</span>
            <DecryptBalance handle={handle as `0x${string}`} />
          </div>
        )}

        {/* Deposit / Withdraw note */}
        <div style={{
          padding: '10px 14px',
          background: 'rgba(191,90,242,0.06)',
          border: '1px solid rgba(191,90,242,0.15)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 11,
          color: 'var(--text-muted)',
          lineHeight: 1.6,
        }}>
          <strong style={{ color: 'var(--purple)', display: 'block', marginBottom: 4 }}>
            🔒 FHEVM Encrypted Deposit
          </strong>
          Deposits require encrypting the amount off-chain via the FHEVM SDK, then calling{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>collateral.deposit(handle, proof)</code>.
          No plaintext amount is ever submitted on-chain.
        </div>
      </div>

      {/* Wrap / Mint panel */}
      <div style={{ flex: 1 }}><WrapPanel /></div>
    </div>
  );
}
