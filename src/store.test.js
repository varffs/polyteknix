import { test } from "node:test";
import assert from "node:assert/strict";
import { appReducer, initialState, setInternalTemp, setExternalStatus, buttonPress, sleep, recordSample, setInternalStatus, pushResult, ledLit, HISTORY_MAX_SAMPLES, HISTORY_WINDOW_MS, SANITY_EPOCH } from "./store.js";
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
  assert.deepEqual(s, { ...initialState, led: { ...initialState.led, clockWasInsane: true } });
});

test("history/record ignores a non-finite timestamp", () => {
  const s = appReducer(initialState, recordSample(NaN));
  assert.deepEqual(s, { ...initialState, led: { ...initialState.led, clockWasInsane: true } });
});

test("history/record prunes samples older than the retention window", () => {
  const now = new Date(2026, 6, 26, 12, 0, 0).getTime();
  const stale = { ts: now - (HISTORY_WINDOW_MS + 60 * 60 * 1000), temperature_internal: 1 };
  const fresh = { ts: now - (HISTORY_WINDOW_MS - 60 * 60 * 1000), temperature_internal: 2 };
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

test("initial state carries the new sensor and led fields", () => {
  assert.equal(initialState.sensors.internal_status, "unknown");
  assert.equal(initialState.sensors.push_failures, 0);
  assert.deepEqual(initialState.led, { seenFaultKey: null, isLit: false, clockWasInsane: false });
});

test("reducer records internal sensor status", () => {
  const s = appReducer(initialState, setInternalStatus("error"));
  assert.equal(s.sensors.internal_status, "error");
});

test("push failures accumulate and a success resets them", () => {
  let s = appReducer(initialState, pushResult(false));
  s = appReducer(s, pushResult(false));
  assert.equal(s.sensors.push_failures, 2);
  s = appReducer(s, pushResult(true));
  assert.equal(s.sensors.push_failures, 0);
});

test("led/lit sets isLit and returns the same object when unchanged", () => {
  const lit = appReducer(initialState, ledLit(true));
  assert.equal(lit.led.isLit, true);
  assert.equal(appReducer(lit, ledLit(true)), lit, "no-op dispatch must not produce a new state object");
});

test("an insane timestamp raises the sticky clock flag instead of being silently dropped", () => {
  const s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  assert.equal(s.led.clockWasInsane, true);
  assert.equal(s.history.samples.length, 0, "the bad sample must still be rejected");
});

test("a sane timestamp leaves the clock flag alone", () => {
  const s = appReducer(initialState, recordSample(SANITY_EPOCH + 1000));
  assert.equal(s.led.clockWasInsane, false);
  assert.equal(s.history.samples.length, 1);
});
