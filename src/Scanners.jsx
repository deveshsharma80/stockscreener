import { useEffect, useMemo, useState } from 'react';
import { SECRET_KEY, SecretGate, api, store } from './Ticker.jsx';
import { historyCall } from './historyApi.js';
import { ARITH, COMPARE, INDICATORS, PRICE_FIELDS, TEMPLATES, TIMEFRAMES, checkScan, condText } from './scanner/engine.js';

// NSE Market → Scanners: build your own scans (Chartink style), save them, and test them on
// the year of 1-minute history on the Vultr server. Back Test can use a scan as its stock list.

const OFFS = [0, 1, 2, 3, 4, 5];
const newTerm = (t, tf = 5) =>
  t === 'num' ? { t: 'num', v: 0 } : t === 'price' ? { t: 'price', f: 'close', tf, off: 0 } : { t: 'ind', ind: 'ema', n: 9, tf, off: 0 };
const newCond = (tf) => ({ left: { a: newTerm('price', tf) }, cmp: '>', right: { a: newTerm('num') } });
const blank = () => ({ name: '', tf: 5, at: 'first', from: '09:20', to: '15:00', firstOnly: true, conditions: [newCond(5)] });
const clone = (x) => JSON.parse(JSON.stringify(x));
const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });

function Term({ v, onChange }) {
  const set = (patch) => onChange({ ...v, ...patch });
  const ind = INDICATORS.find((i) => i[0] === v.ind);
  return (
    <span className="sc-term">
      <select className="sc-sel sc-kind" value={v.t} onChange={(e) => onChange(newTerm(e.target.value, v.tf || 5))} title="Number, price or indicator">
        <option value="num">Number</option>
        <option value="price">Price</option>
        <option value="ind">Indicator</option>
      </select>
      {v.t === 'num' ? (
        <input className="sc-in sc-num" type="number" step="any" value={v.v} onChange={(e) => set({ v: e.target.value === '' ? '' : Number(e.target.value) })} />
      ) : (
        <>
          <select className="sc-sel" value={v.off} onChange={(e) => set({ off: Number(e.target.value) })} title="Candles ago: [0] = the latest closed candle">
            {OFFS.map((o) => <option key={o} value={o}>[{o}]</option>)}
          </select>
          <select className="sc-sel" value={v.tf} onChange={(e) => set({ tf: Number(e.target.value) })}>
            {TIMEFRAMES.map((t) => <option key={t} value={t}>{t} min</option>)}
          </select>
          {v.t === 'price' ? (
            <select className="sc-sel sc-strong" value={v.f} onChange={(e) => set({ f: e.target.value })}>
              {PRICE_FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          ) : (
            <>
              <select
                className="sc-sel sc-strong"
                value={v.ind}
                onChange={(e) => {
                  const d = INDICATORS.find((i) => i[0] === e.target.value);
                  onChange({ t: 'ind', ind: d[0], tf: v.tf, off: v.off, ...(d[3][0] != null ? { n: d[3][0] } : {}), ...(d[3][1] != null ? { k: d[3][1] } : {}) });
                }}
              >
                {INDICATORS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              {ind?.[2].length > 0 && (
                <span className="sc-args">
                  (<input className="sc-in sc-arg" type="number" min="1" value={v.n} title={ind[2][0]} onChange={(e) => set({ n: Number(e.target.value) })} />
                  {ind[2][1] && <>,<input className="sc-in sc-arg" type="number" step="0.1" value={v.k} title={ind[2][1]} onChange={(e) => set({ k: Number(e.target.value) })} /></>})
                </span>
              )}
            </>
          )}
        </>
      )}
    </span>
  );
}

function Side({ v, onChange }) {
  return (
    <span className="sc-side">
      <Term v={v.a} onChange={(a) => onChange({ ...v, a })} />
      {v.op ? (
        <>
          <select className="sc-sel sc-op" value={v.op} onChange={(e) => onChange({ ...v, op: e.target.value })}>
            {ARITH.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <Term v={v.b} onChange={(b) => onChange({ ...v, b })} />
          <button className="link sc-x" title="Remove the maths" onClick={() => onChange({ a: v.a })}>×</button>
        </>
      ) : (
        <button className="link sc-plus" title="Add maths: + − × ÷" onClick={() => onChange({ ...v, op: '*', b: newTerm('num') })}>+ maths</button>
      )}
    </span>
  );
}

function Editor({ scan, onSave, onCancel, onDelete, busy }) {
  const [s, setS] = useState(() => clone(scan));
  const errs = checkScan(s);
  const setCond = (i, c) => setS({ ...s, conditions: s.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <section className="card pad sc-editor">
      <div className="sc-head">
        <input className="sc-in sc-name" placeholder="Scan name, e.g. Bollinger first candle" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
        <label className="ema-day">
          <span>Timeframe</span>
          <select className="sc-sel" value={s.tf} onChange={(e) => setS({ ...s, tf: Number(e.target.value) })}>
            {TIMEFRAMES.map((t) => <option key={t} value={t}>{t} minute</option>)}
          </select>
        </label>
        <label className="ema-day">
          <span>Check</span>
          <select className="sc-sel" value={s.at} onChange={(e) => setS({ ...s, at: e.target.value })}>
            <option value="first">First candle only (09:15)</option>
            <option value="window">Every candle between…</option>
          </select>
        </label>
        {s.at === 'window' && (
          <>
            <input className="sc-in sc-time" type="time" value={s.from} onChange={(e) => setS({ ...s, from: e.target.value })} />
            <span className="muted-cell">to</span>
            <input className="sc-in sc-time" type="time" value={s.to} onChange={(e) => setS({ ...s, to: e.target.value })} />
            <label className="ema-day">
              <input type="checkbox" checked={s.firstOnly !== false} onChange={(e) => setS({ ...s, firstOnly: e.target.checked })} />
              <span>First hit per stock per day</span>
            </label>
          </>
        )}
      </div>
      <p className="muted-cell sc-sub">Stock passes <b>all</b> of the below filters in cash segment:</p>
      <div className="sc-conds">
        {s.conditions.map((c, i) => (
          <div key={i} className={`sc-cond ${c.off ? 'sc-off' : ''}`}>
            <Side v={c.left} onChange={(left) => setCond(i, { ...c, left })} />
            <select className="sc-sel sc-cmp" value={c.cmp} onChange={(e) => setCond(i, { ...c, cmp: e.target.value })}>
              {COMPARE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <Side v={c.right} onChange={(right) => setCond(i, { ...c, right })} />
            <span className="sc-row-tools">
              <label className="sc-toggle" title="Turn this condition on / off without deleting it">
                <input type="checkbox" checked={!c.off} onChange={(e) => setCond(i, { ...c, off: !e.target.checked })} />
              </label>
              <button className="link" title="Copy" onClick={() => setS({ ...s, conditions: [...s.conditions.slice(0, i + 1), clone(c), ...s.conditions.slice(i + 1)] })}>⧉</button>
              <button className="link sc-x" title="Delete" onClick={() => setS({ ...s, conditions: s.conditions.filter((_, j) => j !== i) })}>×</button>
            </span>
            <div className="sc-read muted-cell">{condText(c)}</div>
          </div>
        ))}
      </div>
      <div className="filters sc-foot">
        <button className="btn" onClick={() => setS({ ...s, conditions: [...s.conditions, newCond(s.tf)] })}>+ Add condition</button>
        <span className="push" />
        {errs.length > 0 && <span className="status err">{errs[0]}</span>}
        {onDelete && <button className="btn danger-outline" disabled={busy} onClick={onDelete}>Delete</button>}
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" disabled={busy || errs.length > 0} onClick={() => onSave(s)}>Save scan</button>
      </div>
    </section>
  );
}

function Tester({ secret, scan }) {
  const [info, setInfo] = useState(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [minTurn, setMinTurn] = useState(0);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    historyCall(secret, 'info')
      .then((j) => {
        setInfo(j);
        setTo(j.to || '');
        if (j.to) setFrom(new Date(Date.parse(j.to) - 30 * 86_400_000).toISOString().slice(0, 10));
      })
      .catch((e) => setErr(e.message));
  }, [secret]);
  const run = async () => {
    setBusy(true);
    setErr('');
    setRes(null);
    try {
      setRes(await historyCall(secret, 'scan', { scan, from, to, minTurnoverCr: Number(minTurn) || 0 }));
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const perDay = useMemo(() => {
    const m = new Map();
    for (const h of res?.hits || []) m.set(h.day, (m.get(h.day) || 0) + 1);
    return [...m.entries()];
  }, [res]);
  const download = () => {
    // Chartink's backtest format, so Back Test → CSV upload can use it too
    const t12 = (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
    };
    const lines = ['"Date","Symbol","Close"', ...res.hits.map((h) => `"${h.day.slice(8, 10)}-${h.day.slice(5, 7)}-${h.day.slice(0, 4)} ${t12(h.time)}","${h.symbol}","${h.close}"`)];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `${scan.name.replace(/[^a-z0-9]+/gi, '-')}-scan.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <section className="card">
      <div className="filters">
        <b>Test on history</b>
        {info && <span className="muted-cell">{info.stocks} stocks · {fmtDay(info.from)} – {fmtDay(info.to)}</span>}
        <span className="push" />
        <label className="ema-day"><span>From</span><input className="sc-in" type="date" value={from} min={info?.from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="ema-day"><span>To</span><input className="sc-in" type="date" value={to} min={from} max={info?.to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="ema-day" title="Average daily traded value (₹ crore, last 20 sessions)"><span>Min turnover ₹ Cr</span><input className="sc-in sc-num" type="number" min="0" value={minTurn} onChange={(e) => setMinTurn(e.target.value)} /></label>
        <button className="btn primary" disabled={busy || !info || !from || !to} onClick={run}>{busy ? 'Scanning…' : 'Run scan'}</button>
        {res?.hits?.length > 0 && <button className="btn" onClick={download}>Download CSV</button>}
      </div>
      {err && <p className="status err tk-pos-msg">{err}</p>}
      {busy && <p className="muted-cell ema-bt-file">Scanning every stock on the server — about 30 seconds for a year.</p>}
      {res && (
        <>
          <p className="muted-cell ema-bt-file">
            <b>{res.hits.length}</b> hits on <b>{perDay.length}</b> of the trading days in range · {res.stocks} stocks scanned in {(res.ms / 1000).toFixed(1)} s
            {perDay.length > 0 && ` · busiest: ${[...perDay].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${fmtDay(d)} (${n})`).join(', ')}`}
          </p>
          {res.hits.length > 0 && (
            <div className="table-wrap sc-hits">
              <table className="journal">
                <thead><tr><th>Day</th><th>Time</th><th>Stock</th><th className="num">Close</th><th>Values (left / right per condition)</th></tr></thead>
                <tbody>
                  {[...res.hits].reverse().slice(0, 500).map((h, i) => (
                    <tr key={i}>
                      <td className="mono">{fmtDay(h.day)}</td>
                      <td className="mono">{h.time}</td>
                      <td className="mono"><b>{h.symbol}</b></td>
                      <td className="num mono">{h.close}</td>
                      <td className="mono muted-cell">{h.values.map((v) => `${v[0]} / ${v[1]}`).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {res.hits.length > 500 && <div className="empty">Showing the latest 500 — download the CSV for all {res.hits.length}.</div>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function Scanners() {
  const [secret, setSecret] = useState(() => store.get(SECRET_KEY));
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null); // scan being edited (new: no id)
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async (s = secret) => {
    try {
      const j = await api(s, 'scanners');
      setList(j.scanners);
      setUnlocked(true);
      setError('');
      return j.scanners;
    } catch (e) {
      setError(e.message);
      return null;
    }
  };
  useEffect(() => {
    if (secret) load(secret).then((l) => !l && (store.set(SECRET_KEY, ''), setSecret('')));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (s) => {
    setBusy(true);
    setMsg(null);
    try {
      const j = await api(secret, 'scanner-save', { method: 'POST', body: { scanner: s } });
      await load();
      setEditing(null);
      setSelected(j.scanner.id);
      setMsg({ ok: true, text: `Saved “${j.scanner.name}”.` });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (s) => {
    if (!window.confirm(`Delete the scan “${s.name}”?`)) return;
    setBusy(true);
    try {
      await api(secret, 'scanner-delete', { method: 'POST', body: { id: s.id } });
      await load();
      setEditing(null);
      setSelected(null);
    } finally {
      setBusy(false);
    }
  };

  if (!unlocked) return <SecretGate error={error} notice="" onSubmit={async (s, remember) => { setSecret(s); if (await load(s)) store.set(SECRET_KEY, remember ? s : ''); }} />;
  const cur = list.find((x) => x.id === selected);

  return (
    <>
      <section className="card">
        <div className="filters">
          <button className="btn primary" onClick={() => setEditing(blank())}>+ New scan</button>
          <label className="ema-day">
            <span>or start from</span>
            <select className="sc-sel" value="" onChange={(e) => e.target.value !== '' && setEditing(clone(TEMPLATES[Number(e.target.value)]))}>
              <option value="">a template…</option>
              {TEMPLATES.map((t, i) => <option key={i} value={i}>{t.name}</option>)}
            </select>
          </label>
          <span className="muted-cell">Your scans run on the Vultr server over the saved 1-minute history (2, 3, 5 and 15-minute candles are built from it).</span>
        </div>
        {msg && <p className={`status ${msg.ok ? 'ok' : 'err'} tk-pos-msg`}>{msg.text}</p>}
        <div className="table-wrap">
          <table className="journal">
            <thead><tr><th>Scan</th><th>Timeframe</th><th>Checks</th><th>Conditions</th><th /></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className={s.id === selected ? 'ema-alert' : ''} onClick={() => setSelected(s.id)} style={{ cursor: 'pointer' }}>
                  <td><b>{s.name}</b></td>
                  <td className="mono">{s.tf} min</td>
                  <td className="muted-cell">{s.at === 'first' ? 'first candle (09:15)' : `${s.from}–${s.to}${s.firstOnly !== false ? ', first hit a day' : ''}`}</td>
                  <td className="muted-cell sc-summary">{s.conditions.filter((c) => !c.off).map((c, i) => <div key={i}>{condText(c)}</div>)}</td>
                  <td className="sc-actions">
                    <button className="btn" onClick={(e) => (e.stopPropagation(), setEditing(clone(s)))}>Edit</button>
                    <button className="btn" onClick={(e) => (e.stopPropagation(), setEditing({ ...clone(s), id: undefined, name: `${s.name} (copy)` }))}>Copy</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <div className="empty">No scans yet — start with “+ New scan” or a template (your Bollinger first-candle screener is one).</div>}
        </div>
      </section>
      {editing && <Editor key={editing.id || 'new'} scan={editing} busy={busy} onSave={save} onCancel={() => setEditing(null)} onDelete={editing.id ? () => remove(editing) : null} />}
      {!editing && cur && <Tester key={cur.id} secret={secret} scan={cur} />}
    </>
  );
}
