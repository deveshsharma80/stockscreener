import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers } from 'lightweight-charts';
import { IST_OFFSET, aggregate, applyTick, crossovers, ema } from './candles.js';
import { api, describe, kindOf, price, segLabel, signed, store } from './Ticker.jsx';

// 3- and 5-minute candlestick chart for one instrument. History comes from
// Dhan's 1-minute intraday candles (refreshed every minute); the current
// candle moves live with the Ticker's price feed. Optional EMA crossover:
// fast (solid) and slow (dashed) EMA lines with Bull / Bear markers where they
// cross; crossings are marked on completed candles only.

const INTERVALS = [3, 5];
const INTERVAL_KEY = 'stockhits.chartInterval';
const REFRESH_MS = 60_000;
const DAYS = 5;
const EMA_KEY = 'stockhits.chartEma';
const DEFAULT_EMA = { on: true, fast: 9, slow: 21 };
function readEma() {
  try {
    const v = JSON.parse(store.get(EMA_KEY) || 'null');
    if (v && v.fast >= 2 && v.slow > v.fast && v.slow <= 200) return { on: v.on !== false, fast: v.fast, slow: v.slow };
  } catch {}
  return DEFAULT_EMA;
}

// Up/down colours validated for colour-blind separation (see styles.css P&L bars)
const palette = (dark) =>
  dark
    ? { up: '#16a34a', down: '#ea580c', text: '#93a29a', grid: '#26312c', bg: '#151c19', cross: '#5b6b63', fast: '#3b82f6', slow: '#c026d3' }
    : { up: '#15803d', down: '#c2410c', text: '#5f6b65', grid: '#e9ece7', bg: '#ffffff', cross: '#9aa39e', fast: '#1d4ed8', slow: '#a21caf' };
// EMA colours checked with the colour-blind validator against the candle colours;
// the slow line is also dashed so the two never rely on colour alone.
const prefersDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
const shift = (c) => ({ ...c, time: c.time + IST_OFFSET }); // the chart shows UTC; shift so axes read IST
const compactVol = (v) => (v >= 1e7 ? `${(v / 1e7).toFixed(2)}Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)}L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));

export default function Chart({ secret, row, quote, marketOpen, onClose, position, onExit }) {
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
  const [emaCfg, setEmaCfg] = useState(readEma);
  const [emaDraft, setEmaDraft] = useState(() => ({ fast: String(readEma().fast), slow: String(readEma().slow) }));
  const [cross, setCross] = useState({ last: null, count: 0 });
  const [exitState, setExitState] = useState(null); // { kind: 'busy'|'ok'|'err', text }
  const emaRef = useRef({ fast: [], slow: [], drawnLen: 0 });
  const emaCfgRef = useRef(emaCfg);
  emaCfgRef.current = emaCfg;
  const marketOpenRef = useRef(marketOpen);
  marketOpenRef.current = marketOpen;

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
    const lineOpts = { lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: true };
    const fastLine = chart.addSeries(LineSeries, { ...lineOpts, color: p.fast });
    const slowLine = chart.addSeries(LineSeries, { ...lineOpts, color: p.slow, lineStyle: LineStyle.Dashed });
    const markers = createSeriesMarkers(candles, []);
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    chart.subscribeCrosshairMove((param) => {
      const c = param.time != null ? param.seriesData.get(candles) : null;
      const v = param.time != null ? param.seriesData.get(volume) : null;
      const f = param.time != null ? param.seriesData.get(fastLine) : null;
      const sl = param.time != null ? param.seriesData.get(slowLine) : null;
      setHover(c ? { ...c, volume: v?.value, emaFast: f?.value, emaSlow: sl?.value } : null);
    });
    chartRef.current = chart;
    seriesRef.current = { candles, volume, fastLine, slowLine, markers };
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
    seriesRef.current.fastLine.applyOptions({ color: p.fast });
    seriesRef.current.slowLine.applyOptions({ color: p.slow });
    drawEma(true);
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
    drawEma(true);
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
    drawEma(false);
  }, [quote?.ltp, quote?.volume, marketOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // EMA lines + crossover markers. full=true redraws everything; otherwise only
  // the latest point moves, and markers refresh when a candle completes.
  function drawEma(full) {
    const s = seriesRef.current;
    if (!s.fastLine) return;
    const cfg = emaCfgRef.current;
    const agg = aggRef.current;
    if (!cfg.on || !agg.length) {
      s.fastLine.setData([]);
      s.slowLine.setData([]);
      s.markers.setMarkers([]);
      emaRef.current = { fast: [], slow: [], drawnLen: 0 };
      setCross({ last: null, count: 0 });
      return;
    }
    const fast = ema(agg, cfg.fast);
    const slow = ema(agg, cfg.slow);
    const prevLen = emaRef.current.drawnLen;
    emaRef.current = { fast, slow, drawnLen: agg.length };
    const toLine = (arr) => arr.map((v, i) => (v == null ? null : { time: agg[i].time + IST_OFFSET, value: v })).filter(Boolean);
    const n = agg.length - 1;
    if (full || prevLen !== agg.length) {
      s.fastLine.setData(toLine(fast));
      s.slowLine.setData(toLine(slow));
      // Don't mark a cross on the candle that is still forming
      const upTo = marketOpenRef.current ? n : agg.length;
      const xs = crossovers(agg, fast, slow, upTo);
      const p = palette(prefersDark());
      s.markers.setMarkers(
        xs.map((x) =>
          x.type === 'bull'
            ? { time: x.time + IST_OFFSET, position: 'belowBar', shape: 'arrowUp', color: p.up, text: 'Bull' }
            : { time: x.time + IST_OFFSET, position: 'aboveBar', shape: 'arrowDown', color: p.down, text: 'Bear' }
        )
      );
      setCross({ last: xs[xs.length - 1] || null, count: xs.length });
    } else {
      if (fast[n] != null) s.fastLine.update({ time: agg[n].time + IST_OFFSET, value: fast[n] });
      if (slow[n] != null) s.slowLine.update({ time: agg[n].time + IST_OFFSET, value: slow[n] });
    }
  }

  // Redraw when EMA settings change
  useEffect(() => {
    store.set(EMA_KEY, JSON.stringify(emaCfg));
    drawEma(true);
  }, [emaCfg]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyDraft = (draft) => {
    const f = parseInt(draft.fast, 10);
    const sl = parseInt(draft.slow, 10);
    if (f >= 2 && sl > f && sl <= 200) setEmaCfg((c) => ({ ...c, fast: f, slow: sl }));
  };
  const draftBad = !(parseInt(emaDraft.fast, 10) >= 2 && parseInt(emaDraft.slow, 10) > parseInt(emaDraft.fast, 10) && parseInt(emaDraft.slow, 10) <= 200);

  // Legend helpers: EMA values for the hovered candle, or the latest candle
  const emaAt = (c, which) => {
    if (!c) return null;
    if (hover) {
      const v = which === 'fast' ? hover.emaFast : hover.emaSlow;
      return v == null ? null : price.format(v);
    }
    const arr = emaRef.current[which] || [];
    const v = arr[arr.length - 1];
    return v == null ? null : price.format(v);
  };

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
          {position && (
            <span className="tk-chart-pos mono">
              Holding <b className={position.qty > 0 ? 'long' : 'short'}>{position.qty > 0 ? `+${position.qty}` : position.qty}</b> @ {price.format(position.avg)}
            </span>
          )}
          {position && (
            <button
              className="btn danger-outline tk-chart-exit"
              disabled={exitState?.kind === 'busy'}
              onClick={async () => {
                setExitState({ kind: 'busy', text: 'Exiting…' });
                try {
                  const t = await onExit(position);
                  setExitState({ kind: 'ok', text: `Exited: ${t.side === 'BUY' ? 'bought' : 'sold'} ${t.qty} @ ${price.format(t.price)} · brokerage ₹${price.format(t.charges)}` });
                } catch (e) {
                  setExitState({ kind: 'err', text: e.message });
                }
              }}
            >
              {exitState?.kind === 'busy' ? 'Exiting…' : 'Exit position'}
            </button>
          )}
          {exitState && exitState.kind !== 'busy' && <span className={`status ${exitState.kind}`}>{exitState.text}</span>}
          <div className="seg" role="group" aria-label="Candle interval">
            {INTERVALS.map((m) => (
              <button key={m} className={minutes === m ? 'on' : ''} onClick={() => pick(m)}>{m} min</button>
            ))}
          </div>
          <button className="btn btn-close" onClick={onClose}>Close chart</button>
        </div>
      </div>
      <div className="tk-ema-bar">
        <label className="switch">
          <input type="checkbox" checked={emaCfg.on} onChange={(e) => setEmaCfg((c) => ({ ...c, on: e.target.checked }))} />
          <span>EMA crossover</span>
        </label>
        <label className="tk-ema-in">
          Fast
          <input
            type="number" min="2" max="199" value={emaDraft.fast} disabled={!emaCfg.on}
            onChange={(e) => { const d = { ...emaDraft, fast: e.target.value }; setEmaDraft(d); applyDraft(d); }}
            aria-label="Fast EMA period"
          />
        </label>
        <label className="tk-ema-in">
          Slow
          <input
            type="number" min="3" max="200" value={emaDraft.slow} disabled={!emaCfg.on}
            onChange={(e) => { const d = { ...emaDraft, slow: e.target.value }; setEmaDraft(d); applyDraft(d); }}
            aria-label="Slow EMA period"
          />
        </label>
        {emaCfg.on && draftBad && <span className="status err">Fast must be 2+ and smaller than Slow (max 200)</span>}
        {emaCfg.on && !draftBad && (
          <span className="tk-ema-state">
            {trendText(emaRef.current, emaCfg)}
            {cross.last && (
              <>
                {' · '}last cross{' '}
                <b className={cross.last.type === 'bull' ? 'pos' : 'neg'}>{cross.last.type === 'bull' ? 'Bull ▲' : 'Bear ▼'}</b> at {fmtTime(cross.last.time)}
              </>
            )}
          </span>
        )}
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
            {emaCfg.on && (
              <>
                <span><i className="ema-swatch fast" />EMA {emaCfg.fast} <b>{emaAt(shown, 'fast') ?? '—'}</b></span>
                <span><i className="ema-swatch slow" />EMA {emaCfg.slow} <b>{emaAt(shown, 'slow') ?? '—'}</b></span>
              </>
            )}
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
        <span className="tk-chart-credit">
          Charts by{' '}
          <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a> Lightweight Charts™ · Copyright © TradingView, Inc.
        </span>
      </div>
    </section>
  );
}

function volBar(c, p) {
  const up = c.close >= c.open;
  return { time: c.time + IST_OFFSET, value: c.volume, color: `${up ? p.up : p.down}66` };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Epoch seconds (UTC) → "29 Oct 10:21" in IST */
function fmtTime(t) {
  const d = new Date((t + IST_OFFSET) * 1000).toISOString();
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(11, 16)}`;
}

/** "EMA 9 above 21 (bullish)" from the latest EMA values */
function trendText({ fast, slow }, cfg) {
  const f = fast?.[fast.length - 1];
  const s = slow?.[slow.length - 1];
  if (f == null || s == null) return `Not enough candles yet for EMA ${cfg.slow}`;
  return f > s ? `EMA ${cfg.fast} above ${cfg.slow} — bullish` : f < s ? `EMA ${cfg.fast} below ${cfg.slow} — bearish` : `EMA ${cfg.fast} = ${cfg.slow}`;
}
