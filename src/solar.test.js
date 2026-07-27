import { test } from "node:test";
import assert from "node:assert/strict";
import { getTimes } from "suncalc";
import { isQuietPeriod } from "./solar.js";
import { SANITY_EPOCH } from "./store.js";

const SITE = { lat: 50.7744, lon: -2.4753, marginMs: 30 * 60 * 1000 };
const MIDSUMMER = Date.UTC(2026, 5, 21);
const MIDWINTER = Date.UTC(2026, 11, 21);

test("midday is never quiet, in either season", () => {
  assert.equal(isQuietPeriod(MIDSUMMER + 12 * 60 * 60 * 1000, SITE), false);
  assert.equal(isQuietPeriod(MIDWINTER + 12 * 60 * 60 * 1000, SITE), false);
});

test("the small hours are quiet, in either season", () => {
  assert.equal(isQuietPeriod(MIDSUMMER + 2 * 60 * 60 * 1000, SITE), true);
  assert.equal(isQuietPeriod(MIDWINTER + 2 * 60 * 60 * 1000, SITE), true);
});

test("just after midnight uses the PREVIOUS day's sunset", () => {
  // 00:30 UTC — the governing window opened the evening before. A naive
  // same-day implementation reports "not quiet" here.
  assert.equal(isQuietPeriod(MIDWINTER + 30 * 60 * 1000, SITE), true);
});

test("the 30-minute grace after sunset is honoured on both sides", () => {
  const { sunset } = getTimes(new Date(MIDSUMMER + 12 * 60 * 60 * 1000), SITE.lat, SITE.lon);
  const t = sunset.getTime();
  assert.equal(isQuietPeriod(t + 29 * 60 * 1000, SITE), false, "still within grace");
  assert.equal(isQuietPeriod(t + 31 * 60 * 1000, SITE), true, "grace expired");
});

test("the 30-minute head start before sunrise is honoured on both sides", () => {
  const { sunrise } = getTimes(new Date(MIDWINTER + 12 * 60 * 60 * 1000), SITE.lat, SITE.lon);
  const t = sunrise.getTime();
  assert.equal(isQuietPeriod(t - 31 * 60 * 1000, SITE), true, "still quiet");
  assert.equal(isQuietPeriod(t - 29 * 60 * 1000, SITE), false, "head start begun");
});

test("an unknowable clock is treated as quiet", () => {
  assert.equal(isQuietPeriod(SANITY_EPOCH - 1, SITE), true);
  assert.equal(isQuietPeriod(NaN, SITE), true);
});
