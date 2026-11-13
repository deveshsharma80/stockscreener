import { useEffect, useMemo, useRef, useState } from 'react';
import { PRODUCT_LABEL, TRADE_TYPES, describe } from './Ticker.jsx';

// Paper Trading → Charts: cumulative net P&L per trade type, daily P&L, win/loss,
// where brokerage goes, and the best / worst instruments. Built from the same
// fills as the Fills tab and its CSV export.

const SHORT = { EQ_INTRADAY: 'Intraday', IDX_OPT_BUY: 'Index options', STK_OPT_BUY: 'Stock options', ALL: 'All types' };
const COLOR = { EQ_INTRADAY: 'var(--pc-1)', IDX_OPT_BUY: 'var(--pc-2)', STK_OPT_BUY: 'var(--pc-3)', ALL: 'var(--text)' };
const RANGES = [
  ['all', 'All time', null],
  ['30', '30 days', 30],
  ['7', '7 days', 7],
  ['today', 'Today', 1],
];

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = (v) => `${v < 0 ? '−' : ''}₹${inr.format(Math.abs(Math.round(v)))}`;
const signed = (v) => `${v > 0 ? '+' : ''}${money(v)}`;
const compact = (v) => {
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e7) return `${s}₹${+(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${s}₹${+(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `${s}₹${+(a / 1e3).toFixed(0)}k`;
  return `${s}₹${a.toFixed(0)}`;
};
const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const tone = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const dayLabel = (d) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const dayLong = (d) => new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const timeLabel = (at) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(at));
const istDate = (ms) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);

function niceTicks(min, max, count = 5) {
  if (min === max) (min -= 1), (max += 1);
  const raw = (max - min) / count;
  let step = 10 ** Math.floor(Math.log10(raw));
  const err = raw / step;
  step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
  const out = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) out.push(Math.round(v / step) * step);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Bar path with a 4px rounded data end and a square end on the baseline. */
function barPath(x, w, y0, y1) {
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (h < 0.5) return '';
  if (y1 < y0) {
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

function Tip({ tip }) {
  if (!tip) return null;
  return (
    <div className="pc-tip" style={{ left: tip.x, top: tip.y, transform: tip.flip ? 'translate(calc(-100% - 12px), -50%)' : 'translate(12px, -50%)' }}>
      {tip.content}
    </div>
  );
}

function useTip(boxRef) {
  const [tip, setTip] = useState(null);
  const show = (e, content) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = e.clientX - box.left;
    setTip({ x, y: e.clientY - box.top, flip: x > box.width * 0.6, content });
  };
  return [tip, show, () => setTip(null)];
}

function Swatch({ type, dashed }) {
  return <i className={`pc-sw${dashed ? ' dash' : ''}`} style={{ '--c': COLOR[type] }} />;
}

// ------------------------------------------------------------------ stats

function statsFor(fills) {
  let gross = 0, brokerage = 0, net = 0, wins = 0, losses = 0, winSum = 0, lossSum = 0, cum = 0, peak = 0, maxDD = 0;
  let best = null, worst = null;
  for (const t of fills) {
    gross += t.realized || 0;
    brokerage += t.charges || 0;
    net += t.net || 0;
    cum += t.net || 0;
    peak = Math.max(peak, cum);
    maxDD = Math.min(maxDD, cum - peak);
    if (t.closedQty > 0) {
      const r = t.roundTripNet ?? t.net;
      if (r > 0) (wins += 1), (winSum += r);
      else (losses += 1), (lossSum += r);
      if (!best || r > best.r) best = { r, t };
      if (!worst || r < worst.r) worst = { r, t };
    }
  }
  const closed = wins + losses;
  return {
    fills: fills.length, gross, brokerage, net, wins, losses, closed,
    winRate: closed ? wins / closed : null,
    avgWin: wins ? winSum / wins : null,
    avgLoss: losses ? lossSum / losses : null,
    profitFactor: lossSum ? winSum / -lossSum : wins ? Infinity : null,
    maxDD, best, worst,
  };
}

// ------------------------------------------------------------------ main

export default function PaperCharts({ trades = [] }) {
  const [range, setRange] = useState('all');
  const [on, setOn] = useState(() => new Set(TRADE_TYPES));

  const all = useMemo(() => [...trades].filter((t) => TRADE_TYPES.includes(t.product)).sort((a, b) => String(a.at).localeCompare(String(b.at))), [trades]);
  const fills = useMemo(() => {
    const days = RANGES.find((r) => r[0] === range)?.[2];
    if (!days) return all;
    const from = istDate(Date.now() - (days - 1) * 86_400_000);
    return all.filter((t) => t.date >= from);
  }, [all, range]);

  const types = TRADE_TYPES.filter((k) => on.has(k));
  const shown = fills.filter((t) => on.has(t.product));
  const stats = useMemo(() => {
    const o = { ALL: statsFor(shown) };
    for (const k of TRADE_TYPES) o[k] = statsFor(fills.filter((t) => t.product === k));
    return o;
  }, [fills, on]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k) =>
    setOn((s) => {
      const n = new Set(s);
      if (n.has(k)) n.size > 1 && n.delete(k);
      else n.add(k);
      return n;
    });

  if (!all.length) {
    return (
      <section className="card pad">
        <h2>Charts</h2>
        <p className="muted">No paper trades yet. Once you place and close a few trades, their P&amp;L charts appear here.</p>
      </section>
    );
  }

  const S = stats.ALL;

  return (
    <div className="pc-root">
      <div className="pc-filters">
        <div className="seg" role="group" aria-label="Date range">
          {RANGES.map(([id, label]) => (
            <button key={id} className={range === id ? 'on' : ''} onClick={() => setRange(id)}>{label}</button>
          ))}
        </div>
        <div className="pc-types" role="group" aria-label="Trade types">
          {TRADE_TYPES.map((k) => (
            <button key={k} className={`pc-chip${on.has(k) ? ' on' : ''}`} onClick={() => toggle(k)} aria-pressed={on.has(k)}>
              <Swatch type={k} /> {PRODUCT_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      <section className="card pad pc-hero">
        <div>
          <div className="pc-hero-label">Net P&amp;L after brokerage</div>
          <div className={`pc-hero-num ${tone(S.net)}`}>{signed(S.net)}</div>
          <div className="pc-hero-sub">
            Gross {signed(S.gross)} · brokerage {money(S.brokerage)} · {S.closed} closed trade{S.closed === 1 ? '' : 's'}
          </div>
        </div>
        <div className="pc-kpis">
          <Kpi label="Win rate" value={pct(S.winRate)} note={`${S.wins} won · ${S.losses} lost`} />
          <Kpi label="Profit factor" value={S.profitFactor === null ? '—' : S.profitFactor === Infinity ? '∞' : S.profitFactor.toFixed(2)} note="Won ÷ lost" />
          <Kpi label="Avg win / loss" value={`${S.avgWin === null ? '—' : compact(S.avgWin)} / ${S.avgLoss === null ? '—' : compact(S.avgLoss)}`} note="Per closed trade" />
          <Kpi label="Max drawdown" value={S.maxDD ? money(S.maxDD) : '₹0'} note="Worst fall from a peak" tone={S.maxDD < 0 ? 'neg' : ''} />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Cumulative net P&amp;L</h2>
          <Legend types={types} withAll={types.length > 1} />
        </div>
        <CumulativeChart fills={shown} types={types} />
        <div className="foot">Each step is a fill; the line moves when a trade closes (gross P&amp;L) and dips slightly on every entry (brokerage). Hover or tap for values.</div>
      </section>

      <div className="pc-grid">
        <section className="card">
          <div className="card-head">
            <h2>Daily net P&amp;L</h2>
            <Legend types={types} />
          </div>
          <DailyChart fills={shown} types={types} />
        </section>

        <section className="card">
          <div className="card-head"><h2>Wins and losses</h2></div>
          <WinLoss stats={stats} types={types} />
        </section>

        <section className="card">
          <div className="card-head"><h2>Where the money went</h2></div>
          <MoneyFlow stats={stats} types={types} />
          <div className="foot">Gross is the price move; brokerage is charged on every buy and sell. Net = gross − brokerage.</div>
        </section>

        <section className="card">
          <div className="card-head"><h2>By instrument</h2></div>
          <ByInstrument fills={shown} />
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Summary by trade type</h2></div>
        <SummaryTable stats={stats} types={types} />
      </section>
    </div>
  );
}

function Kpi({ label, value, note, tone: t = '' }) {
  return (
    <div className="pc-kpi">
      <span>{label}</span>
      <b className={t}>{value}</b>
      <small>{note}</small>
    </div>
  );
}

function Legend({ types, withAll }) {
  return (
    <div className="pc-legend">
      {withAll && (
        <span><Swatch type="ALL" dashed /> All</span>
      )}
      {types.map((k) => (
        <span key={k}><Swatch type={k} /> {SHORT[k]}</span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ cumulative line

function CumulativeChart({ fills, types }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const withAll = types.length > 1;
  const H = 280;
  const narrow = width < 560;
  const M = { top: 14, right: narrow ? 12 : 104, bottom: 28, left: 56 };
  const iw = width - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const { series, n, dayTicks } = useMemo(() => {
    const keys = withAll ? [...types, 'ALL'] : types;
    const run = Object.fromEntries(keys.map((k) => [k, 0]));
    const vals = Object.fromEntries(keys.map((k) => [k, [0]]));
    const ticks = [];
    let lastDay = '';
    fills.forEach((t, i) => {
      if (t.date !== lastDay) ticks.push({ i, label: dayLabel(t.date) }), (lastDay = t.date);
      run[t.product] += t.net || 0;
      if (withAll) run.ALL += t.net || 0;
      for (const k of keys) vals[k].push(run[k]);
    });
    return { series: keys.map((k) => ({ k, values: vals[k] })), n: fills.length, dayTicks: ticks };
  }, [fills, types, withAll]);

  const flat = series.flatMap((s) => s.values);
  const yt = niceTicks(Math.min(0, ...flat), Math.max(0, ...flat), 5);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const X = (i) => M.left + (n ? (i / n) * iw : 0);
  const Y = (v) => M.top + ih - ((v - y0) / (y1 - y0)) * ih;

  // Thin the day ticks so labels don't collide.
  const minGap = 46;
  const ticks = [];
  for (const t of dayTicks) if (!ticks.length || X(t.i) - X(ticks[ticks.length - 1].i) >= minGap) ticks.push(t);

  // Direct labels at the right end, nudged apart.
  const labels = narrow
    ? []
    : series
        .map((s) => ({ k: s.k, v: s.values[s.values.length - 1], y: Y(s.values[s.values.length - 1]) }))
        .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 26) labels[i].y = labels[i - 1].y + 26;

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.max(0, Math.min(n, Math.round(((px - M.left) / iw) * n)));
    setHover({ i, px: X(i), flip: X(i) > width * 0.6 });
  };

  const fill = hover && hover.i > 0 ? fills[hover.i - 1] : null;

  return (
    <div className="pc-plot" ref={ref}>
      <svg width={width} height={H} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Cumulative net P&L by trade type">
        {yt.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + iw} y1={Y(v)} y2={Y(v)} className={v === 0 ? 'pc-zero' : 'pc-grid-line'} />
            <text x={M.left - 8} y={Y(v)} className="pc-axis" textAnchor="end" dominantBaseline="middle">{compact(v)}</text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t.i} x={X(t.i)} y={H - 8} className="pc-axis" textAnchor="start">{t.label}</text>
        ))}
        {series.map((s) => (
          <path
            key={s.k}
            d={s.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')}
            fill="none"
            stroke={COLOR[s.k]}
            strokeWidth={s.k === 'ALL' ? 1.5 : 2}
            strokeDasharray={s.k === 'ALL' ? '5 4' : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {labels.map((l) => (
          <g key={l.k}>
            <text x={M.left + iw + 8} y={l.y - 6} className="pc-dlabel">{SHORT[l.k]}</text>
            <text x={M.left + iw + 8} y={l.y + 8} className="pc-dvalue">{signed(l.v)}</text>
          </g>
        ))}
        {hover && (
          <g>
            <line x1={hover.px} x2={hover.px} y1={M.top} y2={M.top + ih} className="pc-cross" />
            {series.map((s) => (
              <circle key={s.k} cx={hover.px} cy={Y(s.values[hover.i])} r={4.5} fill={COLOR[s.k]} stroke="var(--surface)" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {hover && (
        <div className="pc-tip" style={{ left: hover.px, top: M.top + 8, transform: hover.flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}>
          <div className="pc-tip-h">{fill ? `${timeLabel(fill.at)} · ${fill.side} ${describe(fill)}` : 'Start'}</div>
          {fill && fill.closedQty > 0 && (
            <div className="pc-tip-r"><span>This trade</span><b className={tone(fill.roundTripNet ?? fill.net)}>{signed(fill.roundTripNet ?? fill.net)}</b></div>
          )}
          {[...series].reverse().map((s) => (
            <div key={s.k} className="pc-tip-r">
              <span><Swatch type={s.k} dashed={s.k === 'ALL'} /> {SHORT[s.k]}</span>
              <b>{signed(s.values[hover.i])}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ daily bars

function DailyChart({ fills, types }) {
  const [ref, width] = useWidth();
  const [tip, show, hide] = useTip(ref);
  const H = 240;
  const M = { top: 12, right: 8, bottom: 28, left: 52 };
  const iw = width - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const days = useMemo(() => {
    const map = new Map();
    for (const t of fills) {
      let d = map.get(t.date);
      if (!d) map.set(t.date, (d = { date: t.date, total: 0, ...Object.fromEntries(TRADE_TYPES.map((k) => [k, 0])) }));
      d[t.product] += t.net || 0;
      d.total += t.net || 0;
    }
    return [...map.values()].slice(-30);
  }, [fills]);

  if (!days.length) return <p className="muted pad-x">No trades in this range.</p>;

  const vals = days.flatMap((d) => types.map((k) => d[k]));
  const yt = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const Y = (v) => M.top + ih - ((v - y0) / (y1 - y0)) * ih;
  const band = iw / days.length;
  const groupW = Math.min(band * 0.78, 22 * types.length + 2 * (types.length - 1));
  const barW = (groupW - 2 * (types.length - 1)) / types.length;
  const every = Math.ceil(52 / band);

  return (
    <div className="pc-plot" ref={ref}>
      <svg width={width} height={H} role="img" aria-label="Daily net P&L by trade type" onPointerLeave={hide}>
        {yt.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + iw} y1={Y(v)} y2={Y(v)} className={v === 0 ? 'pc-zero' : 'pc-grid-line'} />
            <text x={M.left - 8} y={Y(v)} className="pc-axis" textAnchor="end" dominantBaseline="middle">{compact(v)}</text>
          </g>
        ))}
        {days.map((d, di) => {
          const gx = M.left + di * band + (band - groupW) / 2;
          return (
            <g key={d.date}>
              {types.map((k, ki) => (
                <path key={k} d={barPath(gx + ki * (barW + 2), barW, Y(0), Y(d[k]))} fill={COLOR[k]} />
              ))}
              {di % every === 0 && (
                <text x={M.left + di * band + band / 2} y={H - 8} className="pc-axis" textAnchor="middle">{dayLabel(d.date)}</text>
              )}
              <rect
                x={M.left + di * band}
                y={M.top}
                width={band}
                height={ih}
                fill="transparent"
                onPointerMove={(e) =>
                  show(
                    e,
                    <>
                      <div className="pc-tip-h">{dayLong(d.date)}</div>
                      {types.map((k) => (
                        <div key={k} className="pc-tip-r"><span><Swatch type={k} /> {SHORT[k]}</span><b>{signed(d[k])}</b></div>
                      ))}
                      {types.length > 1 && (
                        <div className="pc-tip-r total"><span>Total</span><b className={tone(types.reduce((s, k) => s + d[k], 0))}>{signed(types.reduce((s, k) => s + d[k], 0))}</b></div>
                      )}
                    </>
                  )
                }
              />
            </g>
          );
        })}
      </svg>
      <Tip tip={tip} />
    </div>
  );
}

// ------------------------------------------------------------------ win / loss

function WinLoss({ stats, types }) {
  const ref = useRef(null);
  const [tip, show, hide] = useTip(ref);
  return (
    <div className="pc-rows" ref={ref} onPointerLeave={hide}>
      {types.map((k) => {
        const s = stats[k];
        const total = s.closed || 1;
        return (
          <div key={k} className="pc-wl">
            <div className="pc-row-head">
              <span><Swatch type={k} /> {SHORT[k]}</span>
              <b>{pct(s.winRate)} <small>win rate</small></b>
            </div>
            <div className="pc-wl-bar">
              {s.closed === 0 && <div className="pc-wl-empty">No closed trades</div>}
              {s.wins > 0 && (
                <div className="pc-wl-win" style={{ flexGrow: s.wins / total }} onPointerMove={(e) => show(e, <WLTip s={s} type={k} />)}>
                  {s.wins} won
                </div>
              )}
              {s.losses > 0 && (
                <div className="pc-wl-loss" style={{ flexGrow: s.losses / total }} onPointerMove={(e) => show(e, <WLTip s={s} type={k} />)}>
                  {s.losses} lost
                </div>
              )}
            </div>
            <div className="pc-row-foot">
              Avg win <b className="pos">{s.avgWin === null ? '—' : signed(s.avgWin)}</b> · avg loss <b className="neg">{s.avgLoss === null ? '—' : signed(s.avgLoss)}</b>
            </div>
          </div>
        );
      })}
      <Tip tip={tip} />
    </div>
  );
}

function WLTip({ s, type }) {
  return (
    <>
      <div className="pc-tip-h">{PRODUCT_LABEL[type]}</div>
      <div className="pc-tip-r"><span>Won</span><b>{s.wins}</b></div>
      <div className="pc-tip-r"><span>Lost</span><b>{s.losses}</b></div>
      {s.best && <div className="pc-tip-r"><span>Best · {describe(s.best.t)}</span><b className={tone(s.best.r)}>{signed(s.best.r)}</b></div>}
      {s.worst && <div className="pc-tip-r"><span>Worst · {describe(s.worst.t)}</span><b className={tone(s.worst.r)}>{signed(s.worst.r)}</b></div>}
    </>
  );
}

// ------------------------------------------------------------------ diverging bars

function Diverging({ rows, onHover }) {
  const vals = rows.map((r) => r.v);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const zero = ((0 - lo) / span) * 100;
  return rows.map((r) => (
    <div key={r.key} className="pc-div" onPointerMove={onHover ? (e) => onHover(e, r) : undefined}>
      <span className="pc-div-label">{r.swatch && <Swatch type={r.swatch} />}{r.label}</span>
      <span className="pc-div-track">
        <i className="pc-div-zero" style={{ left: `${zero}%` }} />
        <i
          className={`pc-div-bar ${r.cls || (r.v >= 0 ? 'up' : 'down')}`}
          style={{ left: `${r.v >= 0 ? zero : zero - (Math.abs(r.v) / span) * 100}%`, width: `${Math.max(0.5, (Math.abs(r.v) / span) * 100)}%` }}
        />
      </span>
      <b className={`pc-div-val ${r.cls === 'cost' ? 'neg' : tone(r.v)}`}>{signed(r.v)}</b>
    </div>
  ));
}

function MoneyFlow({ stats, types }) {
  return (
    <div className="pc-rows">
      {types.map((k) => {
        const s = stats[k];
        return (
          <div key={k} className="pc-flow">
            <div className="pc-row-head"><span><Swatch type={k} /> {SHORT[k]}</span><small>{s.fills} fills</small></div>
            <Diverging
              rows={[
                { key: 'g', label: 'Gross', v: s.gross },
                { key: 'b', label: 'Brokerage', v: -s.brokerage, cls: 'cost' },
                { key: 'n', label: 'Net', v: s.net },
              ]}
            />
            {s.gross > 0 && <div className="pc-row-foot">Brokerage took {pct(s.brokerage / s.gross)} of the gross profit.</div>}
          </div>
        );
      })}
    </div>
  );
}

function ByInstrument({ fills }) {
  const ref = useRef(null);
  const [tip, show, hide] = useTip(ref);
  const rows = useMemo(() => {
    const map = new Map();
    for (const t of fills) {
      const name = describe(t);
      const key = `${t.product}|${name}`;
      let r = map.get(key);
      if (!r) map.set(key, (r = { key, label: name, swatch: t.product, v: 0, gross: 0, brokerage: 0, closed: 0, wins: 0 }));
      r.v += t.net || 0;
      r.gross += t.realized || 0;
      r.brokerage += t.charges || 0;
      if (t.closedQty > 0) (r.closed += 1), (r.wins += (t.roundTripNet ?? t.net) > 0 ? 1 : 0);
    }
    return [...map.values()].sort((a, b) => b.v - a.v);
  }, [fills]);
  if (!rows.length) return <p className="muted pad-x">No trades in this range.</p>;
  const top = rows.length > 12 ? [...rows.slice(0, 6), ...rows.slice(-6)] : rows;
  return (
    <div className="pc-rows" ref={ref} onPointerLeave={hide}>
      <Diverging
        rows={top}
        onHover={(e, r) =>
          show(
            e,
            <>
              <div className="pc-tip-h">{r.label} · {PRODUCT_LABEL[r.swatch]}</div>
              <div className="pc-tip-r"><span>Gross</span><b>{signed(r.gross)}</b></div>
              <div className="pc-tip-r"><span>Brokerage</span><b>{money(-r.brokerage)}</b></div>
              <div className="pc-tip-r total"><span>Net</span><b className={tone(r.v)}>{signed(r.v)}</b></div>
              <div className="pc-tip-r"><span>Closed trades</span><b>{r.closed} ({r.wins} won)</b></div>
            </>
          )
        }
      />
      {rows.length > 12 && <div className="pc-row-foot">Showing the 6 best and 6 worst of {rows.length} instruments.</div>}
      <Tip tip={tip} />
    </div>
  );
}

// ------------------------------------------------------------------ table

function SummaryTable({ stats, types }) {
  const cols = types.length > 1 ? [...types, 'ALL'] : types;
  const rows = [
    ['Net P&L', (s) => <b className={tone(s.net)}>{signed(s.net)}</b>],
    ['Gross P&L', (s) => signed(s.gross)],
    ['Brokerage', (s) => money(s.brokerage)],
    ['Fills', (s) => s.fills],
    ['Closed trades', (s) => s.closed],
    ['Win rate', (s) => pct(s.winRate)],
    ['Avg win', (s) => (s.avgWin === null ? '—' : signed(s.avgWin))],
    ['Avg loss', (s) => (s.avgLoss === null ? '—' : signed(s.avgLoss))],
    ['Profit factor', (s) => (s.profitFactor === null ? '—' : s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2))],
    ['Best trade', (s) => (s.best ? <span className={tone(s.best.r)}>{signed(s.best.r)} <small>{describe(s.best.t)}</small></span> : '—')],
    ['Worst trade', (s) => (s.worst ? <span className={tone(s.worst.r)}>{signed(s.worst.r)} <small>{describe(s.worst.t)}</small></span> : '—')],
    ['Max drawdown', (s) => (s.maxDD ? money(s.maxDD) : '₹0')],
  ];
  return (
    <div className="table-wrap">
      <table className="pc-table">
        <thead>
          <tr>
            <th />
            {cols.map((k) => (
              <th key={k}><Swatch type={k} dashed={k === 'ALL'} /> {SHORT[k]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}>
              <th>{label}</th>
              {cols.map((k) => <td key={k}>{f(stats[k])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
