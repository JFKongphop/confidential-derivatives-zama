'use client';

import { useState, useEffect } from 'react';
import { useAccount, useWaitForTransactionReceipt } from 'wagmi';
import { writeContract, readContract, waitForTransactionReceipt } from 'wagmi/actions';
import { usePublicDecrypt } from '@zama-fhe/react-sdk';
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice';
import { useOpenPosition } from '@/hooks/useOpenPosition';
import { useFuturesPositions } from '@/hooks/useFuturesPositions';
import { formatPrice } from '@/lib/utils';
import { wagmiConfig } from '@/lib/wagmi';
import { FUTURES_ADDRESS, FUTURES_ABI } from '@/lib/contracts';
import { DecryptCollateral } from './DecryptCollateral';
import { DecryptDirection } from './DecryptDirection';

function EncField() {
  return (
    <span className="enc-field">
      <span>🔒</span>
      <span>FHE</span>
    </span>
  );
}

export function FuturesSection() {
  const { address, isConnected } = useAccount();
  const { price } = useChainlinkPrice();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [leverage, setLeverage]     = useState('5');
  const [collateral, setCollateral] = useState('1');
  const [showForm, setShowForm]     = useState(false);
  const [direction, setDirection]   = useState<'long' | 'short'>('long');
  const [closingId, setClosingId]   = useState<number | null>(null);
  const [closedIds, setClosedIds]   = useState<Set<number>>(new Set());
  const [closeStatus, setCloseStatus] = useState<string | null>(null);
  const [openError, setOpenError]   = useState<string | null>(null);

  const publicDecrypt = usePublicDecrypt();

  const { openPosition, isEncrypting, isWriting, isPending } = useOpenPosition();
  const { positions, refetch: refetchPositions } = useFuturesPositions();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });

  // Refetch immediately when tx is confirmed on-chain
  useEffect(() => {
    if (txConfirmed) {
      refetchPositions();
      window.dispatchEvent(new CustomEvent('collateral:changed'));
    }
  }, [txConfirmed]);

  // Poll every 15s so new positions appear without any user action
  useEffect(() => {
    const id = setInterval(() => refetchPositions(), 30_000);
    return () => clearInterval(id);
  }, []);

  const [positionMeta, setPositionMeta] = useState<Record<number, { leverage: number; direction: string }>>({});

  useEffect(() => {
    if (!address) return;
    const stored = localStorage.getItem(`futures-meta-${address}`);
    if (stored) setPositionMeta(JSON.parse(stored));
  }, [address]);

  function savePositionMeta(id: number, lev: number, dir: string) {
    setPositionMeta(prev => {
      const next = { ...prev, [id]: { leverage: lev, direction: dir } };
      if (address) localStorage.setItem(`futures-meta-${address}`, JSON.stringify(next));
      return next;
    });
  }

  const isDeployed = true; // set to FUTURES_ADDRESS check once deployed

  async function handleOpen() {
    setOpenError(null);
    try {
      const hash = await openPosition({
        collateralAmount: BigInt(Math.round(parseFloat(collateral) * 1e6)),
        leverage: BigInt(Math.max(1, Math.min(10, parseInt(leverage, 10) || 5))),
        isLong: direction === 'long',
      });
      setTxHash(hash);
      // remember leverage + direction client-side (not stored on-chain)
      const positionId = positions.length; // next ID = current count
      savePositionMeta(positionId, parseInt(leverage, 10) || 5, direction);
      setShowForm(false);
      setTimeout(() => refetchPositions(), 4000); // refresh after block
    } catch (e: any) {
      if (e?.code === 4001 || /user rejected|user denied/i.test(e?.message ?? '')) return;
      setOpenError(e?.message ?? 'Encryption or transaction failed');
    }
  }

  async function handleClose(positionId: number) {
    setClosingId(positionId);
    setCloseStatus('Step 1/3: Requesting close…');
    try {
      // Step 1: closePosition — makes encrypted handles publicly decryptable
      const closeTxHash = await writeContract(wagmiConfig, {
        address: FUTURES_ADDRESS,
        abi: FUTURES_ABI,
        functionName: 'closePosition',
        args: [BigInt(positionId)],
        gas: 15_000_000n,
      });

      setCloseStatus('Step 1/3: Waiting for block…');
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: closeTxHash });

      // Extract requestId from PositionCloseRequested event log
      // Topic[0] = event sig, args are non-indexed so in data
      // Easier: read pendingCloses by fetching the emitted event or
      // scan logs for the event and decode requestId from data
      const CLOSE_REQUESTED_TOPIC = '0x' + 'PositionCloseRequested(address,uint256,uint256)'
        .split('').reduce((h, c) => h, ''); // placeholder — parse from logs below

      // Parse requestId from receipt logs: data = abi.encode(positionId, requestId)
      let requestId: bigint | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== FUTURES_ADDRESS.toLowerCase()) continue;
        // PositionCloseRequested has 2 non-indexed params: positionId(uint256), requestId(uint256)
        // log.data = 0x + 32 bytes positionId + 32 bytes requestId
        if (log.data && log.data.length === 2 + 128) {
          const rid = BigInt('0x' + log.data.slice(66)); // last 32 bytes
          requestId = rid;
          break;
        }
      }

      if (requestId === null) throw new Error('Could not find requestId in receipt logs');

      // Step 2: Read encrypted handles from pendingCloses
      setCloseStatus('Step 2/3: Fetching KMS decryption…');
      const reqRaw = await readContract(wagmiConfig, {
        address: FUTURES_ADDRESS,
        abi: FUTURES_ABI,
        functionName: 'pendingCloses',
        args: [requestId],
      }) as unknown as [string, bigint, bigint, `0x${string}`, `0x${string}`, `0x${string}`];

      // tuple: [user, positionId, currentPrice, sizeHandle, collateralHandle, isLongHandle]
      const handles: `0x${string}`[] = [reqRaw[3], reqRaw[4], reqRaw[5]];

      // Step 3: Public decrypt via Zama KMS — no user signature needed
      const decrypted = await publicDecrypt.mutateAsync(handles);

      setCloseStatus('Step 3/3: Settling P&L…');
      const fulfillHash = await writeContract(wagmiConfig, {
        address: FUTURES_ADDRESS,
        abi: FUTURES_ABI,
        functionName: 'fulfillClose',
        args: [requestId, decrypted.abiEncodedClearValues, decrypted.decryptionProof],
        gas: 5_000_000n,
      });

      await waitForTransactionReceipt(wagmiConfig, { hash: fulfillHash });
      // Optimistically remove from table immediately
      setClosedIds(prev => new Set(prev).add(positionId));
      setCloseStatus('Closed! ✓');
      window.dispatchEvent(new CustomEvent('collateral:changed'));
      setTimeout(() => { setCloseStatus(null); refetchPositions(); }, 3000);
    } catch (e: any) {
      if (e?.code === 4001 || /user rejected|user denied/i.test(e?.message ?? '')) return;
      console.error('Close failed', e);
      setCloseStatus('Error: ' + (e?.shortMessage ?? e?.message ?? 'unknown'));
      setTimeout(() => setCloseStatus(null), 4000);
    } finally {
      setClosingId(null);
    }
  }

  function toggleShowForm() {
    setShowForm(v => !v);
  }

  return (
    <div className="glass" style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p className="panel-title" style={{ marginBottom: 0 }}>Futures</p>
        {mounted && isConnected && (
          <button className="btn-primary" onClick={toggleShowForm}>
            {showForm ? 'Cancel' : '+ Open Position'}
          </button>
        )}
      </div>

      {/* Open position form */}
      {showForm && (
        <div style={{
          marginBottom: 20,
          padding: 16,
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
        }}>
          <p className="label" style={{ marginBottom: 12 }}>New Position</p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
            {/* Direction */}
            <div>
              <p className="label" style={{ marginBottom: 6 }}>Direction</p>
              <div className="tab-bar" style={{ width: '100%' }}>
                <button
                  className={`tab ${direction === 'long' ? 'active' : ''}`}
                  style={{ flex: 1, color: direction === 'long' ? 'var(--green)' : undefined }}
                  onClick={() => setDirection('long')}
                >
                  Long ▲
                </button>
                <button
                  className={`tab ${direction === 'short' ? 'active' : ''}`}
                  style={{ flex: 1, color: direction === 'short' ? 'var(--red)' : undefined }}
                  onClick={() => setDirection('short')}
                >
                  Short ▼
                </button>
              </div>
            </div>

            {/* Collateral */}
            <div>
              <p className="label" style={{ marginBottom: 6 }}>Collateral (cWETH)</p>
              <input
                type="number"
                className="input"
                min={1}
                value={collateral}
                onChange={e => setCollateral(e.target.value)}
                placeholder="e.g. 1"
              />
            </div>

            {/* Leverage */}
            <div>
              <p className="label" style={{ marginBottom: 6 }}>Leverage (1–10×)</p>
              <input
                type="number"
                className="input"
                min={1}
                max={10}
                value={leverage}
                onChange={e => setLeverage(e.target.value)}
                placeholder="e.g. 5"
              />
            </div>
          </div>

          {/* FHEVM note */}
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
            <strong style={{ color: 'var(--purple)' }}>🔒 FHEVM Encrypted Inputs</strong>
            <br />
            Collateral and direction are encrypted client-side using the FHEVM SDK before submission.
            The contract never sees your plaintext values — only ciphertexts and proofs.
          </div>

          {openError && (
            <p style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{openError}</p>
          )}

          <button
            className="btn-primary"
            style={{ width: '100%' }}
            disabled={!mounted || !isConnected || isPending || isConfirming}
            onClick={handleOpen}
          >
            {isEncrypting ? '🔒 Encrypting…' : isWriting ? '✍️ Signing…' : isConfirming ? 'Confirming…' : '🔒 Open Position (Encrypted)'}
          </button>
        </div>
      )}

      {/* Positions table */}
      <div className="table-wrapper">
        <table>
          <colgroup>
            <col style={{ width: '5%' }} />
            <col style={{ width: '15%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '20%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>ID</th>
              <th>Entry Price</th>
              <th>P&amp;L</th>
              <th>Collateral</th>
              <th>Direction</th>
              <th>Leverage</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {positions.filter(pos => !closedIds.has(pos.id)).map((pos) => {
              const entryUsd = Number(pos.entryPrice) / 1e8;
              const currentUsd = price ? Number(price) / 1e8 : entryUsd;
              const pnlPct = entryUsd > 0 ? ((currentUsd - entryUsd) / entryUsd) * 100 : 0;
              const positive = pnlPct >= 0;
              const openedDate = new Date(Number(pos.openedAt) * 1000).toLocaleString();
              const meta = positionMeta[pos.id];

              return (
                <tr key={pos.id}>
                  <td>
                    <span className="mono" style={{ color: 'var(--text-muted)' }}>#{pos.id}</span>
                  </td>
                  <td>
                    <span className="mono">${entryUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                  </td>
                  <td>
                    <span className="mono" style={{ color: positive ? 'var(--green)' : 'var(--red)' }}>
                      {positive ? '+' : ''}{pnlPct.toFixed(2)}%
                    </span>
                  </td>
                  <td><DecryptCollateral handle={pos.collateralHandle} /></td>
                  <td>
                    {meta
                      ? <span className="badge" style={{ color: meta.direction === 'long' ? 'var(--green)' : 'var(--red)' }}>
                          {meta.direction === 'long' ? 'Long ▲' : 'Short ▼'}
                        </span>
                      : <DecryptDirection handle={pos.directionHandle} />
                    }
                  </td>
                  <td>
                    {meta ? (
                      <span className="badge badge-gray">{meta.leverage}×</span>
                    ) : (
                      <span className="badge badge-gray" title={openedDate}>🔒 enc</span>
                    )}
                  </td>
                  <td>
                    <button
                      className="btn-danger"
                      style={{ padding: '5px 14px', fontSize: 11 }}
                      disabled={!isDeployed || closingId !== null}
                      onClick={() => handleClose(pos.id)}
                    >
                      {closingId === pos.id ? '…' : 'Close'}
                    </button>
                  </td>
                </tr>
              );
            })}

            {positions.filter(pos => !closedIds.has(pos.id)).length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 32 }}>
                  No open positions
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Close status banner */}
      {closeStatus && (
        <div style={{
          marginTop: 10,
          padding: '8px 14px',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12,
          background: closeStatus.startsWith('Error') ? 'rgba(255,80,80,0.10)' : 'rgba(100,220,150,0.10)',
          border: `1px solid ${closeStatus.startsWith('Error') ? 'rgba(255,80,80,0.25)' : 'rgba(100,220,150,0.25)'}`,
          color: closeStatus.startsWith('Error') ? 'var(--red)' : 'var(--green)',
        }}>
          {closeStatus}
        </div>
      )}

      {/* Encrypted fields note */}
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="enc-field">🔒 Encrypted</span>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          — size, collateral, and direction are FHE ciphertexts stored on-chain. Only you can decrypt them.
        </span>
      </div>
    </div>
  );
}
