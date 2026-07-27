export const DAY_MS = 24 * 60 * 60 * 1000;

/** Samples with ts in (now - windowMs, now]. Boundary-exclusive at the old end. */
export const selectWindow = (samples, windowMs, now) =>
  samples.filter((s) => s.ts > now - windowMs && s.ts <= now);

/**
 * Min and max of one field across the given samples, skipping missing readings.
 * Returns null (not {min: null, max: null}) when nothing usable is present, so
 * callers have a single condition to check.
 */
export const selectMinMax = (samples, field) => {
  const values = [];
  for (const s of samples) {
    const v = s[field];
    if (typeof v === "number" && Number.isFinite(v)) values.push(v);
  }
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
};

/**
 * Local midnight, offset whole days back from now. The date is shifted before
 * the time is zeroed so a DST transition can't leave us on 23:00 or 01:00.
 */
const startOfLocalDay = (now, offset) => {
  const d = new Date(now);
  d.setDate(d.getDate() - offset);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** offset 0 = today, 1 = yesterday. Local calendar days, not UTC. */
export const selectDayMinMax = (samples, field, offset, now) => {
  const start = startOfLocalDay(now, offset);
  const end = startOfLocalDay(now, offset - 1);
  return selectMinMax(
    samples.filter((s) => s.ts >= start && s.ts < end),
    field,
  );
};
