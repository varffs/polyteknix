import { getTimes } from "suncalc";
import { DAY_MS } from "./history.js";
import { SANITY_EPOCH } from "./store.js";

/**
 * The quiet window opened by the solar day containing `dayTs`: that evening's
 * sunset plus the grace margin, through the NEXT morning's sunrise minus it.
 * Returned as epoch milliseconds, so nothing here depends on the local zone or
 * on DST.
 */
const quietWindow = (dayTs, { lat, lon, marginMs }) => {
  const { sunset } = getTimes(new Date(dayTs), lat, lon);
  const { sunrise } = getTimes(new Date(dayTs + DAY_MS), lat, lon);
  return [sunset.getTime() + marginMs, sunrise.getTime() - marginMs];
};

/**
 * True when the LED must stay dark. Two candidate windows are enough: a
 * timestamp is either inside the window its own day opened (evening) or inside
 * the one the day before opened (small hours). Nothing later can contain it.
 *
 * An unusable timestamp returns true — an unknowable time never lights the LED.
 */
export const isQuietPeriod = (ts, site) => {
  if (!Number.isFinite(ts) || ts < SANITY_EPOCH) return true;
  return [ts - DAY_MS, ts].some((dayTs) => {
    const [start, end] = quietWindow(dayTs, site);
    return ts >= start && ts < end;
  });
};
