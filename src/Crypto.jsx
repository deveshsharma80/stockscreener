import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers } from 'lightweight-charts';
import { SECRET_KEY, SecretGate, store } from './Ticker.jsx';
import { triggerHit, useCryptoBook } from './cryptoBook.js';
import CryptoTrade from './CryptoTrade.jsx';
import { INTERVALS, applyKline, fmtCompact, fmtPrice, isFutures, klines, markFutures, stream, tickers, usdtMarkets, useProxy } from './binance.js';
import { bollinger, crossovers, ema, readings, rsi } from './indicators.js';
import { IST_OFFSET } from './candles.js';

// Crypto (Binance spot, USDT pairs): a watchlist with live prices and
// RSI / EMA / Bollinger readings, and an hourly / daily candle chart with
// EMA lines, Bollinger Bands and an RSI panel. Prices come straight from
// Binance's free public market data; the coin list is saved on the server.

const CFG_KEY = 'stockhits.cryptoInd';
const INT_KEY = 'stockhits.cryptoInterval';
const DEFAULT_CFG = { emaOn: true, emaFast: 20, emaSlow: 50, bbOn: true, bbPeriod: 20, bbMult: 2, rsiOn: true, rsi: 14 };
const HISTORY = { '1h': 3000, '1d': 1000 }; // ≈ 4 months hourly, ≈ 2¾ years daily
const SCAN_CANDLES = 300;
const SCAN_EVERY = { '1h': 5 * 60_000, '1d': 30 * 60_000 };

function readCfg() {
  try {
    const v = JSON.parse(store.get(CFG_KEY) || 'null');
    if (v) return { ...DEFAULT_CFG, ...v };
  } catch {}
  return DEFAULT_CFG;
}
const readInterval = () => (store.get(INT_KEY) === '1d' ? '1d' : '1h');
const symbolFromHash = () => (window.location.hash.split('?')[1] || '').match(/(?:^|&)s=([A-Z0-9]+)/)?.[1] || '';
const coin = (s) => s.replace(/USDT$/, '');
/** Futures-only coin (USDⓈ-M perpetual, no spot pair): prices and candles come from Binance Futures */
const PerpTag = () => <span className="ind-tag perp" title="Binance USDⓈ-M perpetual (no spot pair): prices and candles from Binance Futures">Perp</span>;
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');

export async function cryptoApi(secret, action, { method = 'GET', body } = {}) {
  return api(secret, action, { method, body });
}
async function api(secret, action, { method = 'GET', body } = {}) {
  const r = await fetch(`/api/crypto${method === 'GET' ? `?action=${action}` : ''}`, {
    method,
    cache: 'no-store',
    headers: { 'X-Webhook-Secret': secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify({ action, ...body }) : undefined,
  });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
  return j;
}

export default function Crypto({ subview = 'watchlist', actionsEl = null }) {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [checking, setChecking] = useState(Boolean(store.get(SECRET_KEY)));
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [symbols, setSymbols] = useState([]);
  const [notes, setNotes] = useState({}); // symbol -> { addedBy, note } (coins added by the scan)
  const [ticks, setTicks] = useState({}); // live 24 h stats per symbol
  const [feed, setFeed] = useState('connecting'); // live | connecting | down
  const [interval, setIntervalState] = useState(readInterval);
  const [cfg, setCfgState] = useState(readCfg);
  const [chartSym, setChartSym] = useState(symbolFromHash);
  const cb = useCryptoBook(unlocked ? secret : '', { autoload: true }); // paper-trading book for the Trade popup
  const [tradeSym, setTradeSym] = useState(null);
  const toggleTrade = (s) => setTradeSym((x) => (x === s ? null : s));

  const setIntervalV = (v) => {
    setIntervalState(v);
    store.set(INT_KEY, v);
  };
  const setCfg = (patch) =>
    setCfgState((c) => {
      const n = { ...c, ...patch };
      store.set(CFG_KEY, JSON.stringify(n));
      return n;
    });

  const load = useCallback(async (s) => {
    try {
      const j = await api(s, 'watchlist');
      markFutures((j.items || []).filter((r) => r.market === 'futures').map((r) => r.symbol)); // before prices load
      setSymbols(j.symbols);
      setNotes(Object.fromEntries((j.items || []).filter((r) => r.addedBy).map((r) => [r.symbol, r])));
      setUnlocked(true);
      setError('');
      useProxy(s);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!secret) return;
    load(secret).then((ok) => {
      setChecking(false);
      if (!ok) {
        store.set(SECRET_KEY, '');
        setSecret('');
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => setChartSym(symbolFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // Live prices: one Binance stream for the whole list; REST polling if it can't connect
  const symKey = symbols.join(',');
  useEffect(() => {
    if (!unlocked || !symbols.length) return;
    let alive = true;
    let poll = null;
    const refresh = () =>
      tickers(symbols)
        .then((t) => alive && setTicks((x) => ({ ...x, ...t })))
        .catch(() => {});
    refresh();
    const stop = stream(
      symbols.map((s) => `${s.toLowerCase()}@miniTicker`),
      (d) => {
        if (!alive || !d?.s) return;
        const price = +d.c;
        const open = +d.o;
        setTicks((x) => ({ ...x, [d.s]: { ...x[d.s], price, open, changePct: open ? ((price - open) / open) * 100 : 0, quoteVolume: +d.q, high: +d.h, low: +d.l } }));
      },
      (st) => {
        if (!alive) return;
        setFeed(st);
        clearInterval(poll);
        poll = st === 'down' ? setInterval(refresh, 10_000) : null;
      }
    );
    return () => {
      alive = false;
      stop();
      clearInterval(poll);
    };
  }, [unlocked, symKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (checking) return <p className="tk-note">Opening Crypto…</p>;
  if (!unlocked) {
    return (
      <SecretGate
        error={error}
        notice=""
        onSubmit={async (s, remember) => {
          setSecret(s);
          if (await load(s)) store.set(SECRET_KEY, remember ? s : '');
        }}
      />
    );
  }

  const changeList = async (action, symbol, market) => {
    const j = await api(secret, action, { method: 'POST', body: { symbol, ...(market === 'futures' ? { market } : {}) } });
    markFutures((j.items || []).filter((r) => r.market === 'futures').map((r) => r.symbol));
    setSymbols(j.symbols);
  };
  const openChart = (s) => {
    window.location.hash = `#/crypto/chart?s=${s}`;
  };
  const current = chartSym || symbols[0] || 'BTCUSDT';

  return (
    <>
      {actionsEl &&
        createPortal(
          <div className="tk-live">
            <span className={`tk-dot ${feed === 'live' ? 'on' : ''}`} />
            <span className="tk-live-text">{feed === 'live' ? 'Live from Binance' : feed === 'down' ? 'Stream unavailable — refreshing every 10 s' : 'Connecting to Binance…'}</span>
            <div className="seg" role="group" aria-label="Candle interval">
              {Object.keys(INTERVALS).map((v) => (
                <button key={v} className={interval === v ? 'on' : ''} onClick={() => setIntervalV(v)}>
                  {v === '1h' ? 'Hourly' : 'Daily'}
                </button>
              ))}
            </div>
          </div>,
          actionsEl
        )}
      {subview === 'watchlist' ? (
        <>
          <Watchlist symbols={symbols} notes={notes} ticks={ticks} interval={interval} cfg={cfg} onAdd={(s, market) => changeList('add', s, market)} onRemove={(s) => changeList('remove', s)} onChart={openChart} onTrade={toggleTrade} tradeSym={tradeSym} positions={cb.book?.positions || []} />
          <ScanPanel secret={secret} onListChanged={() => load(secret)} />
        </>
      ) : (
        <CryptoChart
          key={`${current}-${interval}`}
          symbol={current}
          symbols={symbols}
          interval={interval}
          setInterval={setIntervalV}
          cfg={cfg}
          setCfg={setCfg}
          tick={ticks[current]}
          onSymbol={openChart}
          onTrade={() => toggleTrade(current)}
          position={cb.book?.positions?.find((p) => p.symbol === current) || null}
          fx={cb.book?.fx || 85}
          onSetExit={(kind, price, hint) => cb.post('cp-exit', { symbol: current, kind, price, hint })}
          onPriceHit={(price) => cb.checkNow({ [current]: price }).catch(() => {})}
        />
      )}
      {tradeSym && <CryptoTrade symbol={tradeSym} book={cb.book} post={cb.post} onClose={() => setTradeSym(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ watchlist

function Watchlist({ symbols, notes = {}, ticks, interval, cfg, onAdd, onRemove, onChart, onTrade, tradeSym, positions = [] }) {
  const posOf = Object.fromEntries(positions.map((p) => [p.symbol, p]));
  const [candles, setCandles] = useState({}); // symbol -> candles for the readings
  const [scanAt, setScanAt] = useState(null);
  const [scanErr, setScanErr] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  // Candles for the indicator readings, refreshed every few minutes
  useEffect(() => {
    let alive = true;
    let timer;
    const scan = async () => {
      const out = {};
      let failed = 0;
      const queue = [...symbols];
      const worker = async () => {
        while (queue.length) {
          const s = queue.shift();
          try {
            out[s] = await klines(s, interval, SCAN_CANDLES);
          } catch (e) {
            failed++;
            setScanErr(e.message);
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      if (!alive) return;
      setCandles(out);
      setScanAt(new Date());
      if (!failed) setScanErr('');
      timer = setTimeout(scan, SCAN_EVERY[interval]);
    };
    setCandles({});
    scan();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [symbols.join(','), interval]); // eslint-disable-line react-hooks/exhaustive-deps

  // Readings use the live price as the latest close
  const rows = useMemo(
    () =>
      symbols.map((s) => {
        const t = ticks[s];
        const cs = candles[s];
        let r = null;
        if (cs?.length) {
          const live = t?.price != null ? cs.map((c, i) => (i === cs.length - 1 ? { ...c, close: t.price } : c)) : cs;
          r = readings(live, { rsi: cfg.rsi, emaFast: cfg.emaFast, emaSlow: cfg.emaSlow, bbPeriod: cfg.bbPeriod, bbMult: cfg.bbMult });
        }
        return { s, t, r, price: t?.price ?? cs?.[cs.length - 1]?.close ?? null };
      }),
    [symbols, ticks, candles, cfg]
  );

  const act = async (fn, s, text) => {
    setBusy(s);
    setMsg('');
    try {
      await fn(s);
      if (text) setMsg(text);
    } catch (e) {
      setMsg(`⚠ ${e.message}`);
    } finally {
      setBusy('');
    }
  };
  const per = interval === '1h' ? 'hourly' : 'daily';

  return (
    <section className="card">
      <div className="card-head">
        <h2>Coins</h2>
        <AddCoin existing={symbols} onAdd={(s, market) => act((x) => onAdd(x, market), s, `${coin(s)} added${market === 'futures' ? ' (futures)' : ''}.`)} />
      </div>
      {msg && <p className={`status ${msg.startsWith('⚠') ? 'err' : 'ok'} tk-pos-msg`}>{msg}</p>}
      {scanErr && <p className="status err tk-pos-msg">Indicator data: {scanErr}</p>}
      <div className="table-wrap">
        <table className="ticker crypto-table">
          <thead>
            <tr>
              <th>Coin</th>
              <th className="num">Price (USDT)</th>
              <th className="num">24h</th>
              <th className="num">24h volume</th>
              <th className="num" title={`RSI ${cfg.rsi} on ${per} candles`}>RSI {cfg.rsi}</th>
              <th title={`EMA ${cfg.emaFast} vs EMA ${cfg.emaSlow} on ${per} candles`}>EMA {cfg.emaFast}/{cfg.emaSlow}</th>
              <th title={`Bollinger Bands ${cfg.bbPeriod}, ${cfg.bbMult} on ${per} candles`}>Bollinger</th>
              <th>Paper</th>
              <th aria-label="Chart" />
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, t, r, price }) => (
              <tr key={s} className="clickable" onClick={() => onChart(s)}>
                <td className="tk-inst">
                  <div className="tk-name">{coin(s)}</div>
                  <div className="tk-sub">
                    <span>{s}</span>
                    {isFutures(s) && <PerpTag />}
                    {notes[s]?.addedBy === 'scan' && <span className="ind-tag new" title={`Added by the daily mover scan: ${notes[s].note || ''}`}>Auto {(notes[s].note || '').split(' ')[0]}</span>}
                  </div>
                </td>
                <td className="num mono"><b>{fmtPrice(price)}</b></td>
                <td className={`num mono ${tone(t?.changePct)}`}>{t?.changePct != null ? `${t.changePct > 0 ? '+' : ''}${t.changePct.toFixed(2)}%` : '…'}</td>
                <td className="num mono muted-cell">{t?.quoteVolume != null ? fmtCompact(t.quoteVolume) : '…'}</td>
                <td className="num">
                  {r?.rsi != null ? (
                    <>
                      <span className={`mono ${r.rsi >= 70 ? 'neg' : r.rsi <= 30 ? 'pos' : ''}`}>{r.rsi.toFixed(1)}</span>
                      {r.rsi >= 70 && <span className="ind-tag hot">Overbought</span>}
                      {r.rsi <= 30 && <span className="ind-tag cold">Oversold</span>}
                    </>
                  ) : (
                    <span className="muted-dash">…</span>
                  )}
                </td>
                <td>
                  {r?.trend ? (
                    <>
                      <span className={`ind-trend ${r.trend}`}>{r.trend === 'bull' ? 'Bullish ▲' : 'Bearish ▼'}</span>
                      {r.lastCross && r.lastCross.barsAgo <= 5 && (
                        <span className="ind-tag new" title="Recent EMA crossover">
                          crossed {r.lastCross.barsAgo === 0 ? 'now' : `${r.lastCross.barsAgo} ${interval === '1h' ? 'h' : 'd'} ago`}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="muted-dash">…</span>
                  )}
                </td>
                <td>{r?.bb?.upper != null ? <BbCell price={price} bb={r.bb} /> : <span className="muted-dash">…</span>}</td>
                <td className="cp-trade-cell">
                  <button
                    className={`btn tk-row-trade ${tradeSym === s ? 'on' : ''}`}
                    onClick={(e) => (e.stopPropagation(), onTrade(s))}
                    aria-pressed={tradeSym === s}
                    title={`Paper trade ${coin(s)}`}
                  >
                    Trade
                  </button>
                  {posOf[s] && (
                    <div className={`cp-side ${posOf[s].side.toLowerCase()}`} title={`${posOf[s].side === 'LONG' ? 'Long' : 'Short'} ${posOf[s].leverage}× open`}>
                      {posOf[s].side === 'LONG' ? 'Long' : 'Short'} {posOf[s].leverage}×
                    </div>
                  )}
                </td>
                <td className="tk-x">
                  <button className="icon-btn tk-chart-btn" onClick={(e) => (e.stopPropagation(), onChart(s))} title={`${coin(s)} chart`} aria-label={`${coin(s)} chart`}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 3v3M6 15v6M12 2v5M12 14v3M18 5v4M18 16v5" /><rect x="4" y="6" width="4" height="9" rx="1" /><rect x="10" y="7" width="4" height="7" rx="1" /><rect x="16" y="9" width="4" height="7" rx="1" /></svg>
                  </button>
                </td>
                <td className="tk-x">
                  <button className="icon-btn" onClick={(e) => (e.stopPropagation(), act(onRemove, s, `${coin(s)} removed.`))} disabled={busy === s} aria-label={`Remove ${coin(s)}`}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!symbols.length && <div className="empty">No coins yet. Search above to add one, e.g. BTC.</div>}
      </div>
      <div className="foot">
        Binance spot, USDT pairs · indicators on {per} candles using the live price for the current candle
        {scanAt && <> · candles refreshed {scanAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</>} · change periods and settings on the Chart tab
      </div>
    </section>
  );
}

function BbCell({ price, bb }) {
  if (price > bb.upper) return <span className="ind-tag hot">Above upper</span>;
  if (price < bb.lower) return <span className="ind-tag cold">Below lower</span>;
  const pct = Math.round(bb.pctB * 100);
  return (
    <span className="bb-meter" title={`%B ${pct}% — 0% = lower band, 100% = upper band`}>
      <span className="bb-track"><i style={{ left: `${Math.min(100, Math.max(0, pct))}%` }} /></span>
      <span className="mono muted-cell">{pct}%</span>
    </span>
  );
}

function AddCoin({ existing, onAdd }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || list) return;
    usdtMarkets().then(setList).catch((e) => setErr(e.message));
  }, [open, list]);
  const term = q.trim().toUpperCase().replace(/USDT$/, '');
  const matches = (list || []).filter((m) => !term || m.base.startsWith(term) || m.symbol.startsWith(term)).slice(0, 12);
  const pick = (m) => {
    setQ('');
    setOpen(false);
    if (!existing.includes(m.symbol)) onAdd(m.symbol, m.market);
  };
  return (
    <div className="tk-add crypto-add">
      <input
        className="search"
        placeholder="Add coin: BTC, ETH, SOL…"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => (setQ(e.target.value), setOpen(true))}
        onKeyDown={(e) => e.key === 'Enter' && matches[0] && pick(matches[0])}
        aria-label="Add coin"
      />
      {open && (
        <div className="tk-results">
          {err && <div className="tk-result-note">{err}</div>}
          {!list && !err && <div className="tk-result-note">Loading Binance markets…</div>}
          {list && !matches.length && <div className="tk-result-note">No USDT pair or perpetual matches “{q}”.</div>}
          {matches.map((m) => (
            <button key={m.symbol} className="tk-result" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)} disabled={existing.includes(m.symbol)}>
              <span className="mono"><b>{m.base}</b>/USDT {m.market === 'futures' && <PerpTag />}</span>
              <span className="mono muted-cell">{fmtPrice(m.price)}</span>
              <span className="muted-cell">vol {fmtCompact(m.quoteVolume)}</span>
              {existing.includes(m.symbol) && <span className="muted-cell">added</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ chart

const palette = (dark) =>
  dark
    ? { up: '#16a34a', down: '#ea580c', text: '#93a29a', grid: '#26312c', bg: '#151c19', cross: '#5b6b63', fast: '#3b82f6', slow: '#c026d3', bb: '#22d3ee', rsi: '#fbbf24', lvl: '#5b6b63' }
    : { up: '#15803d', down: '#c2410c', text: '#5f6b65', grid: '#e9ece7', bg: '#ffffff', cross: '#9aa39e', fast: '#1d4ed8', slow: '#a21caf', bb: '#0e7490', rsi: '#b45309', lvl: '#9aa39e' };
const prefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
const shift = (t) => t + IST_OFFSET; // chart axis in Indian time

const EXIT_COLORS = { SL: '#dc2626', TP: '#16a34a', ENTRY: '#94a3b8' };
const EXIT_NAME = { SL: 'Stop loss', TP: 'Take profit' };
const GRAB_PX = 8; // how close the pointer must be to a line to grab it
const roundP = (v) => Number(Number(v).toPrecision(6));

function CryptoChart({ symbol, symbols, interval, setInterval, cfg, setCfg, tick, onSymbol, onTrade, position = null, fx = 85, onSetExit, onPriceHit }) {
  const box = useRef(null);
  const [expanded, setExpanded] = useState(false); // chart panel fills the whole window
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && setExpanded(false);
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [expanded]);

  // ---- stop loss / take profit (paper position), drawn and dragged on the chart
  const [levels, setLevels] = useState({ SL: position?.sl ?? null, TP: position?.tp ?? null });
  const [exitMsg, setExitMsg] = useState(null);
  const [savingExit, setSavingExit] = useState('');
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const posRef = useRef(position);
  posRef.current = position;
  const dragRef = useRef(null);
  const linesRef = useRef({});
  useEffect(() => {
    if (dragRef.current || savingExit) return;
    setLevels({ SL: position?.sl ?? null, TP: position?.tp ?? null });
  }, [position?.sl, position?.tp, position?.side]); // eslint-disable-line react-hooks/exhaustive-deps
  const chartRef = useRef(null);
  const sRef = useRef({});
  const candlesRef = useRef([]);
  const indRef = useRef(null);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [hover, setHover] = useState(null);
  const [live, setLive] = useState('connecting');
  const [, force] = useState(0);
  const [dark, setDark] = useState(prefersDark);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Build the chart (again when the RSI panel is switched or the theme changes)
  useEffect(() => {
    const p = palette(dark);
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: p.bg }, textColor: p.text, fontFamily: 'system-ui, sans-serif', attributionLogo: true, panes: { separatorColor: p.grid } },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: interval === '1h', secondsVisible: false, rightOffset: 4 },
      crosshair: { vertLine: { color: p.cross, labelBackgroundColor: p.cross }, horzLine: { color: p.cross, labelBackgroundColor: p.cross } },
      localization: { locale: 'en-IN' },
    });
    // Prices span 0.00001 to 100,000 USDT, so each price series formats its own values
    const pf = { priceFormat: { type: 'custom', formatter: (v) => fmtPrice(v), minMove: 0.00000001 } };
    const candles = chart.addSeries(CandlestickSeries, {
      ...pf,
      upColor: p.up,
      downColor: p.down,
      wickUpColor: p.up,
      wickDownColor: p.down,
      borderVisible: false,
      // keep entry / stop loss / take profit in view (mid-drag, use where the drag started)
      autoscaleInfoProvider: (original) => {
        const res = original();
        const pos = posRef.current;
        if (!res || !pos) return res;
        const lv = { ...levelsRef.current };
        if (dragRef.current) lv[dragRef.current.k] = dragRef.current.start;
        let { minValue, maxValue } = res.priceRange;
        for (const v of [pos.avg, lv.SL, lv.TP]) {
          if (v == null) continue;
          minValue = Math.min(minValue, v);
          maxValue = Math.max(maxValue, v);
        }
        return { ...res, priceRange: { minValue, maxValue } };
      },
    });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    const line = { ...pf, lineWidth: 2, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false };
    const fast = chart.addSeries(LineSeries, { ...line, color: p.fast });
    const slow = chart.addSeries(LineSeries, { ...line, color: p.slow, lineStyle: LineStyle.Dashed });
    const bbU = chart.addSeries(LineSeries, { ...line, lineWidth: 1, color: p.bb });
    const bbM = chart.addSeries(LineSeries, { ...line, lineWidth: 1, color: p.bb, lineStyle: LineStyle.Dotted });
    const bbL = chart.addSeries(LineSeries, { ...line, lineWidth: 1, color: p.bb });
    const markers = createSeriesMarkers(candles, []);
    let rsiS = null;
    if (cfgRef.current.rsiOn) {
      rsiS = chart.addSeries(LineSeries, { ...line, color: p.rsi, lastValueVisible: true, priceFormat: { type: 'custom', formatter: (v) => v.toFixed(1), minMove: 0.1 } }, 1);
      for (const [v, st] of [[70, LineStyle.Dashed], [50, LineStyle.Dotted], [30, LineStyle.Dashed]]) {
        rsiS.createPriceLine({ price: v, color: p.lvl, lineWidth: 1, lineStyle: st, axisLabelVisible: v !== 50, title: '' });
      }
      rsiS.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
      rsiS.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      chart.panes()[1]?.setHeight(130);
    }
    chart.subscribeCrosshairMove((param) => {
      if (param.time == null) return setHover(null);
      const c = param.seriesData.get(candles);
      setHover(c ? { time: param.time, ...c, v: param.seriesData.get(volume)?.value } : null);
    });
    chartRef.current = chart;
    sRef.current = { candles, volume, fast, slow, bbU, bbM, bbL, markers, rsiS, p };
    if (candlesRef.current.length) draw(true);
    drawExitLines();
    return () => {
      chart.remove();
      chartRef.current = null;
      linesRef.current = {}; // the lines belonged to the removed chart
    };
  }, [cfg.rsiOn, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  // Indicators → series. full=true redraws everything; otherwise only the last point.
  function draw(full) {
    const s = sRef.current;
    const cs = candlesRef.current;
    if (!s.candles || !cs.length) return;
    const c = cfgRef.current;
    const ind = {
      fast: c.emaOn ? ema(cs, c.emaFast) : [],
      slow: c.emaOn ? ema(cs, c.emaSlow) : [],
      bb: c.bbOn ? bollinger(cs, c.bbPeriod, c.bbMult) : { upper: [], middle: [], lower: [] },
      rsi: c.rsiOn ? rsi(cs, c.rsi) : [],
    };
    const prevLen = indRef.current?.len;
    indRef.current = { ...ind, len: cs.length };
    const n = cs.length - 1;
    const pt = (arr, i) => (arr[i] == null ? null : { time: shift(cs[i].time), value: arr[i] });
    const lineData = (arr) => arr.map((v, i) => (v == null ? null : { time: shift(cs[i].time), value: v })).filter(Boolean);
    const vol = (k) => ({ time: shift(k.time), value: k.quoteVolume ?? k.volume, color: `${k.close >= k.open ? s.p.up : s.p.down}55` });
    const pairs = [[s.fast, ind.fast], [s.slow, ind.slow], [s.bbU, ind.bb.upper], [s.bbM, ind.bb.middle], [s.bbL, ind.bb.lower], ...(s.rsiS ? [[s.rsiS, ind.rsi]] : [])];
    if (full || prevLen !== cs.length) {
      s.candles.setData(cs.map((k) => ({ time: shift(k.time), open: k.open, high: k.high, low: k.low, close: k.close })));
      s.volume.setData(cs.map(vol));
      for (const [series, arr] of pairs) series.setData(lineData(arr));
      const xs = c.emaOn ? crossovers(cs, ind.fast, ind.slow, cs.length - 1) : []; // completed candles only
      s.markers.setMarkers(
        xs.map((x) =>
          x.type === 'bull'
            ? { time: shift(x.time), position: 'belowBar', shape: 'arrowUp', color: s.p.up, text: 'Bull' }
            : { time: shift(x.time), position: 'aboveBar', shape: 'arrowDown', color: s.p.down, text: 'Bear' }
        )
      );
    } else {
      const k = cs[n];
      s.candles.update({ time: shift(k.time), open: k.open, high: k.high, low: k.low, close: k.close });
      s.volume.update(vol(k));
      for (const [series, arr] of pairs) {
        const v = pt(arr, n);
        if (v) series.update(v);
      }
    }
    force((x) => x + 1);
  }

  // History, then live candles
  useEffect(() => {
    let alive = true;
    let stop = () => {};
    let poll = null;
    setLoaded(false);
    setError('');
    candlesRef.current = [];
    klines(symbol, interval, HISTORY[interval])
      .then((cs) => {
        if (!alive) return;
        candlesRef.current = cs;
        setLoaded(true);
        draw(true);
        const n = cs.length;
        if (n) chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (interval === '1h' ? 150 : 180)), to: n + 4 });
        const pollLatest = async () => {
          try {
            const last = await klines(symbol, interval, 2);
            for (const k of last) {
              const at = candlesRef.current.findIndex((c) => c.time === k.time);
              if (at >= 0) candlesRef.current[at] = k;
              else if (k.time > candlesRef.current[candlesRef.current.length - 1].time) candlesRef.current.push(k);
            }
            draw(false);
          } catch {}
        };
        stop = stream(
          [`${symbol.toLowerCase()}@kline_${interval}`],
          (d) => {
            if (!alive || !d?.k || d.s !== symbol) return;
            const before = candlesRef.current.length;
            applyKline(candlesRef.current, d.k);
            draw(candlesRef.current.length !== before);
          },
          (st) => {
            if (!alive) return;
            setLive(st);
            clearInterval(poll);
            poll = st === 'down' ? setInterval(pollLatest, 10_000) : null;
          }
        );
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
      stop();
      clearInterval(poll);
    };
  }, [symbol, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- SL / TP lines
  const inr = (usdt, signed = true) => {
    if (usdt == null || !Number.isFinite(usdt)) return '';
    const v = usdt * fx;
    const a = Math.abs(v);
    return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}₹${a.toLocaleString('en-IN', { maximumFractionDigits: a < 100 ? 2 : 0 })}`;
  };
  const pnlAt = (v) => (position && v != null ? (v - position.avg) * position.qty : null);
  function drawExitLines() {
    const s = sRef.current.candles;
    if (!s) return;
    const pos = posRef.current;
    const lv = levelsRef.current;
    const want = { ENTRY: pos ? pos.avg : null, SL: pos ? lv.SL : null, TP: pos ? lv.TP : null };
    for (const k of ['ENTRY', 'SL', 'TP']) {
      const v = want[k];
      const line = linesRef.current[k];
      if (v == null) {
        if (line) s.removePriceLine(line);
        delete linesRef.current[k];
        continue;
      }
      const x = pos && k !== 'ENTRY' ? (v - pos.avg) * pos.qty : null;
      const opts = {
        price: v,
        color: EXIT_COLORS[k],
        lineWidth: k === 'ENTRY' ? 1 : 2,
        lineStyle: k === 'ENTRY' ? LineStyle.Dotted : LineStyle.Dashed,
        axisLabelVisible: true,
        title: k === 'ENTRY' ? 'Entry' : `${k} ${x == null ? '' : inr(x)}`,
      };
      if (line) line.applyOptions(opts);
      else linesRef.current[k] = s.createPriceLine(opts);
    }
  }
  useEffect(drawExitLines, [levels, position?.avg, position?.qty, fx]); // eslint-disable-line react-hooks/exhaustive-deps

  const ltpNow = tick?.price ?? candlesRef.current[candlesRef.current.length - 1]?.close ?? null;
  const saveExit = async (k, v, revertTo) => {
    setSavingExit(k);
    setExitMsg(null);
    try {
      await onSetExit(k, v, ltpNow);
      const pos = posRef.current;
      setExitMsg({
        kind: 'ok',
        text:
          v == null
            ? `${EXIT_NAME[k]} removed.`
            : `${EXIT_NAME[k]} at ${fmtPrice(v)}: closes the whole ${pos?.side?.toLowerCase() || 'position'} if the price ${(k === 'SL') === (pos?.qty > 0) ? 'falls' : 'rises'} to it (${inr(pnlAt(v))}).`,
      });
    } catch (e) {
      setLevels((l) => ({ ...l, [k]: revertTo }));
      setExitMsg({ kind: 'err', text: e.message });
    } finally {
      setSavingExit('');
    }
  };
  const saveExitRef = useRef(saveExit);
  saveExitRef.current = saveExit;
  // A first level 2 % (stop loss) / 4 % (take profit) from the price, kept inside the liquidation price
  const addExit = (k) => {
    const ltp = ltpNow ?? position.avg;
    const long = position.qty > 0;
    let v = ltp * (1 + (k === 'SL' ? (long ? -0.02 : 0.02) : long ? 0.04 : -0.04));
    if (k === 'SL' && (long ? v <= position.liqPrice : v >= position.liqPrice)) v = (ltp + position.liqPrice) / 2;
    v = roundP(v);
    setLevels((l) => ({ ...l, [k]: v }));
    saveExit(k, v, null);
  };

  // Drag the SL / TP lines
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const s = () => sRef.current.candles;
    const yOf = (e) => e.clientY - el.getBoundingClientRect().top;
    const near = (y) => {
      if (!posRef.current || !s()) return null;
      let best = null;
      for (const k of ['SL', 'TP']) {
        const v = levelsRef.current[k];
        if (v == null) continue;
        const ly = s().priceToCoordinate(v);
        const d = ly == null ? Infinity : Math.abs(ly - y);
        if (d <= GRAB_PX && (!best || d < best.d)) best = { k, d };
      }
      return best?.k || null;
    };
    const down = (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const k = near(yOf(e));
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { k, start: levelsRef.current[k] };
      chartRef.current?.applyOptions({ handleScroll: false, handleScale: false });
      el.classList.add('dragging');
      try {
        el.setPointerCapture(e.pointerId);
      } catch {}
    };
    const move = (e) => {
      const y = yOf(e);
      const d = dragRef.current;
      if (!d) {
        el.style.cursor = near(y) ? 'ns-resize' : '';
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const p = s().coordinateToPrice(y);
      if (p == null || p <= 0) return;
      const v = roundP(p);
      if (v === levelsRef.current[d.k]) return;
      levelsRef.current = { ...levelsRef.current, [d.k]: v };
      drawExitLines();
      setLevels(levelsRef.current);
    };
    const up = (e) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      chartRef.current?.applyOptions({ handleScroll: true, handleScale: true });
      el.classList.remove('dragging');
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {}
      const v = levelsRef.current[d.k];
      if (v !== d.start) saveExitRef.current(d.k, v, d.start);
    };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The live price reached SL / TP / liquidation → ask the server to settle it (it checks with its own price)
  const hitAsked = useRef(0);
  useEffect(() => {
    if (!position || !(ltpNow > 0) || dragRef.current) return;
    if (triggerHit(position, ltpNow) && Date.now() - hitAsked.current > 10_000) {
      hitAsked.current = Date.now();
      onPriceHit?.(ltpNow);
    }
  }, [ltpNow, position]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings changed → redraw
  useEffect(() => {
    if (candlesRef.current.length) draw(true);
  }, [cfg.emaOn, cfg.emaFast, cfg.emaSlow, cfg.bbOn, cfg.bbPeriod, cfg.bbMult, cfg.rsi]); // eslint-disable-line react-hooks/exhaustive-deps

  // Legend: hovered candle, or the latest
  const cs = candlesRef.current;
  const ind = indRef.current;
  const idx = hover ? cs.findIndex((c) => shift(c.time) === hover.time) : cs.length - 1;
  const k = idx >= 0 ? cs[idx] : null;
  const at = (arr) => (ind && idx >= 0 && arr?.[idx] != null ? arr[idx] : null);
  const chg = k ? k.close - k.open : 0;
  const when = k ? new Date((k.time + IST_OFFSET) * 1000).toISOString() : '';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const legendTime = k ? `${Number(when.slice(8, 10))} ${MONTHS[Number(when.slice(5, 7)) - 1]} ${when.slice(0, 4)}${interval === '1h' ? ` ${when.slice(11, 16)}` : ''}` : '';
  const rsiNow = at(ind?.rsi);
  const list = symbols.includes(symbol) ? symbols : [symbol, ...symbols];

  return (
    <section className={`card tk-chart crypto-chart ${expanded ? 'expanded' : ''}`}>
      <div className="card-head">
        <div className="tk-chart-title">
          <select className="select crypto-sym" value={symbol} onChange={(e) => onSymbol(e.target.value)} aria-label="Coin">
            {list.map((s) => <option key={s} value={s}>{coin(s)}/USDT{isFutures(s) ? ' · Perp' : ''}</option>)}
          </select>
          {isFutures(symbol) && <PerpTag />}
          <b className="mono tk-chart-ltp">{fmtPrice(tick?.price ?? cs[cs.length - 1]?.close)}</b>
          {tick?.changePct != null && <span className={`mono ${tone(tick.changePct)}`}>{tick.changePct > 0 ? '+' : ''}{tick.changePct.toFixed(2)}% 24h</span>}
        </div>
        <div className="form-actions">
          {position && (
            <span className="tk-holding mono">
              <span className={`cp-side ${position.side.toLowerCase()}`}>{position.side === 'LONG' ? 'Long' : 'Short'} {position.leverage}×</span>{' '}
              {Math.abs(position.qty).toLocaleString('en-US', { maximumSignificantDigits: 8 })} @ {fmtPrice(position.avg)}
            </span>
          )}
          {position &&
            (() => {
              const pnl = ltpNow != null ? (ltpNow - position.avg) * position.qty : null;
              const roe = pnl != null ? (pnl / position.margin) * 100 : null;
              const cls = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
              return (
                <span className={`tk-chart-pnl ${cls}`} title={`Running P&L before fees · ROE on ${inr(position.margin, false)} margin`}>
                  <span className="lbl">P&amp;L</span>
                  <b className="mono">{pnl != null ? inr(pnl) : '…'}</b>
                  {roe != null && <span className="mono pct">{roe > 0 ? '+' : ''}{roe.toFixed(2)}%</span>}
                </span>
              );
            })()}
          <button className="btn tk-trade-btn" onClick={onTrade} title={`Paper trade ${coin(symbol)}`}>Trade</button>
          <span className={`crypto-live ${live}`}>{live === 'live' ? '● Live' : live === 'down' ? 'Refreshing every 10 s' : 'Connecting…'}</span>
          <div className="seg" role="group" aria-label="Candle interval">
            {['1h', '1d'].map((v) => (
              <button key={v} className={interval === v ? 'on' : ''} onClick={() => setInterval(v)}>{v === '1h' ? '1 hour' : '1 day'}</button>
            ))}
          </div>
          <button
            className="btn tk-expand-btn"
            onClick={() => setExpanded((v) => !v)}
            aria-pressed={expanded}
            aria-label={expanded ? 'Exit full screen' : 'Expand chart to full screen'}
            title={expanded ? 'Exit full screen (Esc)' : 'Expand chart to full screen'}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {expanded ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
            </svg>
          </button>
        </div>
      </div>

      {position && onSetExit && (
        <div className="tk-exit-bar">
          {['SL', 'TP'].map((k) => (
            <CExitChip
              key={k}
              k={k}
              value={levels[k]}
              pnl={inr(pnlAt(levels[k]))}
              busy={savingExit === k}
              onAdd={() => addExit(k)}
              onSet={(v) => {
                const before = levels[k];
                setLevels((l) => ({ ...l, [k]: v }));
                saveExit(k, v, before);
              }}
              onRemove={() => {
                const before = levels[k];
                setLevels((l) => ({ ...l, [k]: null }));
                saveExit(k, null, before);
              }}
            />
          ))}
          <span className="tk-exit-hint">
            {levels.SL != null || levels.TP != null ? 'Drag the dashed lines on the chart to move them.' : 'Add a level, then drag its line on the chart.'} Liq. {fmtPrice(position.liqPrice)}
          </span>
          {exitMsg && <span className={`status ${exitMsg.kind}`}>{exitMsg.text}</span>}
        </div>
      )}

      <div className="tk-ema-bar ind-bar">
        <IndGroup on={cfg.emaOn} onToggle={(v) => setCfg({ emaOn: v })} label="EMA" swatches={['fast', 'slow']}>
          <NumIn label="Fast" value={cfg.emaFast} min={2} max={199} onChange={(v) => v < cfg.emaSlow && setCfg({ emaFast: v })} />
          <NumIn label="Slow" value={cfg.emaSlow} min={3} max={400} onChange={(v) => v > cfg.emaFast && setCfg({ emaSlow: v })} />
        </IndGroup>
        <IndGroup on={cfg.bbOn} onToggle={(v) => setCfg({ bbOn: v })} label="Bollinger" swatches={['bb']}>
          <NumIn label="Length" value={cfg.bbPeriod} min={2} max={200} onChange={(v) => setCfg({ bbPeriod: v })} />
          <NumIn label="StdDev" value={cfg.bbMult} min={0.5} max={5} step={0.5} onChange={(v) => setCfg({ bbMult: v })} />
        </IndGroup>
        <IndGroup on={cfg.rsiOn} onToggle={(v) => setCfg({ rsiOn: v })} label="RSI" swatches={['rsi']}>
          <NumIn label="Length" value={cfg.rsi} min={2} max={100} onChange={(v) => setCfg({ rsi: v })} />
        </IndGroup>
      </div>

      <div className="tk-chart-legend mono" aria-live="off">
        {k ? (
          <>
            <span className="muted-cell">{legendTime}</span>
            <span>O <b>{fmtPrice(k.open)}</b></span>
            <span>H <b>{fmtPrice(k.high)}</b></span>
            <span>L <b>{fmtPrice(k.low)}</b></span>
            <span>C <b className={tone(chg)}>{fmtPrice(k.close)}</b></span>
            <span className={tone(chg)}>{k.open ? `${chg >= 0 ? '+' : ''}${((chg / k.open) * 100).toFixed(2)}%` : ''}</span>
            <span>Vol <b>{fmtCompact(k.quoteVolume ?? k.volume)}</b></span>
            {cfg.emaOn && (
              <>
                <span><i className="ema-swatch fast" />EMA {cfg.emaFast} <b>{fmtPrice(at(ind?.fast))}</b></span>
                <span><i className="ema-swatch slow" />EMA {cfg.emaSlow} <b>{fmtPrice(at(ind?.slow))}</b></span>
              </>
            )}
            {cfg.bbOn && (
              <span><i className="ema-swatch bb" />BB <b>{fmtPrice(at(ind?.bb?.upper))}</b> / <b>{fmtPrice(at(ind?.bb?.middle))}</b> / <b>{fmtPrice(at(ind?.bb?.lower))}</b></span>
            )}
            {cfg.rsiOn && (
              <span>
                <i className="ema-swatch rsi" />RSI {cfg.rsi} <b className={rsiNow >= 70 ? 'neg' : rsiNow <= 30 ? 'pos' : ''}>{rsiNow != null ? rsiNow.toFixed(1) : '—'}</b>
              </span>
            )}
          </>
        ) : (
          <span className="muted-cell">{error ? '' : `Loading ${interval === '1h' ? '4 months of hourly' : 'daily'} candles…`}</span>
        )}
      </div>
      <div className={`tk-chart-box crypto-box ${cfg.rsiOn ? 'with-rsi' : ''}`} ref={box} />
      {error && <p className="status err tk-chart-err">{error}</p>}
      <div className="foot">
        {loaded ? `${cs.length.toLocaleString('en-IN')} ${interval === '1h' ? 'hourly' : 'daily'} candles` : 'Loading'} from Binance spot · Indian time ·
        EMA crosses marked on completed candles · RSI panel lines at 70 / 50 / 30
        <span className="tk-chart-credit">
          Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a> Lightweight Charts™ · Copyright © TradingView, Inc.
        </span>
      </div>
    </section>
  );
}

/** "+ Stop loss" button, or the level with an editable price and a remove button. */
function CExitChip({ k, value, pnl, busy, onAdd, onSet, onRemove }) {
  const [draft, setDraft] = useState(null);
  if (value == null) {
    return (
      <button className={`btn exit-add ${k}`} onClick={onAdd} disabled={busy}>
        + {EXIT_NAME[k]}
      </button>
    );
  }
  const commit = () => {
    if (draft == null) return;
    const v = roundP(Number(draft));
    setDraft(null);
    if (v > 0 && v !== value) onSet(v);
  };
  return (
    <span className={`exit-chip ${k}`}>
      <b>{k}</b>
      <input
        type="number"
        step="any"
        min="0"
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(null);
        }}
        aria-label={`${EXIT_NAME[k]} price`}
        disabled={busy}
      />
      <span className={`mono exit-pnl ${pnl.startsWith('+') ? 'pos' : 'neg'}`}>{busy ? 'saving…' : pnl}</span>
      <button className="exit-x" onClick={onRemove} disabled={busy} aria-label={`Remove ${EXIT_NAME[k]}`} title={`Remove ${EXIT_NAME[k]}`}>×</button>
    </span>
  );
}

function IndGroup({ on, onToggle, label, swatches, children }) {
  return (
    <span className={`ind-group ${on ? '' : 'off'}`}>
      <label className="switch">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <span>
          {swatches.map((s) => <i key={s} className={`ema-swatch ${s}`} />)}
          {label}
        </span>
      </label>
      {on && children}
    </span>
  );
}

function NumIn({ label, value, min, max, step = 1, onChange }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="tk-ema-in">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
        aria-label={label}
      />
    </label>
  );
}

// ------------------------------------------------------------------ daily mover scan

const SCAN_PCT_KEY = 'stockhits.cryptoScanPct';
const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

function ScanPanel({ secret, onListChanged }) {
  const [pct, setPct] = useState(() => Number(store.get(SCAN_PCT_KEY)) || 40);
  const [hits, setHits] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { kind, text }
  const [showSetup, setShowSetup] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadHits = useCallback(() => api(secret, 'scan-hits').then((j) => setHits(j.hits)).catch(() => setHits([])), [secret]);
  useEffect(() => {
    loadHits();
  }, [loadHits]);

  const scan = async () => {
    setBusy(true);
    setResult(null);
    try {
      const j = await api(secret, 'scan', { method: 'POST', body: { minPct: pct } });
      const list = j.matches.map((m) => `${coin(m.symbol)} +${m.pct}%${j.added.includes(m.symbol) ? ' (added)' : j.full.includes(m.symbol) ? ' (list full)' : ''}`);
      setResult({
        kind: 'ok',
        text: `Checked ${j.checked.toLocaleString('en-IN')} USDT pairs for today's daily candle (${dayFmt.format(new Date(`${j.day}T00:00:00Z`))}). ${
          j.matches.length ? `${j.matches.length} up ${pct}% or more: ${list.join(', ')}.` : `None are up ${pct}% or more yet.`
        }`,
      });
      if (j.added.length) onListChanged();
      loadHits();
    } catch (e) {
      setResult({ kind: 'err', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const url = `${window.location.origin}/api/crypto?action=scan&minPct=${pct}&secret=YOUR_SECRET`;
  return (
    <section className="card scan-card">
      <div className="card-head">
        <div>
          <h2>Daily mover scan</h2>
          <p className="muted scan-sub">
            Adds every Binance USDT coin whose <b>daily candle is up {pct}% or more</b> (close ≥ {(1 + pct / 100).toFixed(2)} × open) to your watchlist.
            The day starts 5:30 AM IST (00:00 UTC), like the daily chart.
          </p>
        </div>
        <div className="form-actions">
          <label className="tk-ema-in">
            Up at least
            <input type="number" min="1" max="10000" step="1" value={pct} onChange={(e) => { const v = Number(e.target.value); if (v > 0) { setPct(v); store.set(SCAN_PCT_KEY, String(v)); } }} aria-label="Minimum daily gain %" />
            %
          </label>
          <button className="btn primary" onClick={scan} disabled={busy}>{busy ? 'Scanning…' : 'Scan now'}</button>
        </div>
      </div>
      {result && <p className={`status ${result.kind} tk-pos-msg`}>{result.text}</p>}

      <div className="scan-cols">
        <div>
          <h4>Found by the scan</h4>
          {hits === null ? (
            <p className="muted">Loading…</p>
          ) : hits.length ? (
            <table className="scan-hits">
              <thead>
                <tr><th>Day</th><th>Coin</th><th className="num">Daily gain</th><th className="num">Price then</th><th>Found</th><th /></tr>
              </thead>
              <tbody>
                {hits.slice(0, 15).map((h) => (
                  <tr key={`${h.day}|${h.symbol}`}>
                    <td>{dayFmt.format(new Date(`${h.day}T00:00:00Z`))}</td>
                    <td><a className="link mono" href={`#/crypto/chart?s=${h.symbol}`}>{coin(h.symbol)}</a></td>
                    <td className="num mono pos">+{h.pct}%</td>
                    <td className="num mono">{fmtPrice(h.price)}</td>
                    <td className="muted-cell">{timeFmt.format(new Date(h.at))}</td>
                    <td>{h.added ? <span className="ind-tag new">Added</span> : h.full ? <span className="ind-tag hot">List full</span> : <span className="muted-cell">Already listed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">Nothing found yet. Coins appear here (and in your watchlist) the first time they qualify each day.</p>
          )}
        </div>
        <div className="scan-setup">
          <h4>Run it automatically, 24/7</h4>
          <p className="muted">
            The scan runs whenever its address is opened. A free scheduler can open it every 15 minutes, day and night — your browser doesn't need to be open.
          </p>
          {showSetup ? (
            <ol className="scan-steps">
              <li>Sign up free at <a className="link" href="https://cron-job.org" target="_blank" rel="noopener noreferrer">cron-job.org</a> → <b>Create cronjob</b>.</li>
              <li>
                URL (replace YOUR_SECRET with your CRON_SECRET, or your webhook secret if you haven't set one):
                <code className="scan-url">{url}</code>
                <button className="btn" onClick={() => navigator.clipboard?.writeText(url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>{copied ? 'Copied ✓' : 'Copy URL'}</button>
              </li>
              <li>Schedule: <b>every 15 minutes</b>, every day. Save.</li>
              <li>Each run checks all coins in a few seconds; coins found are added here once per day.</li>
            </ol>
          ) : (
            <button className="btn" onClick={() => setShowSetup(true)}>Show setup steps</button>
          )}
        </div>
      </div>
    </section>
  );
}
