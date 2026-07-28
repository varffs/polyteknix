import { test } from "node:test";
import assert from "node:assert/strict";
import { appReducer, initialState, setInternalTemp, setExternalStatus, buttonPress, sleep, recordSample, setInternalStatus, pushResult, ledLit, HISTORY_MAX_SAMPLES, HISTORY_WINDOW_MS, SANITY_EPOCH } from "./store.js";
import { formatMinMaxLines } from "./render.js";
import { selectArmed, selectFaults, selectFaultKey, PUSH_FAILURE_THRESHOLD } from "./faults.js";

/** dark -> wake (DEFAULT), then MINMAX, DAYCOMP, DIAG. */
const pressToDiag = (state) => {
  let s = state;
  for (let i = 0; i < 4; i += 1) s = appReducer(s, buttonPress());
  return s;
};

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

test("cycling into DIAG acknowledges the current fault set", () => {
  let s = appReducer(initialState, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = appReducer(s, buttonPress()); // dark -> wake, mode DEFAULT
  s = appReducer(s, buttonPress()); // MINMAX
  s = appReducer(s, buttonPress()); // DAYCOMP
  s = appReducer(s, buttonPress()); // DIAG
  assert.equal(s.display.mode, "DIAG");
  assert.equal(s.led.seenFaultKey, "ext");
});

test("entering DIAG acknowledges the clock fault but leaves the flag raised to be read", () => {
  let s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  s = appReducer(s, setExternalStatus({ status: "absent", detail: "no bus" }));
  assert.equal(s.led.clockWasInsane, true);

  s = pressToDiag(s);
  assert.equal(s.led.clockWasInsane, true, "the flag must survive to reach the screen that shows it");
  assert.equal(s.led.seenFaultKey, "clk|ext");
  assert.equal(selectArmed(s), false, "having looked must disarm");
});

test("leaving DIAG clears the sticky clock flag without re-arming", () => {
  let s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  s = appReducer(s, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = pressToDiag(s);
  assert.equal(s.led.clockWasInsane, true);

  s = appReducer(s, buttonPress()); // DIAG -> DEFAULT, the flag has been read
  assert.equal(s.led.clockWasInsane, false);
  assert.equal(
    s.led.seenFaultKey,
    "ext",
    "clk is no longer live, so the acknowledgement narrows to what is",
  );
  assert.equal(selectArmed(s), false, "live {ext} is contained by the acknowledged set");
});

test("the backlight timing out on DIAG also clears the sticky clock flag", () => {
  let s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  s = appReducer(s, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = pressToDiag(s);
  assert.equal(s.led.clockWasInsane, true);

  s = appReducer(s, sleep());
  assert.equal(s.led.clockWasInsane, false);
  assert.equal(selectArmed(s), false);
});

test("sleeping from a mode other than DIAG leaves the clock flag raised", () => {
  let s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  s = appReducer(s, buttonPress()); // wake
  s = appReducer(s, buttonPress()); // MINMAX
  s = appReducer(s, sleep());
  assert.equal(s.led.clockWasInsane, true, "a screen that never showed clk cannot acknowledge it");
  assert.equal(selectArmed(s), true);
});

test("a clock fault on its own is shown, cleared on exit, and then silent", () => {
  let s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  assert.equal(selectArmed(s), true);

  s = pressToDiag(s);
  assert.deepEqual(selectFaults(s), ["clk"], "the fault must be live on the DIAG screen");
  assert.equal(selectArmed(s), false);

  s = appReducer(s, buttonPress()); // leave DIAG
  assert.equal(s.led.clockWasInsane, false);
  assert.equal(selectFaultKey(s), "");
  assert.equal(s.led.seenFaultKey, null, "the healthy-state reset must drop the acknowledgement");
  assert.equal(selectArmed(s), false, "nothing left to nag about");
});

test("a new fault appearing while the user is on DIAG re-arms", () => {
  let s = appReducer(initialState, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = pressToDiag(s);
  assert.equal(selectArmed(s), false);

  s = appReducer(s, setInternalStatus("error"));
  assert.equal(selectArmed(s), true, "int was not in the acknowledged set");
});

test("passing through a non-DIAG mode does not acknowledge", () => {
  let s = appReducer(initialState, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = appReducer(s, buttonPress()); // wake
  s = appReducer(s, buttonPress()); // MINMAX
  assert.equal(s.led.seenFaultKey, null);
});

test("going healthy drops the acknowledgement so a recurrence re-arms", () => {
  let s = appReducer(initialState, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = appReducer(s, buttonPress());
  s = appReducer(s, buttonPress());
  s = appReducer(s, buttonPress());
  s = appReducer(s, buttonPress()); // DIAG -> acknowledged
  assert.equal(s.led.seenFaultKey, "ext");

  s = appReducer(s, setExternalStatus({ status: "ok", detail: "reading 12c" }));
  assert.equal(s.led.seenFaultKey, null, "healthy state must drop the stale acknowledgement");

  s = appReducer(s, setExternalStatus({ status: "absent", detail: "no bus" }));
  assert.equal(s.led.seenFaultKey, null, "the same fault returning must count as new");
});

const failPushToThreshold = (state) => {
  let s = state;
  for (let i = 0; i < PUSH_FAILURE_THRESHOLD; i += 1) s = appReducer(s, pushResult(false));
  return s;
};

test("a fault clearing narrows the acknowledgement while another fault stays live", () => {
  let s = appReducer(initialState, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = appReducer(s, setInternalStatus("error"));
  s = pressToDiag(s);
  assert.equal(s.led.seenFaultKey, "int|ext");

  s = appReducer(s, setInternalStatus("ok"));
  assert.equal(s.led.seenFaultKey, "ext", "an acknowledgement covers only faults still live");
  assert.equal(selectArmed(s), false, "the surviving fault is still acknowledged");
});

// ext is permanently live on this device until the probe is replaced, so the
// fault key never reaches "" and the whole-key reset can never fire. Without
// the intersection the acknowledged set only ever grew, and a genuine second
// 15-minute push outage went unsignalled for the rest of the process.
test("a fault that clears and returns re-arms even though another fault never clears", () => {
  let s = appReducer(initialState, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = pressToDiag(s); // ack {ext}
  s = appReducer(s, sleep());

  s = failPushToThreshold(s);
  assert.equal(selectArmed(s), true, "the first push outage arms");
  s = pressToDiag(s); // ack {psh, ext}
  assert.equal(s.led.seenFaultKey, "psh|ext");
  s = appReducer(s, sleep());

  s = appReducer(s, pushResult(true)); // push recovers
  assert.equal(selectArmed(s), false, "a fault clearing is not news");
  assert.equal(s.led.seenFaultKey, "ext");

  s = failPushToThreshold(s);
  assert.equal(selectFaultKey(s), "psh|ext");
  assert.equal(selectArmed(s), true, "a second outage is a new fault, not a pre-acknowledged one");
});

test("entering DIAG on a healthy device acknowledges nothing rather than an empty key", () => {
  const s = pressToDiag(initialState);
  assert.equal(s.display.mode, "DIAG");
  assert.equal(s.led.seenFaultKey, null, '"" must never become observable in state');
});
