'use client';

import { useState } from 'react';
import { useAllow, useIsAllowed, useUserDecrypt } from '@zama-fhe/react-sdk';
import { POSITION_MANAGER_ADDRESS, FUTURES_ADDRESS } from '@/lib/contracts';

interface Props {
  handle: `0x${string}`;
}

const CONTRACTS: [`0x${string}`, `0x${string}`] = [FUTURES_ADDRESS, POSITION_MANAGER_ADDRESS];

const BOX: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  verticalAlign: 'middle',
  boxSizing: 'border-box',
  width: 90,
  height: 22,
  fontSize: 10,
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

const NULL_HANDLE = '0x0000000000000000000000000000000000000000000000000000000000000000';

export function DecryptCollateral({ handle }: Props) {
  const [clicked, setClicked] = useState(false);
  const { mutateAsync: allow, isPending: isAllowing } = useAllow();
  const { data: isAllowed } = useIsAllowed({ contractAddresses: CONTRACTS });

  const { data: decrypted, isPending: isDecrypting, isError, error } = useUserDecrypt(
    { handles: [{ handle, contractAddress: FUTURES_ADDRESS }] },
    { enabled: clicked && !!isAllowed && !!handle && handle !== NULL_HANDLE },
  );

  const value = decrypted?.[handle];

  if (value !== undefined) {
    const formatted = (Number(value) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return <span className="mono" style={{ color: 'var(--green)' }}>{formatted} cWETH</span>;
  }

  if (isError) {
    return <span style={{ ...BOX, color: 'var(--red)' }} title={error?.message}>Failed</span>;
  }

  if (clicked && isDecrypting) {
    return <span style={{ ...BOX, color: 'var(--text-dim)' }}>Decrypting…</span>;
  }

  async function handleClick() {
    if (!isAllowed) await allow(CONTRACTS).catch(() => {});
    setClicked(true);
  }

  return (
    <button style={BTN} disabled={isAllowing} onClick={handleClick}>
      {isAllowing ? 'Signing…' : '🔓 Decrypt'}
    </button>
  );
}
