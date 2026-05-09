'use client';

import { useState } from 'react';
import { useAccount, useWriteContract } from 'wagmi';
import { useWrap } from '@/hooks/useWrap';
import { ERC20_ABI, UNDERLYING_ADDRESS } from '@/lib/contracts';

export function WrapPanel() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { wrapAndDeposit, isMockToken, isPending, step, error } = useWrap();
  const [amount, setAmount] = useState('');
  const [faucetPending, setFaucetPending] = useState(false);
  const [faucetDone, setFaucetDone] = useState(false);

  async function handleFaucet() {
    setFaucetPending(true);
    setFaucetDone(false);
    try {
      await writeContractAsync({
        address: UNDERLYING_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'faucet',
        args: [],
      });
      setFaucetDone(true);
    } catch {
      // ignore
    } finally {
      setFaucetPending(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) return;
    const raw = BigInt(Math.round(parsed * 1e6)) as unknown as bigint;
    try {
      await wrapAndDeposit(raw);
      setAmount('');
    } catch {
      // error shown via hook
    }
  }

  return (
    <div className="glass" style={{ padding: 20, height: '100%', boxSizing: 'border-box' }}>
      <p className="panel-title" style={{ marginBottom: 4 }}>
        {isMockToken ? 'Mint & Deposit cWETH' : 'Wrap & Deposit cWETH'}
      </p>
      <p style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 16, lineHeight: 1.5 }}>
        {isMockToken
          ? 'Mint test cWETH and deposit into the FHE collateral vault.'
          : 'Step 1: Get test WETH from faucet. Step 2: Wrap → cWETH and deposit into the FHE vault.'}
      </p>

      {/* Faucet button — wrapper path only */}
      {!isMockToken && (
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="btn-ghost"
            style={{ width: '100%', justifyContent: 'center', fontSize: 12 }}
            disabled={faucetPending || !address}
            onClick={handleFaucet}
          >
            {faucetPending ? '⟳ Requesting…' : faucetDone ? '✓ Got 10 test WETH' : '🚰 Get 10 test WETH (Faucet)'}
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <input
              type="number"
              placeholder="0.0"
              min="0"
              step="any"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              disabled={isPending}
              style={{
                width: '100%',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                padding: '10px 52px 10px 12px',
                fontSize: 14,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text)',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <span style={{
              position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
              fontSize: 11, color: 'var(--text-dim)', pointerEvents: 'none',
            }}>
              WETH
            </span>
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={isPending || !amount}
            style={{ flexShrink: 0, padding: '10px 18px' }}
          >
            {isPending ? '…' : isMockToken ? 'Mint' : 'Wrap'}
          </button>
        </div>

        {/* Quick-fill buttons */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {['0.1', '0.5', '1'].map(v => (
            <button
              key={v}
              type="button"
              onClick={() => setAmount(v)}
              disabled={isPending}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 100,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)',
                cursor: 'pointer',
              }}
            >
              {v}
            </button>
          ))}
        </div>
      </form>

      {/* Status */}
      {isPending && step && (
        <div style={{
          padding: '8px 12px',
          background: 'rgba(191,90,242,0.06)',
          border: '1px solid rgba(191,90,242,0.15)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12, color: 'var(--purple)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
          {step}
        </div>
      )}

      {!isPending && step === 'Done!' && (
        <div style={{
          padding: '8px 12px',
          background: 'rgba(50,215,75,0.06)',
          border: '1px solid rgba(50,215,75,0.15)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12, color: 'var(--green)',
        }}>
          ✓ Deposit complete
        </div>
      )}

      {error && (
        <div style={{
          padding: '8px 12px',
          background: 'rgba(255,69,58,0.06)',
          border: '1px solid rgba(255,69,58,0.15)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 11, color: 'var(--red)',
          wordBreak: 'break-word',
        }}>
          {error}
        </div>
      )}

      {/* FHE note */}
      <div style={{
        marginTop: 12,
        fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.6,
        borderTop: '1px solid var(--border)',
        paddingTop: 10,
      }}>
        🔒 Amount is FHE-encrypted before submission. No plaintext value is sent on-chain.
      </div>
    </div>
  );
}
