import { test } from "node:test";
import assert from "node:assert/strict";
import { appReducer, initialState, setInternalTemp, setExternalStatus, buttonPress, sleep, recordSample, HISTORY_MAX_SAMPLES, SANITY_EPOCH } from "./store.js";
import { formatMinMaxLines } from "./render.js";

test("reducer sets internal temperature", () => {
  const s = appReducer(initialState, setInternalTemp(21.4));
  assert.equal(s.data.temperature_internal, 21.4);
});

test("reducer records external sensor status + diagnostic", () => {
  const s = appReducer(initialState, setExternalStatus({ status: "absent", detail: "no devices on bus" }));
  assert.equal(s.sensors.external_status, "absent");
  assert.equal(s.sensors.external_diagnostic, "no devices on bus");
});

test("unknown action returns state unchanged", () => {
  assert.equal(appReducer(initialState, { type: "nope" }), initialState);
});

test("buttonPress when dark wakes backlight without cycling mode", () => {
  const s = appReducer(initialState, buttonPress());
  assert.equal(s.display.isBacklit, true);
  assert.equal(s.display.mode, "DEFAULT");
});

test("buttonPress when lit cycles through all four modes and back", () => {
  const lit = appReducer(initialState, buttonPress());
  const s1 = appReducer(lit, buttonPress());
  assert.equal(s1.display.mode, "MINMAX");
  assert.equal(s1.display.isBacklit, true);
  const s2 = appReducer(s1, buttonPress());
  assert.equal(s2.display.mode, "DAYCOMP");
  const s3 = appReducer(s2, buttonPress());
  assert.equal(s3.display.mode, "DIAG");
  const s4 = appReducer(s3, buttonPress());
  assert.equal(s4.display.mode, "DEFAULT");
});

test("sleep turns backlight off and resets mode to DEFAULT", () => {
  const lit = appReducer(initialState, buttonPress());
  const onDiag = appReducer(lit, buttonPress());
  const s = appReducer(onDiag, sleep());
  assert.equal(s.display.isBacklit, false);
  assert.equal(s.display.mode, "DEFAULT");
});

test("sleep when already dark is a no-op shape-wise", () => {
  const s = appReducer(initialState, sleep());
  assert.equal(s.display.isBacklit, false);
  assert.equal(s.display.mode, "DEFAULT");
});

const stateWithSamples = (samples, data = initialState.data) => ({
  ...initialState,
  data,
  history: { samples },
});

test("history/record appends a snapshot of current data stamped with the timestamp", () => {
  const now = new Date(2026, 6, 26, 12, 0, 0).getTime();
  const withData = appReducer(initialState, setInternalTemp(21.4));
  const s = appReducer(withData, recordSample(now));
  assert.equal(s.history.samples.length, 1);
  assert.equal(s.history.samples[0].ts, now);
  assert.equal(s.history.samples[0].temperature_internal, 21.4);
  assert.equal(s.history.samples[0].temperature_external, null);
});

test("history/record ignores timestamps below the sanity epoch", () => {
  const s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  assert.equal(s, initialState);
});

test("history/record ignores a non-finite timestamp", () => {
  assert.equal(appReducer(initialState, recordSample(NaN)), initialState);
});

test("history/record prunes samples older than 48h", () => {
  const now = new Date(2026, 6, 26, 12, 0, 0).getTime();
  const stale = { ts: now - 49 * 60 * 60 * 1000, temperature_internal: 1 };
  const fresh = { ts: now - 1 * 60 * 60 * 1000, temperature_internal: 2 };
  const s = appReducer(stateWithSamples([stale, fresh]), recordSample(now));
  assert.deepEqual(
    s.history.samples.map((x) => x.ts),
    [fresh.ts, now],
  );
});

test("history/record caps the ring by dropping the oldest samples", () => {
  const now = new Date(2026, 6, 26, 12, 0, 0).getTime();
  const samples = [];
  for (let i = 0; i < HISTORY_MAX_SAMPLES; i += 1) {
    samples.push({ ts: now - (HISTORY_MAX_SAMPLES - i) * 1000, temperature_internal: i });
  }
  const s = appReducer(stateWithSamples(samples), recordSample(now));
  assert.equal(s.history.samples.length, HISTORY_MAX_SAMPLES);
  assert.equal(s.history.samples[0].ts, samples[1].ts);
  assert.equal(s.history.samples[HISTORY_MAX_SAMPLES - 1].ts, now);
});

test("history/record leaves the other slices untouched", () => {
  const now = new Date(2026, 6, 26, 12, 0, 0).getTime();
  const s = appReducer(initialState, recordSample(now));
  assert.equal(s.display, initialState.display);
  assert.equal(s.sensors, initialState.sensors);
  assert.equal(s.data, initialState.data);
});

test("a poll cycle's dispatch sequence produces a renderable MINMAX screen", () => {
  const t1 = new Date(2026, 6, 26, 3, 0, 0).getTime();
  const t2 = new Date(2026, 6, 26, 11, 0, 0).getTime();
  const now = new Date(2026, 6, 26, 12, 0, 0).getTime();

  let s = initialState;
  s = appReducer(s, setInternalTemp(-3.2));
  s = appReducer(s, recordSample(t1));
  s = appReducer(s, setInternalTemp(31.4));
  s = appReducer(s, recordSample(t2));

  // whole degrees: -3.2 -> "-3", 31.4 -> "31" (see Task 3's precision note)
  assert.deepEqual(formatMinMaxLines(s, now), ["i24 L-3 H31", "e24 L-- H--"]);
});
