/**
 * Helpers for summarising a device's SQLite history. Domain modules use them
 * to build the history context their prompt and rules see.
 */

// Timestamps are stored as ISO strings (toISOString), so window bounds must be
// in the same format for text comparison to be correct.
export const since = modifier => `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${modifier}')`;

// Rows written before input validation may hold text in numeric columns
// (SQLite MAX() ranks TEXT above any number). Never let them into the summary.
export const isNum = col => `typeof(${col}) IN ('integer', 'real')`;

export const round1 = v => (v == null ? null : Math.round(v * 10) / 10);

/** Numbers only, so nothing but digits from memory is interpolated into a prompt. */
export const fmt = v => (typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a');

/** Mean difference with a ~95% significance check (Welch-style standard error). */
export function shift(cur, prev, minDelta) {
  if (!cur?.n || !prev?.n || cur.n < 3 || prev.n < 3) return null;
  const varOf = s => Math.max(0, s.sq - s.avg * s.avg);
  const delta = cur.avg - prev.avg;
  const se = Math.sqrt(varOf(cur) / cur.n + varOf(prev) / prev.n);
  const significant = Math.abs(delta) >= minDelta && Math.abs(delta) > 2 * se;
  return { current_avg: round1(cur.avg), previous_avg: round1(prev.avg), delta: round1(delta), significant };
}

/** avg, mean of squares, count, min and max of a numeric column over a time window. */
export const windowStats = one => (col, from, to) => one(
  `SELECT AVG(${col}) AS avg, AVG(${col} * ${col}) AS sq, COUNT(*) AS n, MIN(${col}) AS min, MAX(${col}) AS max
     FROM telemetry WHERE ${isNum(col)} AND timestamp > ${since(from)}${to ? ` AND timestamp <= ${since(to)}` : ''}`
);
