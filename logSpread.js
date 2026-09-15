// Splits a total amount into weekly chunks across a date range, for cases
// where dumping a whole quantity onto one date would distort short-term
// usage-rate statistics (a shortage found during a physical count, or an
// existing consumption log being corrected after the fact because the
// original date was wrong and nobody actually knows the exact day).
//
// One entry per ~7-day bucket starting at `fromDate`; the last bucket
// absorbs any rounding remainder so the entries always sum to exactly
// `totalAmount`.
export function buildSpreadEntries(totalAmount, fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const totalDays = Math.max(1, Math.round((to - from) / 86400000) + 1);
  const weeks = Math.max(1, Math.ceil(totalDays / 7));

  const dates = [];
  for (let i = 0; i < weeks; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i * 7);
    if (d > to) break;
    dates.push(d.toISOString().slice(0, 10));
  }
  if (dates.length === 0) dates.push(fromDate);

  const count = dates.length;
  const base = Math.floor((totalAmount / count) * 100) / 100;
  const amounts = new Array(count).fill(base);
  const remainder = Math.round((totalAmount - base * count) * 100) / 100;
  amounts[count - 1] = Math.round((amounts[count - 1] + remainder) * 100) / 100;

  return dates.map((date, i) => ({ date, amount: amounts[i] }));
}
