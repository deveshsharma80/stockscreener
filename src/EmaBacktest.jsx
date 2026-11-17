import { useMemo, useRef, useState } from 'react';
import { SECRET_KEY, api, price, store } from './Ticker.jsx';
import { EMA_SCAN, PARAMS } from './emasetup.js';

// Signals → EMA Rejection → Backtest. Upload Chartink's backtest export for the screener
// (Date, Symbol, …); for each stock-day the server fetches that day's 1-minute candles from
// Dhan and runs the same rejection check as the live tab, then scores what happened after
// each alert with three exits (the setup's target, a fixed 1:2, holding to 15:15).

const SAVE_KEY = 'stockhits.emaBacktest';
const EXITS = [
  ['target', 'Setup target', 'day’s low (or 1:2 when the day’s low is above the entry)'],
  ['twoR', 'Fixed 1:2', 'target = entry − 2 × risk'],
  ['hold', `Hold to ${PARAMS.exitBy}`, 'stop only, closed at ' + PARAMS.exitBy],
];
const GAP_MS = 1500; // pause between stocks
const RETRY_MS = [5000, 10000, 20000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (v == null ? '—' : price.format(v));
const fmtR = (r) => (r == null ? '—' : `${r > 0 ? '+' : ''}${r.toFixed(2)}R`);

/** Minimal CSV parser (quoted fields, commas, CRLF). */
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

/** "29-10-2026 9:15 am" | "2026-10-29 09:15" | "29/10/2026" → { day: '2026-10-29', time: '09:15' | null } */
function parseWhen(s) {
  const t = String(s || '').trim();
  let m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(.*)$/.exec(t);
  let day;
  let rest;
  if (m) {
    day = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    rest = m[4];
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(t))) {
    day = `${m[1]}-${m[2]}-${m[3]}`;
    rest = m[4];
  } else return null;
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
  const di = head.findIndex((h) => h === 'date' || h.includes('date'));
  const si = head.findIndex((h) => h === 'symbol' || h.includes('symbol') || h === 'stock');
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

/** symbol → [days], split so one Dhan request covers ≤ 80 days */
function jobsOf(list) {
  const by = new Map();
  for (const { day, symbol } of list) by.set(symbol, [...(by.get(symbol) || []), day]);
  const jobs = [];
  for (const [symbol, days] of by) {
    const ds = [...days].sort();
    let chunk = [];
    for (const d of ds) {
      if (chunk.length && (Date.parse(d) - Date.parse(chunk[0])) / 86_400_000 > 80) jobs.push({ symbol, days: chunk }), (chunk = []);
      chunk.push(d);
    }
    if (chunk.length) jobs.push({ symbol, days: chunk });
  }
  return jobs;
}

const statusOf = (r) => {
  if (r.status === 'rejected') return ['rejected', 'Rejected → short'];
  if (r.status === 'broke-out') return ['broke-out', 'Broke above 26 EMA'];
  if (r.status === 'error') return ['error', 'Error'];
  if (r.status === 'waiting') return ['waiting', 'No data'];
  return r.touchedAt ? ['touched', 'At EMA, no rejection'] : ['watching', 'Never reached 9 EMA'];
};
const outcomeText = (o) => {
  if (!o) return '—';
  if (o.result === 'cancelled') return 'Stop hit before entry';
  if (o.result === 'no-entry') return 'Entry never triggered';
  if (o.result === 'invalid') return 'Invalid levels';
  return null;
};

function load() {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
  } catch {
    return null;
  }
}

export default function EmaBacktest() {
  const secret = store.get(SECRET_KEY);
  const saved = useMemo(load, []);
  const [firstOnly, setFirstOnly] = useState(true);
  const [file, setFile] = useState(saved?.file || '');
  const [results, setResults] = useState(saved?.rows || []);
  const [progress, setProgress] = useState(null);
  const [err, setErr] = useState('');
  const [onlyAlerts, setOnlyAlerts] = useState(false);
  const stopRef = useRef(false);

  const run = async (f) => {
    if (!f) return;
    setErr('');
    let parsed;
    try {
      parsed = readList(await f.text(), firstOnly);
    } catch (e) {
      setErr(e.message);
      return;
    }
    if (!parsed.list.length) {
      setErr(firstOnly ? 'No stocks at 09:15 in this file.' : 'No rows found.');
      return;
    }
    const label = `${f.name} · ${parsed.list.length} stock-days${firstOnly ? ' at 09:15' : ''}`;
    setFile(`${f.name} · ${parsed.list.length} stock-days${firstOnly ? ` at 09:15 (${parsed.skipped} later hits left out)` : ''}`);
    await runList(parsed.list, label, []);
  };

  /** Back-test `list` ({day, symbol}); `keep` = earlier results that stay as they are. */
  const runList = async (list, label, keep) => {
    const jobs = jobsOf(list);
    const total = jobs.length;
    const rows = [...keep];
    let done = 0;
    stopRef.current = false;
    setResults([...rows]);
    setProgress({ done, total });
    const queue = [...jobs];
    while (queue.length && !stopRef.current) {
      const job = queue.shift();
      for (let attempt = 0; ; attempt++) {
        try {
          const j = await api(secret, 'ema-backtest', { method: 'POST', body: job });
          rows.push(...j.rows);
          break;
        } catch (e) {
          // Dhan said "too many requests": wait longer and try the same stock again
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
      if (queue.length) await sleep(GAP_MS); // one stock at a time, spaced out for Dhan
    }
    setProgress(null);
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ file: label, rows }));
    } catch {
      /* storage full or blocked: results stay on screen */
    }
  };

  // stock-days that failed for a reason worth retrying (not "not found in Dhan's list")
  const failed = results.filter((r) => r.status === 'error' && !/not found/i.test(r.note || ''));
  const retryFailed = () => {
    const again = new Set(failed.map((r) => `${r.day}|${r.symbol}`));
    runList(failed.map(({ day, symbol }) => ({ day, symbol })), file, results.filter((r) => !again.has(`${r.day}|${r.symbol}`)));
  };

  const sorted = useMemo(() => [...results].sort((a, b) => a.day.localeCompare(b.day) || a.symbol.localeCompare(b.symbol)), [results]);
  const shown = onlyAlerts ? sorted.filter((r) => r.status === 'rejected') : sorted;

  const sum = useMemo(() => {
    const s = { n: results.length, alerts: 0, entered: 0, cancelled: 0, noEntry: 0, broke: 0, touched: 0, never: 0, errors: 0, exits: {} };
    for (const r of results) {
      const [k] = statusOf(r);
      if (k === 'rejected') s.alerts++;
      else if (k === 'broke-out') s.broke++;
      else if (k === 'touched') s.touched++;
      else if (k === 'watching') s.never++;
      else s.errors++;
      const o = r.outcome;
      if (o?.result === 'entered') s.entered++;
      if (o?.result === 'cancelled') s.cancelled++;
      if (o?.result === 'no-entry') s.noEntry++;
    }
    for (const [k] of EXITS) {
      const rs = results.filter((r) => r.outcome?.result === 'entered').map((r) => r.outcome[k]);
      const wins = rs.filter((x) => x.r > 0).length;
      const total = rs.reduce((a, x) => a + x.r, 0);
      s.exits[k] = { n: rs.length, wins, rate: rs.length ? Math.round((wins / rs.length) * 100) : null, total: Math.round(total * 100) / 100, avg: rs.length ? Math.round((total / rs.length) * 100) / 100 : null };
    }
    return s;
  }, [results]);

  const download = () => {
    const head = ['Day', 'Symbol', 'Status', 'Gap %', 'EMA touch', 'Alert', 'Entry', 'Stop', 'Target', 'Filled', 'Filled at', ...EXITS.flatMap(([, l]) => [`${l} R`, `${l} exit`]), 'Best move R', 'Note'];
    const lines = [head, ...sorted.map((r) => {
      const o = r.outcome;
      return [r.day, r.symbol, statusOf(r)[1], r.gapPct ?? '', r.touchedAt || '', r.alertAt || '', r.entry ?? '', r.sl ?? '', r.target ?? '', o?.fill ?? '', o?.entryAt || outcomeText(o) || '',
        ...EXITS.flatMap(([k]) => (o?.[k] ? [o[k].r, `${o[k].how} ${o[k].at} @ ${o[k].px}`] : ['', ''])), o?.mfeR ?? '', r.note || ''];
    })];
    const csv = lines.map((l) => l.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'ema-rejection-backtest.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <section className="card">
        <div className="filters">
          {secret ? (
            <label className="btn">
              {progress ? 'Running…' : 'Upload Chartink backtest CSV'}
              <input type="file" accept=".csv,text/csv" hidden disabled={!!progress} onChange={(e) => { run(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          ) : (
            <span className="status err">Sign in with your secret on the Market page to run a backtest.</span>
          )}
          <label className="ema-day">
            <input type="checkbox" checked={firstOnly} onChange={(e) => setFirstOnly(e.target.checked)} disabled={!!progress} />
            <span>Only stocks at the first candle (09:15)</span>
          </label>
          {progress && (
            <>
              <span className="muted-cell">{progress.done} / {progress.total} stocks{progress.note ? ` · ${progress.note}` : ''}</span>
              <button className="btn" onClick={() => (stopRef.current = true)}>Stop</button>
            </>
          )}
          {!!failed.length && !progress && secret && <button className="btn" onClick={retryFailed}>Retry {failed.length} failed</button>}
          {!!results.length && !progress && <button className="btn push" onClick={download}>Download CSV</button>}
        </div>
        <p className="muted-cell ema-bt-file">
          {file || `Export the backtest of “${EMA_SCAN}” from Chartink (Date, Symbol …) and upload it here.`} Same rules as the live tab; candles from Dhan.
        </p>
        {err && <p className="status err tk-pos-msg">{err}</p>}
      </section>

      {!!results.length && (
        <>
          <section className="stats">
            <div className="stat"><div className="stat-label">Stock-days tested</div><div className="stat-value">{sum.n}</div><div className="stat-note">{sum.never} never reached the 9 EMA · {sum.touched} touched, no rejection{sum.errors ? ` · ${sum.errors} no data / error` : ''}</div></div>
            <div className="stat"><div className="stat-label">Rejection alerts</div><div className="stat-value neg">{sum.alerts}</div><div className="stat-note">{sum.n ? Math.round((sum.alerts / sum.n) * 100) : 0}% of stock-days · {sum.broke} broke above 26 EMA</div></div>
            <div className="stat"><div className="stat-label">Short entered</div><div className="stat-value">{sum.entered}</div><div className="stat-note">{sum.cancelled} stop hit first · {sum.noEntry} never triggered</div></div>
          </section>
          <section className="stats">
            {EXITS.map(([k, label, hint]) => {
              const e = sum.exits[k];
              return (
                <div className="stat" key={k} title={hint}>
                  <div className="stat-label">{label}</div>
                  <div className={`stat-value ${e.total > 0 ? 'pos' : e.total < 0 ? 'neg' : ''}`}>{e.n ? fmtR(e.total) : '—'}</div>
                  <div className="stat-note">{e.n ? `${e.wins}/${e.n} won (${e.rate}%) · avg ${fmtR(e.avg)}` : 'no trades'}</div>
                </div>
              );
            })}
          </section>

          <section className="card">
            <div className="filters">
              <label className="ema-day">
                <input type="checkbox" checked={onlyAlerts} onChange={(e) => setOnlyAlerts(e.target.checked)} />
                <span>Alerts only</span>
              </label>
              <span className="muted-cell">1R = entry → stop. A minute that touches both stop and target counts as the stop. Brokerage not included.</span>
            </div>
            <div className="table-wrap">
              <table className="journal ema-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Stock</th>
                    <th>Status</th>
                    <th className="num">Gap</th>
                    <th>Times</th>
                    <th className="num">Entry ↓</th>
                    <th className="num">Stop</th>
                    <th className="num">Target</th>
                    {EXITS.map(([k, l]) => <th key={k} className="num">{l}</th>)}
                    <th className="num">Best move</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const [k, label] = statusOf(r);
                    const o = r.outcome;
                    const why = outcomeText(o);
                    return (
                      <tr key={`${r.day}|${r.symbol}`} className={k === 'rejected' ? 'ema-alert' : ''}>
                        <td className="mono">{r.day.slice(5)}</td>
                        <td className="mono"><b>{r.symbol}</b></td>
                        <td>
                          <span className={`ema-st ${k}`}>{label}</span>
                          {(r.status === 'error' || r.status === 'waiting') && r.note && <div className="muted-cell ema-note">{r.note}</div>}
                          {k === 'rejected' && why && <div className="muted-cell ema-note">{why}</div>}
                        </td>
                        <td className={`num mono ${r.gapPct < 0 ? 'neg' : r.gapPct > 0 ? 'pos' : ''}`}>{r.gapPct == null ? '—' : `${r.gapPct > 0 ? '+' : ''}${r.gapPct.toFixed(2)}%`}</td>
                        <td className="mono muted-cell ema-times">
                          {r.touchedAt && <div>EMA {r.touchedAt}</div>}
                          {r.alertAt && <div><b className="neg">alert {r.alertAt}</b></div>}
                          {o?.entryAt && <div>in {o.entryAt}</div>}
                          {r.brokeAt && <div>✗ {r.brokeAt}</div>}
                        </td>
                        <td className="num mono"><b>{fmt(r.entry)}</b></td>
                        <td className="num mono neg">{fmt(r.sl)}</td>
                        <td className="num mono pos">{fmt(r.target)}</td>
                        {EXITS.map(([ek]) => {
                          const x = o?.[ek];
                          return (
                            <td key={ek} className={`num mono ${x ? (x.r > 0 ? 'pos' : x.r < 0 ? 'neg' : '') : 'muted-cell'}`} title={x ? `${x.how} ${x.at} @ ${x.px}` : ''}>
                              {x ? <>{fmtR(x.r)}<div className="muted-cell ema-note">{x.how} {x.at}</div></> : '—'}
                            </td>
                          );
                        })}
                        <td className="num mono muted-cell">{o?.mfeR != null ? fmtR(o.mfeR) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!shown.length && <div className="empty">No alerts in this backtest.</div>}
            </div>
          </section>
        </>
      )}
    </>
  );
}
