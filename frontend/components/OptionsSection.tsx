'use client';

import { useState, useEffect } from 'react';
import { useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice';
import { useOptionsActions } from '@/hooks/useOptionsActions';
import { useOptionsPositions } from '@/hooks/useOptionsPositions';
import { OPTIONS_ADDRESS, ALLOWED_STRIKES } from '@/lib/contracts';
import { formatExpiry } from '@/lib/utils';
import { DecryptOptionStrike } from './DecryptOptionStrike';
import { DecryptOptionType } from './DecryptOptionType';

function EncField({ label }: { label?: string }) {
  return (
    <span className="enc-field">
      <span>🔒</span>
      <span>{label ?? 'Encrypted'}</span>
    </span>
  );
}

export function OptionsSection() {
  const { address, isConnected } = useAccount();
  const { price } = useChainlinkPrice();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [showMintForm, setShowMintForm] = useState(false);
  const [isCall, setIsCall] = useState(true);
  const [selectedStrike, setSelectedStrike] = useState(ALLOWED_STRIKES[1].value.toString());
  const [size, setSize] = useState('1000000');

  const isDeployed = OPTIONS_ADDRESS !== '0x0000000000000000000000000000000000000000';
  const {
    mintOption,
    buyOption,
    exerciseOption,
    expireOption,
    isPending,
    actionId,
    error: actionError,
  } = useOptionsActions();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });
  const [mintError, setMintError] = useState<string | null>(null);
  const { options, isLoading: optionsLoading, refetch: refetchOptions } = useOptionsPositions();

  // Refetch when tx confirmed, and poll every 15s
  useEffect(() => {
    if (txConfirmed) {
      refetchOptions();
      window.dispatchEvent(new CustomEvent('collateral:changed'));
    }
  }, [txConfirmed]);
  useEffect(() => {
    const id = setInterval(() => refetchOptions(), 30_000);
    return () => clearInterval(id);
  }, []);

  async function handleMint() {
    if (!isDeployed) return;
    setMintError(null);
    try {
      const hash = await mintOption({
        isCall,
        strikePrice: BigInt(selectedStrike),
        size: BigInt(size),
      });
      setTxHash(hash);
      setShowMintForm(false);
      setTimeout(() => refetchOptions(), 4000);
    } catch (e: any) {
      if (e?.code === 4001 || /user rejected|user denied/i.test(e?.message ?? '')) return;
      setMintError(e?.message ?? 'Mint failed');
    }
  }

  async function handleBuy(tokenId: number) {
    if (!isDeployed) return;
    try {
      const hash = await buyOption(tokenId);
      setTxHash(hash);
    } catch {
      // error already captured in hook
    }
  }

  async function handleExercise(tokenId: number) {
    if (!isDeployed) return;
    try {
      const hash = await exerciseOption(tokenId);
      setTxHash(hash);
    } catch {
      // error already captured in hook
    }
  }

  return (
    <div className="glass" style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p className="panel-title" style={{ marginBottom: 0 }}>Options</p>
        {mounted && isConnected && (
          <button className="btn-primary" onClick={() => setShowMintForm(v => !v)}>
            {showMintForm ? 'Cancel' : '+ Write Option'}
          </button>
        )}
      </div>

      {/* Mint form */}
      {showMintForm && (
        <div style={{
          marginBottom: 20,
          padding: 16,
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
        }}>
          <p className="label" style={{ marginBottom: 12 }}>Write New Option</p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
            {/* Type */}
            <div>
              <p className="label" style={{ marginBottom: 6 }}>Type</p>
              <div className="tab-bar" style={{ width: '100%' }}>
                <button
                  className={`tab ${isCall ? 'active' : ''}`}
                  style={{ flex: 1, color: isCall ? 'var(--green)' : undefined }}
                  onClick={() => setIsCall(true)}
                >
                  Call ▲
                </button>
                <button
                  className={`tab ${!isCall ? 'active' : ''}`}
                  style={{ flex: 1, color: !isCall ? 'var(--red)' : undefined }}
                  onClick={() => setIsCall(false)}
                >
                  Put ▼
                </button>
              </div>
            </div>

            {/* Strike */}
            <div>
              <p className="label" style={{ marginBottom: 6 }}>Strike Price</p>
              <select
                className="input"
                value={selectedStrike}
                onChange={e => setSelectedStrike(e.target.value)}
              >
                {ALLOWED_STRIKES.map(s => (
                  <option key={s.value.toString()} value={s.value.toString()}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Size */}
            <div>
              <p className="label" style={{ marginBottom: 6 }}>Size (cWETH)</p>
              <input
                type="number"
                className="input"
                value={size}
                onChange={e => setSize(e.target.value)}
                placeholder="1 = 1e18 cWETH"
              />
            </div>
          </div>

          {/* FHE encryption note */}
          <div style={{
            padding: '10px 14px',
            background: 'rgba(191,90,242,0.06)',
            border: '1px solid rgba(191,90,242,0.15)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 12,
            color: 'var(--text-muted)',
            marginBottom: 12,
            lineHeight: 1.6,
          }}>
            <strong style={{ color: 'var(--purple)' }}>🔒 Strike encrypted after Black-Scholes</strong>
            <br />
            Strike and direction are encrypted immediately after premium calculation.
            On-chain storage only contains FHE ciphertexts — no plaintext strike is ever stored.
          </div>

          {mintError && (
            <p style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{mintError}</p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, padding: '10px 14px', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
              <div className="label" style={{ marginBottom: 4 }}>Estimated Premium</div>
              <div className="mono" style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                {price ? `~${((Number(price) / 1e8) * 0.04).toFixed(2)} (4% of spot)` : '—'}
              </div>
            </div>
            <button
              className="btn-primary"
              style={{ whiteSpace: 'nowrap' }}
              disabled={!isDeployed || !mounted || !isConnected || isPending || isConfirming}
              onClick={handleMint}
            >
              {!isDeployed ? 'Not Deployed' : isPending ? '⏳ Confirming…' : '🔒 Write Option (FHE)'}
            </button>
          </div>
        </div>
      )}

      {/* Options table */}
      <div className="table-wrapper">
        <table>
          <colgroup>
            <col style={{ width: '6%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '16%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Strike</th>
              <th>Expiry</th>
              <th>Premium</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {optionsLoading && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 24 }}>Loading from chain…</td></tr>
            )}
            {!optionsLoading && options.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 24 }}>No active options</td></tr>
            )}
            {options.map((opt) => {
              const expired = Number(opt.expiryTime) < Date.now() / 1000;
              const isHolder = address && opt.holder?.toLowerCase() === address.toLowerCase();
              const isWriter = address && opt.writer.toLowerCase() === address.toLowerCase();
              const premiumUsd = (Number(opt.premiumPerContract) / 1e8).toFixed(2);

              return (
                <tr key={opt.tokenId.toString()}>
                  <td><span className="mono" style={{ color: 'var(--text-muted)' }}>#{opt.tokenId}</span></td>
                  <td>
                    {(isWriter || isHolder) && opt.isCallHandle
                      ? <DecryptOptionType handle={opt.isCallHandle} />
                      : <EncField label="Hidden" />}
                  </td>
                  <td>
                    {(isWriter || isHolder) && opt.strikeHandle
                      ? <DecryptOptionStrike handle={opt.strikeHandle} />
                      : <EncField label="Hidden" />}
                  </td>
                  <td>
                    <span style={{ fontSize: 12, color: expired ? 'var(--red)' : 'var(--text-muted)' }}>
                      {formatExpiry(opt.expiryTime)}
                    </span>
                  </td>
                  <td>
                    <span className="mono">${premiumUsd}</span>
                  </td>
                  <td>
                    {expired ? (
                      <span className="badge badge-red">Expired</span>
                    ) : opt.holder ? (
                      <span className="badge badge-green">Sold</span>
                    ) : (
                      <span className="badge badge-yellow">Available</span>
                    )}
                  </td>
                  <td>
                    {!expired && !opt.holder && !isWriter && (
                      <button
                        className="btn-ghost"
                        style={{ padding: '5px 14px', fontSize: 11 }}
                        disabled={!isDeployed || actionId === Number(opt.tokenId)}
                        onClick={() => handleBuy(Number(opt.tokenId))}
                      >
                        Buy
                      </button>
                    )}
                    {!expired && isHolder && (
                      <button
                        className="btn-green"
                        style={{ padding: '5px 14px', fontSize: 11 }}
                        disabled={!isDeployed || actionId === Number(opt.tokenId)}
                        onClick={() => handleExercise(Number(opt.tokenId))}
                      >
                        {actionId === Number(opt.tokenId) ? '…' : 'Exercise'}
                      </button>
                    )}
                    {expired && (
                      <button
                        className="btn-danger"
                        style={{ padding: '5px 14px', fontSize: 11 }}
                        disabled={!isDeployed || actionId === Number(opt.tokenId)}
                        onClick={async () => {
                          try {
                            const hash = await expireOption(Number(opt.tokenId));
                            setTxHash(hash);
                          } catch {
                            // error captured in hook
                          }
                        }}
                      >
                        Expire
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* FHE exercise explanation */}
      <div style={{
        marginTop: 16,
        padding: '12px 14px',
        background: 'rgba(191,90,242,0.04)',
        border: '1px solid rgba(191,90,242,0.12)',
        borderRadius: 'var(--radius-sm)',
      }}>
        <div className="label" style={{ marginBottom: 6, color: 'var(--purple)' }}>🔒 FHE Exercise Proof</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          When you exercise, the contract runs an encrypted ITM check:
          <br />
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', display: 'block', marginTop: 6 }}>
            {`ebool itm = FHE.select(opt.isCall, FHE.gt(encPrice, opt.strike), FHE.lt(encPrice, opt.strike))`}
          </code>
          <br />
          Your strike price is never revealed — even to the oracle. Settlement is computed from the decrypted result.
        </div>
      </div>

      {/* Table legend */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="enc-field">🔒 Hidden</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          — strike and type are FHE ciphertexts. Visible only in the one-time mint calldata.
        </span>
      </div>
    </div>
  );
}
