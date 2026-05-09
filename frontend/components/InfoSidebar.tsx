'use client';

import { COLLATERAL_ADDRESS, FUTURES_ADDRESS, OPTIONS_ADDRESS, LIMIT_ORDER_BOOK_ADDRESS } from '@/lib/contracts';
import { shorten } from '@/lib/utils';

export function InfoSidebar({ tab }: { tab: 'futures' | 'options' | 'lob' }) {
  const fheFields = [
    { field: 'size',         where: 'Futures & Options', tabs: ['futures', 'options'] },
    { field: 'collateral',   where: 'Futures',           tabs: ['futures'] },
    { field: 'isLong',       where: 'Futures',           tabs: ['futures'] },
    { field: 'realizedPnL',  where: 'Futures',           tabs: ['futures'] },
    { field: 'stopLoss',     where: 'Futures SL/TP',     tabs: ['futures'] },
    { field: 'takeProfit',   where: 'Futures SL/TP',     tabs: ['futures'] },
    { field: 'strikePrice',  where: 'Options',           tabs: ['options'] },
    { field: 'isCall',       where: 'Options',           tabs: ['options'] },
    { field: 'lockedMargin', where: 'Options',           tabs: ['options'] },
    { field: 'collateral',   where: 'Limit Order',       tabs: ['lob'] },
    { field: 'limitPrice',   where: 'Limit Order',       tabs: ['lob'] },
    { field: 'isLong',       where: 'Limit Order',       tabs: ['lob'] },
  ].filter(({ tabs }) => tabs.includes(tab));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Contract addresses */}
      <div className="glass" style={{ padding: 20 }}>
        <p className="panel-title" style={{ marginBottom: 12 }}>Contracts</p>
        {[
          { label: 'Collateral', addr: COLLATERAL_ADDRESS },
          { label: 'Futures',    addr: FUTURES_ADDRESS    },
          { label: 'Options',    addr: OPTIONS_ADDRESS    },
          { label: 'Limit OB',  addr: LIMIT_ORDER_BOOK_ADDRESS },
        ].map(({ label, addr }) => {
          const deployed = addr !== '0x0000000000000000000000000000000000000000';
          return (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
              <span className="label" style={{ whiteSpace: 'nowrap' }}>{label.toUpperCase()}</span>
              {deployed ? (
                <a
                  href={`https://sepolia.etherscan.io/address/${addr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--blue)', textDecoration: 'none', whiteSpace: 'nowrap' }}
                >
                  {shorten(addr)} ↗
                </a>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Not deployed</span>
              )}
            </div>
          );
        })}
      </div>

      {/* FHE encrypted fields */}
      <div className="glass" style={{ padding: 20, flex: 1 }}>
        <p className="panel-title" style={{ marginBottom: 12 }}>FHE Encrypted Fields</p>
        {fheFields.map(({ field, where }) => (
          <div key={field} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>🔒</span>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)' }}>{field}</code>
            </div>
            <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{where}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
