'use client';

import { useState } from 'react';
import { MarketSection } from '@/components/MarketSection';
import { FuturesSection } from '@/components/FuturesSection';
import { OptionsSection } from '@/components/OptionsSection';
import { LimitOrderBookSection } from '@/components/LimitOrderBookSection';
import { AccountSection } from '@/components/AccountSection';
import { InfoSidebar } from '@/components/InfoSidebar';

export default function Home() {
  const [tab, setTab] = useState<'futures' | 'options' | 'lob'>('futures');

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '32px 24px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 340px', gap: 20, alignItems: 'stretch' }}>
        {/* Left sidebar */}
        <InfoSidebar tab={tab} />

        {/* Centre column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <MarketSection />

          {/* Tab switcher */}
          <div className="tab-bar">
            <button
              className={`tab ${tab === 'futures' ? 'active' : ''}`}
              onClick={() => setTab('futures')}
            >
              Futures
            </button>
            <button
              className={`tab ${tab === 'options' ? 'active' : ''}`}
              onClick={() => setTab('options')}
            >
              Options
            </button>
            <button
              className={`tab ${tab === 'lob' ? 'active' : ''}`}
              onClick={() => setTab('lob')}
            >
              Limit Orders
            </button>
          </div>

          {tab === 'futures' ? <FuturesSection /> : tab === 'options' ? <OptionsSection /> : <LimitOrderBookSection />}
        </div>

        {/* Right column */}
        <AccountSection tab={tab} />
      </div>
    </div>
  );
}
