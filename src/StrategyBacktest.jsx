import { useEffect, useMemo, useRef, useState } from 'react';
import { SECRET_KEY, api, store } from './Ticker.jsx';
import { historyCall } from './historyApi.js';

// Auto Trading → Back Test, shared by every strategy. Upload a Chartink backtest export
// (Date, Symbol, …); for each stock the server fetches 1-minute candles from Dhan once and
// runs the strategy's rules day by day (POST /api/ticker action=backtest). The strategy's
// config (EmaBacktest.jsx, BbBacktest.jsx) says how to read a row and which exits to score.
//
// config = {
//   id, intro, leverage,
//   exits: [[key, label, hint]],
//   params: [{ key, label, type: 'number'|'select', options?: [[value, label]], step?, def }],
//   statusOf(row) → [cssClass, label]          (cssClass 'trade' marks a taken trade)
//   trade(row) → null | { entryAt, fill, exits: { key: { r, pct, how, at, px } }, bestR }
//   columns: [{ head, num?, cell(row) }]        strategy-specific columns
//   csv: { head: [...], row(row) → [...] }      strategy-specific CSV columns
// }

const GAP_MS = 1500;
const RETRY_MS = [5000, 10000, 20000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtR = (r) => (r == null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`);
const fmtP = (p) => (p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(2)}%`);
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const CAPS = [[0, 'All'], [1, '1'], [2, '2'], [3, '3'], [5, '5']];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (f += '"'), i++;
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(f), (f = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(f);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      f = '';
    } else f += ch;
  }
  row.push(f);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** "29-10-2026 9:15 am" | "2026-10-29 09:15" | "29/10/2026" → { day, time } */
function parseWhen(s) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(.*)$/.exec(t);
  let day;
  let rest;
  if (m) (day = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`), (rest = m[4]);
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(t))) (day = `${m[1]}-${m[2]}-${m[3]}`), (rest = m[4]);
  else return null;
  const tm = /(\d{1,2}):(\d{2})\s*([ap])?\.?\s*m?/i.exec(rest || '');
  let time = null;
  if (tm) {
    let h = Number(tm[1]);
    if (tm[3]) h = (h % 12) + (tm[3].toLowerCase() === 'p' ? 12 : 0);
    time = `${String(h).padStart(2, '0')}:${tm[2]}`;
  }
  return { day, time };
}

function readList(text, firstOnly) {
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('The file has no rows');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const di = head.findIndex((h) => h.includes('date'));
  const si = head.findIndex((h) => h.includes('symbol') || h === 'stock');
  if (di < 0 || si < 0) throw new Error('Need a Date and a Symbol column (Chartink backtest export)');
  const seen = new Set();
  const out = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const w = parseWhen(r[di]);
    const symbol = String(r[si] || '').trim().toUpperCase();
    if (!w || !symbol) continue;
    if (firstOnly && w.time && w.time !== '09:15') {
      skipped++;
      continue;
    }
    const k = `${w.day}|${symbol}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ day: w.day, symbol });
  }
  return { list: out, skipped };
}

function jobsOf(list) {
  const by = new Map();
  for (const { day, symbol } of list) by.set(symbol, [...(by.get(symbol) || []), day]);
  const jobs = [];
  for (const [symbol, days] of by) {
    let chunk = [];
    for (const d of [...days].sort()) {
      if (chunk.length && (Date.parse(d) - Date.parse(chunk[0])) / 86_400_000 > 80) jobs.push({ symbol, days: chunk }), (chunk = []);
      chunk.push(d);
    }
    if (chunk.length) jobs.push({ symbol, days: chunk });
  }
  return jobs;
}

const load = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
};
const save = (key, v) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or blocked: results stay on screen */
  }
};

export default function StrategyBacktest({ config }) {
  const C = config;
  const SAVE = `stockhits.bt.${C.id}`;
  const secret = store.get(SECRET_KEY);
  const saved = useMemo(() => load(SAVE) || (C.legacyKey ? load(C.legacyKey) : null), [SAVE]); // eslint-disable-line react-hooks/exhaustive-deps
  const defaults = Object.fromEntries((C.params || []).map((p) => [p.key, p.def]));
  const [params, setParams] = useState(() => {
    // saved settings, minus any choice that no longer exists
    const ok = Object.fromEntries(Object.entries(saved?.params || {}).filter(([k, v]) => {
      const f = (C.params || []).find((p) => p.key === k);
      return f && (f.type !== 'select' || f.options.some(([o]) => o === v));
    }));
    return { ...defaults, ...ok };
  });
  const [firstOnly, setFirstOnly] = useState(true);
  const [file, setFile] = useState(saved?.file || '');
  const [list, setList] = useState(saved?.list || []);
  const [results, setResults] = useState(saved?.rows || []);
  const [usedParams, setUsedParams] = useState(saved?.usedParams || null);
  const [progress, setProgress] = useState(null);
  const [err, setErr] = useState('');
  const [onlyTrades, setOnlyTrades] = useState(false);
  const [cap, setCap] = useState(saved?.cap ?? 3);
  // where the stock-days come from: a Chartink CSV, or one of your Scanners on the server history
  const [source, setSource] = useState(saved?.source || 'csv');
  const [scans, setScans] = useState([]);
  const [scanId, setScanId] = useState(saved?.scanId || '');
  const [range, setRange] = useState(saved?.range || { from: '', to: '', minTurn: 0 });
  const [hist, setHist] = useState(null);
  useEffect(() => {
    if (source !== 'scanner' || !secret) return;
    api(secret, 'scanners').then((j) => {
      setScans(j.scanners);
      setScanId((cur) => (j.scanners.some((x) => x.id === cur) ? cur : j.scanners[0]?.id || ''));
    }).catch((e) => setErr(e.message));
    historyCall(secret, 'info').then((j) => {
      setHist(j);
      setRange((r) => (r.from && r.to ? r : { ...r, from: j.from, to: j.to }));
    }).catch((e) => setErr(e.message));
  }, [source, secret]);
  const runScanner = async (p = params) => {
    const scan = scans.find((x) => x.id === scanId);
    if (!scan) return setErr('Pick a scan (make one under NSE Market → Scanners).');
    setErr('');
    setProgress({ done: 0, total: 0, note: `Scanning ${hist?.stocks ?? ''} stocks and testing on the server — about 30–60 s for a year` });
    setResults([]);
    setUsedParams(p);
    try {
      const j = await historyCall(secret, 'backtest', { scan, from: range.from, to: range.to, minTurnoverCr: Number(range.minTurn) || 0, strategy: C.id, params: p });
      const label = `Scan “${scan.name}” · ${range.from} → ${range.to}${Number(range.minTurn) ? ` · turnover ≥ ₹${range.minTurn} Cr` : ''} · ${j.stocks} stocks · ${j.rows.length} stock-days found (${(j.ms / 1000).toFixed(0)} s)`;
      setFile(label);
      setResults(j.rows);
      save(SAVE, { file: label, list: [], rows: j.rows, params: p, usedParams: p, cap, source: 'scanner', scanId, range });
    } catch (e) {
      setErr(e.message);
    } finally {
      setProgress(null);
    }
  };
  const stopRef = useRef(false);

  const runList = async (items, label, keep, p = params) => {
    const jobs = jobsOf(items);
    const total = jobs.length;
    const rows = [...keep];
    let done = 0;
    stopRef.current = false;
    setResults([...rows]);
    setUsedParams(p);
    setProgress({ done, total });
    const queue = [...jobs];
    while (queue.length && !stopRef.current) {
      const job = queue.shift();
      for (let attempt = 0; ; attempt++) {
        try {
          const j = await api(secret, 'backtest', { method: 'POST', body: { strategy: C.id, ...job, params: p } });
          rows.push(...j.rows);
          break;
        } catch (e) {
          if (/rate limit/i.test(e.message) && attempt < RETRY_MS.length && !stopRef.current) {
            setProgress({ done, total, note: `Dhan asked to slow down — retrying ${job.symbol} in ${RETRY_MS[attempt] / 1000} s` });
            await sleep(RETRY_MS[attempt]);
            continue;
          }
          rows.push(...job.days.map((day) => ({ day, symbol: job.symbol, status: 'error', note: e.message })));
          break;
        }
      }
      done++;
      setProgress({ done, total });
      setResults([...rows]);
      if (queue.length) await sleep(GAP_MS);
    }
    setProgress(null);
    save(SAVE, { file: label, list: items, rows, params: p, usedParams: p, cap, source: 'csv' });
  };

  const upload = async (f) => {
    if (!f) return;
    setErr('');
    let parsed;
    try {
      parsed = readList(await f.text(), firstOnly);
    } catch (e) {
      setErr(e.message);
      return;
    }
    if (!parsed.list.length) return setErr(firstOnly ? 'No stocks at 09:15 in this file.' : 'No rows found.');
    const label = `${f.name} · ${parsed.list.length} stock-days${firstOnly ? ` at 09:15 (${parsed.skipped} later hits left out)` : ''}`;
    setFile(label);
    setList(parsed.list);
    await runList(parsed.list, label, []);
  };

  const failed = results.filter((r) => r.status === 'error' && !/not found/i.test(r.note || ''));
  const retryFailed = () => {
    const again = new Set(failed.map((r) => `${r.day}|${r.symbol}`));
    runList(failed.map(({ day, symbol }) => ({ day, symbol })), file, results.filter((r) => !again.has(`${r.day}|${r.symbol}`)), usedParams || params);
  };
  const changed = usedParams && JSON.stringify(usedParams) !== JSON.stringify(params);

  // trades in entry order; the daily cap keeps the first N of each day
  const sorted = useMemo(() => [...results].sort((a, b) => a.day.localeCompare(b.day) || a.symbol.localeCompare(b.symbol)), [results]);
  const taken = useMemo(() => {
    const t = results.map((r) => ({ r, t: C.trade(r) })).filter((x) => x.t).sort((a, b) => a.r.day.localeCompare(b.r.day) || String(a.t.entryAt).localeCompare(String(b.t.entryAt)));
    const perDay = new Map();
    const keep = new Set();
    for (const x of t) {
      const n = perDay.get(x.r.day) || 0;
      if (!cap || n < cap) keep.add(`${x.r.day}|${x.r.symbol}`);
      perDay.set(x.r.day, n + 1);
    }
    return { all: t, keep };
  }, [results, cap]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = useMemo(() => {
    const counts = new Map();
    for (const r of results) {
      const [, label] = C.statusOf(r);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const trades = taken.all.filter((x) => taken.keep.has(`${x.r.day}|${x.r.symbol}`));
    const days = new Set(results.map((r) => r.day)).size;
    const exits = {};
    for (const [k] of C.exits) {
      const xs = trades.map((x) => x.t.exits[k]).filter(Boolean);
      const wins = xs.filter((x) => x.r > 0).length;
      const totalR = xs.reduce((a, x) => a + x.r, 0);
      const totalP = xs.reduce((a, x) => a + x.pct, 0);
      const byDay = new Map();
      trades.forEach((x) => x.t.exits[k] && byDay.set(x.r.day, (byDay.get(x.r.day) || 0) + x.t.exits[k].pct));
      exits[k] = {
        n: xs.length,
        wins,
        rate: xs.length ? Math.round((wins / xs.length) * 100) : null,
        totalR,
        avgR: xs.length ? totalR / xs.length : null,
        avgP: xs.length ? totalP / xs.length : null,
        worstDayP: byDay.size ? Math.min(...byDay.values()) : null,
      };
    }
    return { n: results.length, days, counts: [...counts.entries()], trades: trades.length, allTrades: taken.all.length, exits };
  }, [results, taken]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = onlyTrades ? sorted.filter((r) => C.trade(r)) : sorted;
  const L = C.leverage || 5;

  const download = () => {
    const head = ['Day', 'Symbol', 'Status', ...C.csv.head, 'Entry time', 'Filled', ...C.exits.flatMap(([, l]) => [`${l} R`, `${l} %`, `${l} exit`]), 'Best move R', 'Counted (daily cap)', 'Note'];
    const lines = [head, ...sorted.map((r) => {
      const t = C.trade(r);
      return [r.day, r.symbol, C.statusOf(r)[1], ...C.csv.row(r), t?.entryAt || '', t?.fill ?? '',
        ...C.exits.flatMap(([k]) => (t?.exits[k] ? [t.exits[k].r, t.exits[k].pct, `${t.exits[k].how} ${t.exits[k].at} @ ${t.exits[k].px}`] : ['', '', ''])),
        t?.bestR ?? '', t ? (taken.keep.has(`${r.day}|${r.symbol}`) ? 'yes' : 'no') : '', r.note || ''];
    })];
    const csv = lines.map((l) => l.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${C.id}-backtest.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <section className="card">
        <div className="filters bt-source">
          <span className="muted-cell">Stocks from</span>
          <div className="seg" role="group" aria-label="Source">
            <button className={source === 'csv' ? 'on' : ''} disabled={!!progress} onClick={() => setSource('csv')}>Chartink CSV</button>
            <button className={source === 'scanner' ? 'on' : ''} disabled={!!progress} onClick={() => setSource('scanner')}>My scanner (server history)</button>
          </div>
        </div>
        <div className="filters">
          {!secret ? (
            <span className="status err">Sign in with your secret on the Market page to run a backtest.</span>
          ) : source === 'csv' ? (
            <>
              <label className="btn">
                {progress ? 'Running…' : 'Upload Chartink backtest CSV'}
                <input type="file" accept=".csv,text/csv" hidden disabled={!!progress} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              <label className="ema-day">
                <input type="checkbox" checked={firstOnly} onChange={(e) => setFirstOnly(e.target.checked)} disabled={!!progress} />
                <span>Only stocks at the first candle (09:15)</span>
              </label>
            </>
          ) : (
            <>
              <select className="auto-amount bt-input" value={scanId} disabled={!!progress} onChange={(e) => setScanId(e.target.value)}>
                {!scans.length && <option value="">No scans yet — make one in Scanners</option>}
                {scans.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
              <label className="ema-day"><span>From</span><input className="auto-amount bt-input" type="date" value={range.from} min={hist?.from} max={range.to} disabled={!!progress} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
              <label className="ema-day"><span>To</span><input className="auto-amount bt-input" type="date" value={range.to} min={range.from} max={hist?.to} disabled={!!progress} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
              <label className="ema-day" title="Average daily traded value, last 20 sessions"><span>Min turnover ₹ Cr</span><input className="auto-amount bt-input bt-num" type="number" min="0" value={range.minTurn} disabled={!!progress} onChange={(e) => setRange({ ...range, minTurn: e.target.value })} /></label>
              <button className="btn primary" disabled={!!progress || !scanId || !range.from || !range.to} onClick={() => runScanner()}>{progress ? 'Running…' : 'Run backtest'}</button>
            </>
          )}
          {progress && (
            <>
              <span className="muted-cell">{progress.total ? `${progress.done} / ${progress.total} stocks` : ''}{progress.note ? `${progress.total ? ' · ' : ''}${progress.note}` : ''}</span>
              {progress.total > 0 && <button className="btn" onClick={() => (stopRef.current = true)}>Stop</button>}
            </>
          )}
          {!progress && secret && changed && source === 'csv' && !!list.length && <button className="btn primary" onClick={() => runList(list, file, [])}>Run again with these settings</button>}
          {!progress && secret && changed && source === 'scanner' && !!results.length && <button className="btn primary" onClick={() => runScanner()}>Run again with these settings</button>}
          {!!failed.length && !progress && secret && <button className="btn" onClick={retryFailed}>Retry {failed.length} failed</button>}
          {!!results.length && !progress && <button className="btn push" onClick={download}>Download CSV</button>}
        </div>
        {!!C.params?.length && (
          <div className="filters bt-params">
            {C.params.map((p) => (
              <label key={p.key} className="ema-day">
                <span>{p.label}</span>
                {p.type === 'select' ? (
                  <select className="auto-amount bt-input" value={params[p.key]} disabled={!!progress} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })}>
                    {p.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                ) : (
                  <input className="auto-amount bt-input bt-num" type="number" step={p.step || 'any'} value={params[p.key]} disabled={!!progress} onChange={(e) => setParams({ ...params, [p.key]: e.target.value === '' ? '' : Number(e.target.value) })} />
                )}
              </label>
            ))}
            <button className="link" disabled={!!progress} onClick={() => setParams(defaults)}>Defaults</button>
          </div>
        )}
        <p className="muted-cell ema-bt-file">{file || (source === 'scanner' ? 'Pick one of your scans and a date range: the server finds every stock-day the scan matches over the saved history, then runs this strategy on each (the scan decides which stocks; the strategy decides the trade).' : C.intro)}</p>
        {changed && <p className="muted-cell ema-bt-file">Settings changed since this run — click “Run again” to use them.</p>}
        {err && <p className="status err tk-pos-msg">{err}</p>}
      </section>

      {!!results.length && (
        <>
          <section className="stats">
            <div className="stat">
              <div className="stat-label">Stock-days tested</div>
              <div className="stat-value">{sum.n}</div>
              <div className="stat-note">{sum.days} days · {sum.counts.map(([l, n]) => `${n} ${l.toLowerCase()}`).join(' · ')}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Trades counted</div>
              <div className="stat-value">{sum.trades}</div>
              <div className="stat-note">
                of {sum.allTrades} · max per day{' '}
                <select className="bt-cap" value={cap} onChange={(e) => { const v = Number(e.target.value); setCap(v); const cur = load(SAVE); if (cur) save(SAVE, { ...cur, cap: v }); }}>
                  {CAPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
          </section>
          <section className="stats">
            {C.exits.map(([k, label, hint]) => {
              const e = sum.exits[k];
              return (
                <div className="stat" key={k} title={hint}>
                  <div className="stat-label">{label}</div>
                  <div className={`stat-value ${tone(e.totalR)}`}>{e.n ? fmtR(e.totalR) : '—'}</div>
                  <div className="stat-note">
                    {e.n ? <>{e.wins}/{e.n} won ({e.rate}%) · avg {fmtR(e.avgR)}<br />avg {fmtP(e.avgP)} a trade · <b>{fmtP(e.avgP * L)} at {L}×</b><br />worst day {fmtP(e.worstDayP)} ({fmtP(e.worstDayP * L)} at {L}×)</> : 'no trades'}
                  </div>
                </div>
              );
            })}
          </section>

          <section className="card">
            <div className="filters">
              <label className="ema-day">
                <input type="checkbox" checked={onlyTrades} onChange={(e) => setOnlyTrades(e.target.checked)} />
                <span>Trades only</span>
              </label>
              <span className="muted-cell">1R = entry → stop. % = move on the stock; at {L}× multiply by {L}. A minute that touches both stop and target counts as the stop. Brokerage not included. Greyed trades are beyond the daily limit.</span>
            </div>
            <div className="table-wrap">
              <table className="journal ema-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Stock</th>
                    <th>Status</th>
                    {C.columns.map((c) => <th key={c.head} className={c.num ? 'num' : ''}>{c.head}</th>)}
                    {C.exits.map(([k, l]) => <th key={k} className="num">{l}</th>)}
                    <th className="num">Best move</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const [cls, label] = C.statusOf(r);
                    const t = C.trade(r);
                    const out = t && !taken.keep.has(`${r.day}|${r.symbol}`);
                    return (
                      <tr key={`${r.day}|${r.symbol}`} className={`${t ? 'ema-alert' : ''} ${out ? 'bt-out' : ''}`}>
                        <td className="mono">{r.day.slice(5)}</td>
                        <td className="mono"><b>{r.symbol}</b></td>
                        <td>
                          <span className={`ema-st ${cls}`}>{label}</span>
                          {r.note && !t && <div className="muted-cell ema-note">{r.note}</div>}
                          {out && <div className="muted-cell ema-note">beyond daily limit</div>}
                        </td>
                        {C.columns.map((c) => <td key={c.head} className={c.num ? 'num mono' : 'mono'}>{c.cell(r)}</td>)}
                        {C.exits.map(([k]) => {
                          const x = t?.exits[k];
                          return (
                            <td key={k} className={`num mono ${x ? tone(x.r) : 'muted-cell'}`} title={x ? `${x.how} ${x.at} @ ${x.px}` : ''}>
                              {x ? <>{fmtR(x.r)}<div className="muted-cell ema-note">{fmtP(x.pct)} · {x.how} {x.at}</div></> : '—'}
                            </td>
                          );
                        })}
                        <td className="num mono muted-cell">{t?.bestR != null ? fmtR(t.bestR) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!shown.length && <div className="empty">No trades in this backtest.</div>}
            </div>
          </section>
        </>
      )}
    </>
  );
}
