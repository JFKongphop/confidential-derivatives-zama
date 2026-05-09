'use client';

import { useChainlinkPrice } from '@/hooks/useChainlinkPrice';
import { PriceChart } from '@/components/PriceChart';
import { timeAgo } from '@/lib/utils';

export function MarketSection() {
  const { price, updatedAt, isLoading, isLive } = useChainlinkPrice();

  const priceNum = price ? Number(price) / 1e8 : null;
  const updated  = updatedAt ? timeAgo(updatedAt) : '—';
  const priceFmt = isLoading
    ? '—'
    : priceNum
    ? `$${priceNum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';

  return (
    <div className="glass" style={{ padding: 24 }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <p className="panel-title" style={{ marginBottom: 0 }}>Market</p>
          <span className="label" style={{ fontSize: 11 }}>ETH / USD</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 500, color: 'var(--text)' }}>
            {priceFmt}
          </span>
          {updatedAt && (
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              Updated {updated}
            </span>
          )}
        </div>
        <span
          style={{
            fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase',
            padding: '3px 10px', borderRadius: 100,
            background: isLive ? 'rgba(50,215,75,0.1)' : 'rgba(255,214,10,0.1)',
            color:      isLive ? 'var(--green)'        : 'var(--yellow)',
            border:     `1px solid ${isLive ? 'rgba(50,215,75,0.2)' : 'rgba(255,214,10,0.2)'}`,
          }}
        >
          {isLive ? '● Live' : '⚠ No Feed'}
        </span>
      </div>

      {/* Candlestick chart — extend to panel edge so price scale isn't clipped */}
      <div style={{ marginBottom: 14, marginLeft: -24, marginRight: -24 }}>
        <PriceChart />
      </div>

      {/* FHE info bar */}
      <div style={{
        padding: '10px 16px',
        background: 'rgba(191,90,242,0.06)',
        border: '1px solid rgba(191,90,242,0.15)',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <span style={{ fontSize: 14 }}>🔒</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          <strong style={{ color: 'var(--purple)' }}>FHEVM Privacy</strong>
          {' — '}
          Position sizes, collateral, strike prices, and directions are stored as fully homomorphic
          encrypted ciphertexts. Only the position owner can decrypt their own values.
        </span>
      </div>
    </div>
  );
}
