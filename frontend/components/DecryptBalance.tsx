'use client';

import { useState, useEffect, useRef } from 'react';
import { useAllow, useIsAllowed, useUserDecrypt } from '@zama-fhe/react-sdk';
import { COLLATERAL_ADDRESS } from '@/lib/contracts';

interface Props {
  handle: `0x${string}`;
}

const CONTRACTS: [`0x${string}`] = [COLLATERAL_ADDRESS];

const NULL_HANDLE = '0x0000000000000000000000000000000000000000000000000000000000000000';

const BOX: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxSizing: 'border-box',
  width: 110,
  height: 24,
  fontSize: 11,
  borderRadius: 4,
  whiteSpace: 'nowrap',
};

const BTN: React.CSSProperties = {
  ...BOX,
  border: '1px solid var(--purple)',
  background: 'transparent',
  color: 'var(--purple)',
  cursor: 'pointer',
};

export function DecryptBalance({ handle }: Props) {
  const [clicked, setClicked] = useState(false);
  const [decryptKey, setDecryptKey] = useState(0); // bump to force re-decrypt
  const prevHandle = useRef(handle);

  // If the handle ever changes (new deposit/withdraw/trade), auto-re-decrypt if already unlocked
  useEffect(() => {
    if (prevHandle.current !== handle) {
      prevHandle.current = handle;
      // If not clicked yet, nothing to do — button will appear when user wants
      // If already showing decrypted value, keep clicked=true so it auto-re-decrypts with new handle
      if (!handle || handle === NULL_HANDLE) {
        setClicked(false);
      }
      // else: clicked stays true → useUserDecrypt re-runs automatically with new handle key
    }
  }, [handle]);

  const { mutateAsync: allow, isPending: isAllowing } = useAllow();
  const { data: isAllowed } = useIsAllowed({ contractAddresses: CONTRACTS });

  const { data: decrypted, isPending: isDecrypting, isError, error } = useUserDecrypt(
    { handles: [{ handle, contractAddress: COLLATERAL_ADDRESS }] },
    { enabled: clicked && !!isAllowed && !!handle && handle !== NULL_HANDLE },
  );

  const raw = decrypted?.[handle];

  if (raw !== undefined) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
          {(Number(raw) / 1e6).toFixed(4)} cWETH
        </span>
        <button
          style={{ ...BTN, width: 'auto', padding: '0 8px', fontSize: 10, border: '1px solid var(--border)', color: 'var(--text-dim)' }}
          onClick={() => { setClicked(false); setDecryptKey(k => k + 1); }}
        >
          ↻
        </button>
      </div>
    );
  }

  if (isError) return <span style={{ ...BOX, color: 'var(--red)' }} title={error?.message}>Failed</span>;

  if (clicked && isDecrypting) return <span style={{ ...BOX, color: 'var(--text-dim)' }}>Decrypting…</span>;

  async function handleClick() {
    if (!isAllowed) await allow(CONTRACTS).catch(() => {});
    setClicked(true);
  }

  return (
    <button style={BTN} disabled={isAllowing} onClick={handleClick}>
      {isAllowing ? 'Signing…' : '🔓 Decrypt Balance'}
    </button>
  );
}
