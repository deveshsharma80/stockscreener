// Dhan's real charges for one executed order (paper trading uses these so its numbers match
// live trading). Shared by the server (lib/paper.js, lib/journal.js) and the pages.
//
// Equity intraday: brokerage 0.03 % or ₹20, whichever is lower · STT 0.025 % on the sell ·
//   exchange NSE 0.00297 % / BSE 0.00375 % · SEBI ₹10 per crore · stamp duty 0.003 % on the
//   buy · GST 18 % on brokerage + exchange + SEBI.
// Options (on the premium): brokerage ₹20 flat · STT 0.15 % on the sell (from 1 Apr 2026) ·
//   exchange NSE 0.03503 % / BSE 0.0325 % · SEBI · stamp 0.003 % on the buy · GST 18 %.
// Rates as of Nov 2026 — change them here if Dhan or the government changes them.

export const RATES = {
  equity: { brokeragePct: 0.03, brokerageMax: 20, sttSellPct: 0.025, exchangePct: { NSE: 0.00297, BSE: 0.00375 }, stampBuyPct: 0.003 },
  options: { brokerageFlat: 20, sttSellPct: 0.15, exchangePct: { NSE: 0.03503, BSE: 0.0325 }, stampBuyPct: 0.003 },
  sebiPct: 0.0001,
  gstPct: 18,
};

const r2 = (v) => Math.round(v * 100) / 100;
const isOption = (product, segment) => product === 'IDX_OPT_BUY' || product === 'STK_OPT_BUY' || /FNO$/.test(String(segment || ''));

/**
 * Charges for one order. value = qty × price (₹). Returns the total, and the parts when
 * `detail` is true.
 */
export function dhanCharges({ side, value, segment = '', product = '' }, detail = false) {
  const v = Math.abs(Number(value) || 0);
  if (!v) return detail ? { total: 0 } : 0;
  const ex = String(segment).startsWith('BSE') ? 'BSE' : 'NSE';
  const sell = String(side).toUpperCase() === 'SELL';
  const R = isOption(product, segment) ? RATES.options : RATES.equity;
  const brokerage = R.brokerageFlat != null ? R.brokerageFlat : Math.min(R.brokerageMax, (v * R.brokeragePct) / 100);
  const stt = sell ? (v * R.sttSellPct) / 100 : 0;
  const exchange = (v * R.exchangePct[ex]) / 100;
  const sebi = (v * RATES.sebiPct) / 100;
  const stamp = sell ? 0 : (v * R.stampBuyPct) / 100;
  const gst = ((brokerage + exchange + sebi) * RATES.gstPct) / 100;
  const total = r2(brokerage + stt + exchange + sebi + stamp + gst);
  return detail ? { total, brokerage: r2(brokerage), stt: r2(stt), exchange: r2(exchange), sebi: r2(sebi), stamp: r2(stamp), gst: r2(gst) } : total;
}

export const CHARGES_TEXT =
  'Dhan’s real charges: Equity Intraday 0.03% or ₹20 brokerage + 0.025% STT on the sell; options ₹20 per order + 0.15% STT on the sell; plus exchange fees, SEBI, stamp duty and GST.';
