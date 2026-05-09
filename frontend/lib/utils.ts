import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function shorten(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatUsd(raw: bigint, decimals = 8, precision = 2): string {
  const val = Number(raw) / Math.pow(10, decimals);
  return val.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: precision,
  });
}

export function formatPrice(raw: bigint): string {
  // 8 decimals (Chainlink format)
  return formatUsd(raw, 8, 2);
}

export function formatAmount(raw: bigint, decimals: number, precision = 4): string {
  const val = Number(raw) / Math.pow(10, decimals);
  return val.toLocaleString(undefined, { maximumFractionDigits: precision });
}

export function timeAgo(ts: bigint): string {
  const seconds = Math.floor(Date.now() / 1000) - Number(ts);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatExpiry(ts: bigint): string {
  const date = new Date(Number(ts) * 1000);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function priceChange(current: bigint, entry: bigint): { pct: number; positive: boolean } {
  if (entry === 0n) return { pct: 0, positive: true };
  const pct = (Number(current - entry) / Number(entry)) * 100;
  return { pct: Math.abs(pct), positive: pct >= 0 };
}
