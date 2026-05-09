'use client';

import { useEffect, useState } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { shorten } from '@/lib/utils';

export function Navbar() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();

  async function handleConnect() {
    if (typeof window !== 'undefined' && (window as any).ethereum) {
      try {
        await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
      } catch (e) {
        console.error('Connect failed', e);
      }
    }
  }

  return (
    <nav className="nav-pill">
      <span className="nav-brand">🔒 Confidential Derivatives</span>
      <div className="nav-sep" />
      <span className="nav-link active">Trade</span>
      <div className="nav-sep" />

      {/* Network badge */}
      <span style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: '#FFD60A',
        padding: '4px 10px',
        background: 'rgba(255,214,10,0.08)',
        borderRadius: 100,
        border: '1px solid rgba(255,214,10,0.15)',
      }}>
        Sepolia
      </span>
      <div className="nav-sep" />

      {mounted && (
        isConnected && address ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{
              fontSize: 12,
              color: 'var(--text)',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--border)',
              borderRadius: 100,
              padding: '5px 12px',
              fontFamily: 'var(--font-mono)',
            }}>
              {shorten(address)}
            </span>
            <button
              style={{
                fontSize: 11, color: 'var(--text-dim)',
                background: 'none',
                border: '1px solid var(--border)',
                borderRadius: 100, padding: '4px 10px',
                cursor: 'pointer',
              }}
              onClick={() => disconnect()}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            style={{
              fontSize: 12, color: '#111111',
              background: '#ffffff', border: 'none',
              borderRadius: 100, padding: '5px 14px',
              cursor: 'pointer', fontFamily: 'var(--font-sans)', fontWeight: 500,
            }}
            onClick={handleConnect}
          >
            Connect
          </button>
        )
      )}
    </nav>
  );
}
