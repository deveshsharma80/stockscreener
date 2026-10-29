import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, createChart } from 'lightweight-charts';
import { IST_OFFSET, aggregate, applyTick } from './candles.js';
import { api, describe, kindOf, price, segLabel, signed, store } from './Ticker.jsx';

// 3- and 5-minute candlestick chart for one instrument. History comes from
// Dhan's 1-minute intraday candles (refreshed every minute); the current
// candle moves live with the Ticker's price feed.

const INTERVALS = [3, 5];
const INTERVAL_KEY = 'stockhits.chartInterval';
const REFRESH_MS = 60_000;
const DAYS = 5;

// Up/down colours validated for colour-blind separation (see styles.css P&L bars)
const palette = (dark) =>
  dark
    ? { up: '#16a34a', down: '#ea580c', text: '#93a29a', grid: '#26312c', bg: '#151c19', cross: '#5b6b63' }
    : { up: '#15803d', down: '#c2410c', text: '#5f6b65', grid: '#e9ece7', bg: '#ffffff', cross: '#9aa39e' };
const prefersDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
const shift = (c) => ({ ...c, time: c.time + IST_OFFSET }); // the chart shows UTC; shift so axes read IST
const compactVol = (v) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));

export default function Chart({ secret, row, quote, marketOpen, onClose }) {
  const [minutes, setMinutes] = useState(() => (Number(store.get(INTERVAL_KEY)) === 5 ? 5 : 3));
  const [oneMin, setOneMin] = useState(null);
  const [error, setError] = useState('');
  const [hover, setHover] = useState(null);
  const [dark, setDark] = useState(prefersDark);
  const box = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const aggRef = useRef([]);
  const lastVolRef = useRef(null);
  const showVolume = kindOf(row.segment) !== 'idx';

  // Theme follows the system setting
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Load 1-minute history, refresh every minute while open
  useEffect(() => {
    let alive = true;
    let timer;
    setOneMin(null);
    setError('');
    const load = async () => {
      try {
        const j = await api(secret, 'candles', { params: { key: row.key, days: String(DAYS) } });
        if (alive) {
          setOneMin(j.candles);
          setError('');
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
      if (alive) timer = setTimeout(load, document.hidden ? REFRESH_MS * 3 : REFRESH_MS);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [secret, row.key]);

  // Create the chart once
  useEffect(() => {
    const p = palette(prefersDark());
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: p.bg }, textColor: p.text, fontFamily: 'system-ui, sans-serif', attributionLogo: true },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { vertLine: { color: p.cross, labelBackgroundColor: p.cross }, horzLine: { color: p.cross, labelBackgroundColor: p.cross } },
      localization: { locale: 'en-IN', priceFormatter: (v) => price.format(v) },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: p.up,
      downColor: p.down,
      wickUpColor: p.up,
      wickDownColor: p.down,
      borderVisible: false,
      priceLineVisible: true,
    });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    chart.subscribeCrosshairMove((param) => {
      const c = param.time != null ? param.seriesData.get(candles) : null;
      const v = param.time != null ? param.seriesData.get(volume) : null;
      setHover(c ? { ...c, volume: v?.value } : null);
    });
    chartRef.current = chart;
    seriesRef.current = { candles, volume };
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Re-colour on theme change
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const p = palette(dark);
    chart.applyOptions({
      layout: { background: { color: p.bg }, textColor: p.text },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      crosshair: { vertLine: { color: p.cross, labelBackgroundColor: p.cross }, horzLine: { color: p.cross, labelBackgroundColor: p.cross } },
    });
    seriesRef.current.candles.applyOptions({ upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down });
    seriesRef.current.volume.setData(aggRef.current.map((c) => volBar(c, p)));
  }, [dark]);

  // Rebuild candles when history or interval changes
  useEffect(() => {
    if (!oneMin || !chartRef.current) return;
    const agg = aggregate(oneMin, minutes);
    aggRef.current = agg;
    lastVolRef.current = null;
    const p = palette(dark);
    seriesRef.current.candles.setData(agg.map(shift));
    seriesRef.current.volume.setData(showVolume ? agg.map((c) => volBar(c, p)) : []);
    if (agg.length) chartRef.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, agg.length - 90), to: agg.length + 4 });
  }, [oneMin, minutes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates from the Ticker's quotes (market hours only)
  useEffect(() => {
    if (!marketOpen || quote?.ltp == null || !aggRef.current.length) return;
    const cum = quote.volume ?? null;
    const volDelta = cum != null && lastVolRef.current != null ? cum - lastVolRef.current : 0;
    lastVolRef.current = cum;
    const c = applyTick(aggRef.current, { time: Math.floor(Date.now() / 1000), price: quote.ltp, volDelta }, minutes);
    if (!c) return;
    seriesRef.current.candles.update(shift(c));
    if (showVolume) seriesRef.current.volume.update(volBar(c, palette(dark)));
  }, [quote?.ltp, quote?.volume, marketOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = aggRef.current[aggRef.current.length - 1];
  const shown = hover || (last && shift(last));
  const chg = shown ? shown.close - shown.open : 0;
  const when = shown ? new Date(shown.time * 1000).toISOString() : '';
  const legendTime = shown ? `${when.slice(8, 10)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(when.slice(5, 7)) - 1]} ${when.slice(11, 16)}` : '';

  const pick = (m) => {
    setMinutes(m);
    store.set(INTERVAL_KEY, String(m));
  };

  return (
    <section className="card tk-chart">
      <div className="card-head">
        <div className="tk-chart-title">
          <h2 className="mono">{describe(row)}</h2>
          <span className={`tk-seg ${kindOf(row.segment)}`}>{segLabel(row.segment)}</span>
          {quote?.ltp != null && <b className="mono tk-chart-ltp">{price.format(quote.ltp)}</b>}
        </div>
        <div className="form-actions">
          <div className="seg" role="group" aria-label="Candle interval">
            {INTERVALS.map((m) => (
              <button key={m} className={minutes === m ? 'on' : ''} onClick={() => pick(m)}>{m} min</button>
            ))}
          </div>
          <button className="link dp-close" onClick={onClose}>Close chart</button>
        </div>
      </div>
      <div className="tk-chart-legend mono" aria-live="off">
        {shown ? (
          <>
            <span className="muted-cell">{legendTime}</span>
            <span>O <b>{price.format(shown.open)}</b></span>
            <span>H <b>{price.format(shown.high)}</b></span>
            <span>L <b>{price.format(shown.low)}</b></span>
            <span>C <b className={chg > 0 ? 'pos' : chg < 0 ? 'neg' : ''}>{price.format(shown.close)}</b></span>
            <span className={chg > 0 ? 'pos' : chg < 0 ? 'neg' : ''}>{signed.format(chg)}</span>
            {showVolume && shown.volume != null && <span>Vol <b>{compactVol(shown.volume)}</b></span>}
          </>
        ) : (
          <span className="muted-cell">{error ? '' : 'Loading candles…'}</span>
        )}
      </div>
      <div className="tk-chart-box" ref={box} />
      {error && <p className="status err tk-chart-err">{error}</p>}
      {oneMin && !oneMin.length && !error && <p className="tk-note tk-chart-err">No intraday candles from Dhan for the last {DAYS} days.</p>}
      <div className="foot">
        {minutes}-minute candles built from Dhan 1-minute data, last {DAYS} days · Indian time ·{' '}
        {marketOpen ? 'current candle updates live with the Ticker' : 'market closed — showing completed candles'}
      </div>
    </section>
  );
}

function volBar(c, p) {
  const up = c.close >= c.open;
  return { time: c.time + IST_OFFSET, value: c.volume, color: `${up ? p.up : p.down}66` };
}
