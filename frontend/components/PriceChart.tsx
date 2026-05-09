'use client';

import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
} from 'lightweight-charts';

// Fetch last 100 1-minute candles from Binance REST, then stream live via WebSocket
const REST_URL  = 'https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1m&limit=100';
const WS_URL    = 'wss://stream.binance.com:9443/ws/ethusdt@kline_1m';

function toCandle(k: any[]): CandlestickData {
  return {
    time:  Math.floor(k[0] / 1000) as Time,
    open:  parseFloat(k[1]),
    high:  parseFloat(k[2]),
    low:   parseFloat(k[3]),
    close: parseFloat(k[4]),
  };
}

export function PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const seriesRef    = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const wsRef        = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // ── Create chart ─────────────────────────────────────────────────────────
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9ca3af',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.2)' },
        horzLine: { color: 'rgba(255,255,255,0.2)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', minimumWidth: 124 },
      timeScale:       { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 5 },
      autoSize: true,
      height: 280,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:       '#22c55e',
      downColor:     '#ef4444',
      borderVisible: false,
      wickUpColor:   '#22c55e',
      wickDownColor: '#ef4444',
      priceFormat:   { type: 'price', precision: 2, minMove: 0.01 },
    });

    chartRef.current  = chart;
    seriesRef.current = series;

    // ── Load historical candles ───────────────────────────────────────────────
    fetch(REST_URL)
      .then(r => r.json())
      .then((klines: any[][]) => {
        series.setData(klines.map(toCandle));
        chart.timeScale().fitContent();
      })
      .catch(() => {}); // silently ignore if Binance unreachable

    // ── Live stream ───────────────────────────────────────────────────────────
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const k   = msg.k;
      series.update({
        time:  Math.floor(k.t / 1000) as Time,
        open:  parseFloat(k.o),
        high:  parseFloat(k.h),
        low:   parseFloat(k.l),
        close: parseFloat(k.c),
      });
    };

    return () => {
      ws.close();
      chart.remove();
    };
  }, []);

  return <div ref={containerRef} style={{ width: '100%', height: 280 }} />;
}
