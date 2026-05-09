'use client';

import { useState, useEffect } from 'react';
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { useChainlinkPrice } from '@/hooks/useChainlinkPrice';
import { usePlaceOrder } from '@/hooks/usePlaceOrder';
import { useLimitOrders } from '@/hooks/useLimitOrders';
import { DecryptLOBDirection } from './DecryptLOBDirection';
import { DecryptLOBLimitPrice } from './DecryptLOBLimitPrice';
import { DecryptLOBCollateral } from './DecryptLOBCollateral';
import { formatPrice } from '@/lib/utils';
import { LIMIT_ORDER_BOOK_ADDRESS, LOB_ABI } from '@/lib/contracts';
import { wagmiConfig } from '@/lib/wagmi';
import { writeContract } from 'wagmi/actions';

function EncField() {
  return (
    <span className="enc-field">
      <span>🔒</span>
      <span>FHE</span>
    </span>
  );
}

export function LimitOrderBookSection() {
  const { address, isConnected } = useAccount();
  const { price } = useChainlinkPrice();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [showForm, setShowForm]       = useState(false);
  const [direction, setDirection]     = useState<'long' | 'short'>('long');
  const [collateral, setCollateral]   = useState('1');
  const [limitPrice, setLimitPrice]   = useState('');
  const [leverage, setLeverage]       = useState('5');
  const [placeError, setPlaceError]   = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  const { placeOrder, isEncrypting, isWriting, isPending } = usePlaceOrder();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, isSuccess: txConfirmed } = useWaitForTransactionReceipt({ hash: txHash });

  const { orders, isLoading: isLoadingOrders, refetch } = useLimitOrders();

  // Refetch when tx confirmed, and poll every 15s
  useEffect(() => {
    if (txConfirmed) {
      refetch();
      window.dispatchEvent(new CustomEvent('collateral:changed'));
    }
  }, [txConfirmed]);
  useEffect(() => {
    const id = setInterval(() => refetch(), 30_000);
    return () => clearInterval(id);
  }, []);

  const isDeployed = LIMIT_ORDER_BOOK_ADDRESS !== '0x0000000000000000000000000000000000000000';

  async function handlePlace() {
    setPlaceError(null);
    const lp = parseFloat(limitPrice);
    if (!lp || lp <= 0) { setPlaceError('Enter a valid limit price'); return; }
    try {
      const hash = await placeOrder({
        collateralAmount: BigInt(Math.round(parseFloat(collateral) * 1e6)),
        limitPrice: BigInt(Math.round(lp * 1e8)),
        isLong: direction === 'long',
        leverage: BigInt(Math.max(1, Math.min(10, parseInt(leverage, 10) || 5))),
      });
      setTxHash(hash);
      setShowForm(false);
      await refetch();
    } catch (e: any) {
      if (e?.code === 4001 || /user rejected|user denied/i.test(e?.message ?? '')) return;
      setPlaceError(e?.message ?? 'Failed to place order');
    }
  }

  async function handleCancel(localId: number, onChainOrderId: number) {
    setCancellingId(localId);
    try {
      await writeContract(wagmiConfig, {
        address: LIMIT_ORDER_BOOK_ADDRESS,
        abi: LOB_ABI,
        functionName: 'cancelOrder',
        args: [BigInt(onChainOrderId)],
        gas: 5_000_000n,
      });
      window.dispatchEvent(new CustomEvent('collateral:changed'));
      await refetch();
    } catch (e) {
      console.error('Cancel failed', e);
    } finally {
      setCancellingId(null);
    }
  }

  const currentPrice = price ? Number(price) / 1e8 : null;

  return (
    <div className="glass" style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p className="panel-title" style={{ marginBottom: 0 }}>Limit Orders</p>
        {mounted && isConnected && (
          <button className="btn-primary" onClick={() => setShowForm(v => !v)}>
            {showForm ? 'Cancel' : '+ Place Order'}
          </button>
        )}
      </div>

      {/* Place order form */}
      {showForm && (
        <div style={{
          marginBottom: 20,
          padding: 16,
          background: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
        }}>
          <p className="label" style={{ marginBottom: 12 }}>New Limit Order</p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
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

            {/* Limit price */}
            <div>
              <p className="label" style={{ marginBottom: 6 }}>
                Limit Price{currentPrice ? <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>({formatPrice(price!)})</span> : null}
              </p>
              <input
                type="number"
                className="input"
                value={limitPrice}
                onChange={e => setLimitPrice(e.target.value)}
                placeholder={currentPrice ? String(Math.round(currentPrice)) : 'e.g. 2300'}
              />
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
                placeholder="e.g. 100"
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

          {/* FHE note */}
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
            <strong style={{ color: 'var(--purple)' }}>🔒 FHEVM Encrypted Order</strong>
            <br />
            Collateral, limit price, and direction are all encrypted client-side. No keeper or MEV bot can see your target entry price until the order is filled.
          </div>

          {placeError && (
            <p style={{ color: 'var(--red)', fontSize: 12, marginBottom: 8 }}>{placeError}</p>
          )}

          <button
            className="btn-primary"
            style={{ width: '100%' }}
            disabled={!mounted || !isConnected || !isDeployed || isPending || isConfirming}
            onClick={handlePlace}
          >
            {isEncrypting ? '🔒 Encrypting…' : isWriting ? '✍️ Signing…' : isConfirming ? 'Confirming…' : '🔒 Place Limit Order (Encrypted)'}
          </button>
        </div>
      )}

      {/* Orders table */}
      <div className="table-wrapper">
        <table>
          <colgroup>
            <col style={{ width: '12%' }} />
            <col style={{ width: '16%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '14%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>ID</th>
              <th>Direction</th>
              <th>Limit Price</th>
              <th>Collateral</th>
              <th>Leverage</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {isLoadingOrders ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '24px 0' }}>
                  Loading orders…
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: '24px 0' }}>
                  No orders placed yet
                </td>
              </tr>
            ) : (
              orders.map((order, idx) => (
                <tr key={order.orderId.toString()}>
                  <td style={{ color: 'var(--text-dim)' }}>#{order.orderId.toString()}</td>
                  <td>{order.isLongHandle     ? <DecryptLOBDirection  handle={order.isLongHandle}     /> : <EncField />}</td>
                  <td>{order.limitPriceHandle  ? <DecryptLOBLimitPrice handle={order.limitPriceHandle}  /> : <EncField />}</td>
                  <td>{order.collateralHandle  ? <DecryptLOBCollateral handle={order.collateralHandle}  /> : <EncField />}</td>
                  <td><span className="badge badge-gray">{order.leverage.toString()}×</span></td>
                  <td>
                    <span className={`badge ${
                      order.status === 'open' ? 'badge-green' :
                      order.status === 'filled' ? 'badge-blue' : 'badge-gray'
                    }`}>
                      {order.status}
                    </span>
                  </td>
                  <td>
                    {order.status === 'open' && (
                      <button
                        className="btn-danger"
                        style={{ padding: '5px 14px', fontSize: 11 }}
                        disabled={cancellingId === idx}
                        onClick={() => handleCancel(idx, Number(order.orderId))}
                      >
                        {cancellingId === idx ? '…' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Info note */}
      <div style={{
        marginTop: 12,
        padding: '10px 14px',
        background: 'var(--bg-elevated)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 11,
        color: 'var(--text-dim)',
        lineHeight: 1.6,
      }}>
        <span className="enc-field" style={{ marginRight: 6 }}>🔒 Encrypted</span>
        — limit price, collateral, and direction are FHE ciphertexts. A keeper calls <code style={{ fontFamily: 'var(--font-mono)' }}>checkOrder</code> to trigger when your price is hit.
      </div>
    </div>
  );
}
