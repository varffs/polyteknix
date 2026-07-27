# LED Fault Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The button LED stops being permanently on and instead pulses only when a fault is active and unacknowledged, and never during the night.

**Architecture:** A pure module (`src/faults.js`) derives an ordered fault key from state. The reducer owns "is there an unseen fault" — it records an acknowledgement when the user cycles into the DIAG screen, and resets that record whenever the device returns to healthy. A listener (`src/led.js`) owns the blink timer and asks a pure `isQuietPeriod()` whether it is allowed to light up. A third listener mirrors `led.isLit` to the GPIO pin. No render loop, no free-running interval: the blink loop exists only while a fault is unacknowledged.

**Tech Stack:** Node.js ESM, `@reduxjs/toolkit` v2 (`configureStore`, `createListenerMiddleware`), `suncalc`, `node --test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-07-27-led-fault-signal-design.md`

## Global Constraints

- Working dir: `~/Sites/worldofpi/polyteknix`, branch `led-fault-signal`.
- ESM (`"type": "module"`). Test runner is `npm test` → `node --test 'src/**/*.test.js'`.
- Tests run on the **laptop only**. The device is Node 16.14 and `node --test` needs 16.17+. Never try to run the suite on the Pi.
- Action naming follows REDUX-SPEC `slice/property`.
- The reducer must stay pure. No `Date.now()`, no config, no hardware calls inside it — timestamps arrive as action payloads, timers and GPIO live in listener middleware.
- Site constants are exactly `lat 50.7744`, `lon -2.4753`.
- Blink timing is exactly 750 ms on / 2250 ms off; quiet-period recheck 60000 ms; quiet margin 30 min (`1800000` ms).
- Fault keys are exactly `int`, `psh`, `clk`, `ext`, always emitted in that order.
- Push failure threshold is exactly 3 consecutive failures.
- `"unknown"` sensor status is **not** a fault — it is the pre-first-poll boot value.
- No `piteknix` changes. `createLed()` already exposes `write(value)`, `on()`, `off()`, `cleanup()`.
- Do **not** hardcode expected sunrise/sunset clock times in tests. Assert on properties and on margins computed from SunCalc within the test — see Task 4.

---

### Task 1: State additions

**Files:**
- Modify: `src/store.js`
- Test: `src/store.test.js`

**Interfaces:**
- Consumes: existing `initialState`, `appReducer`, `SANITY_EPOCH` in `src/store.js`.
- Produces: `initialState.sensors.internal_status` (`"unknown"`), `initialState.sensors.push_failures` (`0`), `initialState.led` (`{ seenFaultKey: null, isLit: false, clockWasInsane: false }`). Action creators `setInternalStatus(status)` → `{ type: "sensors/internal/status", payload }`, `pushResult(ok)` → `{ type: "push/result", payload }`, `ledLit(lit)` → `{ type: "led/lit", payload }`. Tasks 2, 3, 5, 6, 7 and 9 rely on these exact names.

`push/result` is deliberately **not** namespaced under `sensors/` — the render listener's predicate in `app.js` matches `sensors/`, and a push counter change must not trigger an LCD redraw.

- [ ] **Step 1: Write the failing tests**

Append to `src/store.test.js`, and add the new names to the existing import line at the top of the file so it reads:

```js
import { appReducer, initialState, setInternalTemp, setExternalStatus, buttonPress, sleep, recordSample, setInternalStatus, pushResult, ledLit, HISTORY_MAX_SAMPLES, HISTORY_WINDOW_MS, SANITY_EPOCH } from "./store.js";
```

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `setInternalStatus is not a function` (or similar import error) plus assertion failures on the new fields.

- [ ] **Step 3: Implement the state additions**

In `src/store.js`, extend `initialState`:

```js
export const initialState = {
  data: {
    temperature_internal: null,
    temperature_external: null,
    humidity_internal: null,
    pressure: null,
  },
  display: { mode: "DEFAULT", isBacklit: false },
  sensors: {
    external_status: "unknown",
    external_diagnostic: null,
    internal_status: "unknown",
    push_failures: 0,
  },
  history: { samples: [] },
  led: { seenFaultKey: null, isLit: false, clockWasInsane: false },
};
```

Add the action creators next to the existing ones:

```js
export const setInternalStatus = (status) => ({ type: "sensors/internal/status", payload: status });
/** Not namespaced under sensors/ — that prefix triggers an LCD redraw in app.js. */
export const pushResult = (ok) => ({ type: "push/result", payload: ok });
export const ledLit = (lit) => ({ type: "led/lit", payload: lit });
```

Add the reducer cases:

```js
    case "sensors/internal/status":
      return { ...state, sensors: { ...state.sensors, internal_status: action.payload } };
    case "push/result":
      return {
        ...state,
        sensors: {
          ...state.sensors,
          push_failures: action.payload ? 0 : state.sensors.push_failures + 1,
        },
      };
    case "led/lit":
      if (state.led.isLit === action.payload) return state;
      return { ...state, led: { ...state.led, isLit: action.payload } };
```

Replace the early return in the `history/record` case so a bad clock is recorded rather than discarded silently:

```js
    case "history/record": {
      const ts = action.payload;
      if (!Number.isFinite(ts) || ts < SANITY_EPOCH) {
        // The sample is still rejected — but the fact that the clock was wrong
        // is news, and it is the only evidence left once NTP corrects it.
        return state.led.clockWasInsane
          ? state
          : { ...state, led: { ...state.led, clockWasInsane: true } };
      }
```

(The rest of the `history/record` case is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests including the pre-existing suite.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/store.test.js
git commit -m "feat: add internal status, push failure count and led state"
```

---

### Task 2: Fault derivation

**Files:**
- Create: `src/faults.js`
- Test: `src/faults.test.js`

**Interfaces:**
- Consumes: state shape from Task 1 (`state.sensors.internal_status`, `state.sensors.push_failures`, `state.sensors.external_status`, `state.led.clockWasInsane`, `state.led.seenFaultKey`).
- Produces: `FAULT_ORDER` (`["int", "psh", "clk", "ext"]`), `PUSH_FAILURE_THRESHOLD` (`3`), `selectFaults(state)` → ordered array of active keys, `selectFaultKey(state)` → those keys joined with `"|"` (`""` when healthy), `selectArmed(state)` → boolean. Tasks 3, 5 and 7 import from here.

This module imports nothing. That is deliberate: `store.js` needs `selectFaultKey` for acknowledgement and `led.js` needs `ledLit` from `store.js`, so putting the selectors in `store.js` or `led.js` would create an import cycle.

- [ ] **Step 1: Write the failing tests**

Create `src/faults.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "./store.js";
import { selectFaults, selectFaultKey, selectArmed, PUSH_FAILURE_THRESHOLD } from "./faults.js";

const withState = (overrides) => ({
  ...initialState,
  sensors: { ...initialState.sensors, ...(overrides.sensors || {}) },
  led: { ...initialState.led, ...(overrides.led || {}) },
});

test("a fresh device is healthy — unknown statuses are not faults", () => {
  assert.deepEqual(selectFaults(initialState), []);
  assert.equal(selectFaultKey(initialState), "");
  assert.equal(selectArmed(initialState), false);
});

test("an ok external sensor is not a fault", () => {
  assert.deepEqual(selectFaults(withState({ sensors: { external_status: "ok" } })), []);
});

test("each fault is detected on its own", () => {
  assert.deepEqual(selectFaults(withState({ sensors: { internal_status: "error" } })), ["int"]);
  assert.deepEqual(selectFaults(withState({ sensors: { push_failures: PUSH_FAILURE_THRESHOLD } })), ["psh"]);
  assert.deepEqual(selectFaults(withState({ led: { clockWasInsane: true } })), ["clk"]);
  assert.deepEqual(selectFaults(withState({ sensors: { external_status: "absent" } })), ["ext"]);
});

test("the push threshold is exclusive below 3", () => {
  assert.deepEqual(selectFaults(withState({ sensors: { push_failures: 2 } })), []);
});

test("multiple faults come out in fixed order regardless of how they arose", () => {
  const state = withState({
    sensors: { external_status: "absent", internal_status: "error", push_failures: 5 },
    led: { clockWasInsane: true },
  });
  assert.deepEqual(selectFaults(state), ["int", "psh", "clk", "ext"]);
  assert.equal(selectFaultKey(state), "int|psh|clk|ext");
});

test("armed only when the live key differs from the acknowledged one", () => {
  const faulty = withState({ sensors: { external_status: "absent" } });
  assert.equal(selectArmed(faulty), true);

  const acknowledged = withState({
    sensors: { external_status: "absent" },
    led: { seenFaultKey: "ext" },
  });
  assert.equal(selectArmed(acknowledged), false);

  const worsened = withState({
    sensors: { external_status: "absent", internal_status: "error" },
    led: { seenFaultKey: "ext" },
  });
  assert.equal(selectArmed(worsened), true, "a new fault on top of an acknowledged one must re-arm");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './faults.js'`.

- [ ] **Step 3: Implement the module**

Create `src/faults.js`:

```js
/**
 * Pure fault derivation. Imports nothing — store.js needs selectFaultKey for
 * acknowledgement and led.js needs action creators from store.js, so these
 * selectors have to live outside both to avoid an import cycle.
 */

/** Fixed order makes the key a stable identity for a fault *set*, so "same
 *  problems as before" and "something new" are distinguishable by string
 *  comparison alone. */
export const FAULT_ORDER = ["int", "psh", "clk", "ext"];

/** 3 failures at a 5-minute push interval = 15 minutes of sustained failure,
 *  so one flaky POST or a router reboot cannot arm the LED. */
export const PUSH_FAILURE_THRESHOLD = 3;

export const selectFaults = (state) => {
  const { sensors, led } = state;
  const active = new Set();
  if (sensors.internal_status === "error") active.add("int");
  if (sensors.push_failures >= PUSH_FAILURE_THRESHOLD) active.add("psh");
  if (led.clockWasInsane) active.add("clk");
  // "unknown" is the pre-first-poll boot value, not a fault.
  if (sensors.external_status !== "ok" && sensors.external_status !== "unknown") active.add("ext");
  return FAULT_ORDER.filter((key) => active.has(key));
};

export const selectFaultKey = (state) => selectFaults(state).join("|");

export const selectArmed = (state) => {
  const key = selectFaultKey(state);
  return key !== "" && key !== state.led.seenFaultKey;
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/faults.js src/faults.test.js
git commit -m "feat: derive an ordered fault key from state"
```

---

### Task 3: Acknowledgement

**Files:**
- Modify: `src/store.js`
- Test: `src/store.test.js`

**Interfaces:**
- Consumes: `selectFaultKey` from `src/faults.js` (Task 2).
- Produces: reducer behaviour only — entering `DIAG` stores the current fault key in `led.seenFaultKey` and clears `led.clockWasInsane`; any state with no active faults resets `led.seenFaultKey` to `null`. No new exports.

Two rules with sharp edges, both tested below:

1. **Clear the sticky clock flag before capturing the key.** If the key were captured first, `seenFaultKey` would contain `clk` while the live key no longer did, the two would never match, and the LED would re-arm the instant it was acknowledged.
2. **Reset on healthy via a post-pass, not per-case.** A fault can clear through several different actions. Normalising once, after the switch, means no path can be missed: fault → acknowledged → cleared → returns must re-arm, and it only does so if the stale acknowledgement was dropped when the device went healthy.

- [ ] **Step 1: Write the failing tests**

Append to `src/store.test.js`:

```js
test("cycling into DIAG acknowledges the current fault set", () => {
  let s = appReducer(initialState, setExternalStatus({ status: "absent", detail: "no bus" }));
  s = appReducer(s, buttonPress()); // dark -> wake, mode DEFAULT
  s = appReducer(s, buttonPress()); // MINMAX
  s = appReducer(s, buttonPress()); // DAYCOMP
  s = appReducer(s, buttonPress()); // DIAG
  assert.equal(s.display.mode, "DIAG");
  assert.equal(s.led.seenFaultKey, "ext");
});

test("acknowledging clears the sticky clock flag and does not leave a key that can never match", () => {
  let s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  s = appReducer(s, setExternalStatus({ status: "absent", detail: "no bus" }));
  assert.equal(s.led.clockWasInsane, true);

  s = appReducer(s, buttonPress());
  s = appReducer(s, buttonPress());
  s = appReducer(s, buttonPress());
  s = appReducer(s, buttonPress()); // DIAG
  assert.equal(s.led.clockWasInsane, false);
  assert.equal(s.led.seenFaultKey, "ext", "the key must be captured AFTER the clock flag is cleared");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `seenFaultKey` stays `null` after reaching DIAG.

- [ ] **Step 3: Implement acknowledgement**

In `src/store.js`, add the import at the top:

```js
import { selectFaultKey } from "./faults.js";
```

Replace the `display/buttonPress` case with:

```js
    case "display/buttonPress": {
      if (!state.display.isBacklit) {
        return { ...state, display: { ...state.display, isBacklit: true } };
      }
      const mode = getNextMode(state.display.mode);
      const next = { ...state, display: { ...state.display, mode } };
      if (mode !== "DIAG") return next;
      // Reaching DIAG means someone is standing at the device reading the
      // fault detail — that IS the acknowledgement. Clear the sticky clock
      // flag first, then capture the key from the post-clear state: capture it
      // first and seenFaultKey keeps a "clk" the live key no longer has, the
      // two never match, and the LED re-arms the moment it is acknowledged.
      const cleared = { ...next, led: { ...next.led, clockWasInsane: false } };
      return { ...cleared, led: { ...cleared.led, seenFaultKey: selectFaultKey(cleared) } };
    }
```

Rename the existing exported reducer function to `baseReducer` (drop its `export`) and add the wrapper plus normaliser below it:

```js
function baseReducer(state = initialState, action) {
  // ...unchanged body...
}

/** A fault can clear via several different actions. Normalising once, after
 *  the switch, means no path can forget to drop a stale acknowledgement — and
 *  without that drop, a fault that clears and returns would stay silent. */
const forgetAcknowledgementWhenHealthy = (state) =>
  state.led.seenFaultKey !== null && selectFaultKey(state) === ""
    ? { ...state, led: { ...state.led, seenFaultKey: null } }
    : state;

export function appReducer(state = initialState, action) {
  return forgetAcknowledgementWhenHealthy(baseReducer(state, action));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/store.test.js
git commit -m "feat: acknowledge faults on entering the DIAG screen"
```

---

### Task 4: Quiet period

**Files:**
- Create: `src/solar.js`
- Test: `src/solar.test.js`
- Modify: `package.json` (add `suncalc`)

**Interfaces:**
- Consumes: `DAY_MS` from `src/history.js`, `SANITY_EPOCH` from `src/store.js`, `suncalc`.
- Produces: `isQuietPeriod(ts, { lat, lon, marginMs })` → boolean. Tasks 5 and 9 call it with exactly this signature.

Testing note: do **not** assert hardcoded sunrise/sunset clock times — they are not verifiable from here and would bake in a guess. Test the logic that is actually ours: the margin arithmetic, the midnight-spanning window assembly, and the bad-clock guard. Boundary tests derive the sunset instant from SunCalc inside the test and probe either side of our 30-minute margin.

- [ ] **Step 1: Install the dependency**

Run: `npm install suncalc`

Confirm it resolved and note the pinned version:

Run: `npm ls suncalc`
Expected: a single `suncalc@<version>` line, no `UNMET DEPENDENCY`.

- [ ] **Step 2: Write the failing tests**

Create `src/solar.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import SunCalc from "suncalc";
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
  const { sunset } = SunCalc.getTimes(new Date(MIDSUMMER + 12 * 60 * 60 * 1000), SITE.lat, SITE.lon);
  const t = sunset.getTime();
  assert.equal(isQuietPeriod(t + 29 * 60 * 1000, SITE), false, "still within grace");
  assert.equal(isQuietPeriod(t + 31 * 60 * 1000, SITE), true, "grace expired");
});

test("the 30-minute head start before sunrise is honoured on both sides", () => {
  const { sunrise } = SunCalc.getTimes(new Date(MIDWINTER + 12 * 60 * 60 * 1000), SITE.lat, SITE.lon);
  const t = sunrise.getTime();
  assert.equal(isQuietPeriod(t - 31 * 60 * 1000, SITE), true, "still quiet");
  assert.equal(isQuietPeriod(t - 29 * 60 * 1000, SITE), false, "head start begun");
});

test("an unknowable clock is treated as quiet", () => {
  assert.equal(isQuietPeriod(SANITY_EPOCH - 1, SITE), true);
  assert.equal(isQuietPeriod(NaN, SITE), true);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './solar.js'`.

- [ ] **Step 4: Implement the module**

Create `src/solar.js`:

```js
import SunCalc from "suncalc";
import { DAY_MS } from "./history.js";
import { SANITY_EPOCH } from "./store.js";

/**
 * The quiet window opened by the solar day containing `dayTs`: that evening's
 * sunset plus the grace margin, through the NEXT morning's sunrise minus it.
 * Returned as epoch milliseconds, so nothing here depends on the local zone or
 * on DST.
 */
const quietWindow = (dayTs, { lat, lon, marginMs }) => {
  const { sunset } = SunCalc.getTimes(new Date(dayTs), lat, lon);
  const { sunrise } = SunCalc.getTimes(new Date(dayTs + DAY_MS), lat, lon);
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/solar.js src/solar.test.js package.json package-lock.json
git commit -m "feat: compute the night quiet period from sunset and sunrise"
```

---

### Task 5: Blink loop

**Files:**
- Create: `src/led.js`
- Test: `src/led.test.js`

**Interfaces:**
- Consumes: `selectArmed` from `src/faults.js` (Task 2), `ledLit` from `src/store.js` (Task 1).
- Produces: `registerLedBlink(listener, { onMs, offMs, quietRecheckMs, isQuiet })`. `isQuiet` is a `(ts: number) => boolean` injected by the caller so the loop is testable without a real clock or a real sun. Task 9 wires it up.

Mirrors `src/backlight.js`: the listener owns the timer, the reducer owns the semantics, a separate listener in `app.js` owns the GPIO write.

- [ ] **Step 1: Write the failing tests**

Create `src/led.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import { appReducer, setExternalStatus, buttonPress } from "./store.js";
import { registerLedBlink } from "./led.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const makeStore = ({ quiet = false } = {}) => {
  const listener = createListenerMiddleware();
  registerLedBlink(listener, {
    onMs: 20,
    offMs: 20,
    quietRecheckMs: 20,
    isQuiet: () => quiet,
  });
  const store = configureStore({
    reducer: appReducer,
    middleware: (getDefault) => getDefault().prepend(listener.middleware),
  });
  const seen = [];
  store.subscribe(() => seen.push(store.getState().led.isLit));
  return { store, seen };
};

const goFaulty = (store) => store.dispatch(setExternalStatus({ status: "absent", detail: "no bus" }));
const walkToDiag = (store) => {
  store.dispatch(buttonPress()); // wake
  store.dispatch(buttonPress()); // MINMAX
  store.dispatch(buttonPress()); // DAYCOMP
  store.dispatch(buttonPress()); // DIAG -> acknowledged
};

test("a healthy device never lights the LED", async () => {
  const { store, seen } = makeStore();
  await wait(80);
  assert.equal(seen.includes(true), false);
  assert.equal(store.getState().led.isLit, false);
});

test("an unacknowledged fault pulses on and off", async () => {
  const { store, seen } = makeStore();
  goFaulty(store);
  await wait(70);
  assert.ok(seen.includes(true), "expected at least one lit pulse");
  assert.ok(seen.includes(false), "expected the pulse to end");
  walkToDiag(store);
  await wait(70);
});

test("the quiet period suppresses the pulse entirely", async () => {
  const { store, seen } = makeStore({ quiet: true });
  goFaulty(store);
  await wait(80);
  assert.equal(seen.includes(true), false, "the LED must never light during the quiet period");
  walkToDiag(store);
  await wait(40);
});

test("acknowledging stops the loop and leaves the LED dark", async () => {
  const { store } = makeStore();
  goFaulty(store);
  await wait(50);
  walkToDiag(store);
  await wait(80);
  assert.equal(store.getState().led.isLit, false);

  const before = store.getState().led;
  await wait(60);
  assert.equal(store.getState().led, before, "no further led state churn once disarmed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './led.js'`.

- [ ] **Step 3: Implement the module**

Create `src/led.js`:

```js
import { selectArmed } from "./faults.js";
import { ledLit } from "./store.js";

/**
 * Pulses the button LED while a fault is unacknowledged.
 *
 * The loop exists only while armed — a healthy device runs no timer, dispatches
 * nothing, and churns no state. Because the quiet check happens inside the
 * loop, the night window re-evaluates itself every cycle with no separate
 * clock ticker.
 *
 * `isQuiet` is injected rather than imported so the loop is testable without a
 * real clock or a real sun.
 */
export const registerLedBlink = (listener, { onMs, offMs, quietRecheckMs, isQuiet }) => {
  listener.startListening({
    predicate: (_action, curr, prev) => selectArmed(curr) && !selectArmed(prev),
    effect: async (_action, api) => {
      // A second instance would double-pulse the same pin.
      api.cancelActiveListeners();
      while (selectArmed(api.getState())) {
        if (isQuiet(Date.now())) {
          api.dispatch(ledLit(false));
          // Idle rather than churning a 3s cycle all night. One minute of
          // granularity is immaterial against a 30-minute margin.
          await api.delay(quietRecheckMs);
          continue;
        }
        api.dispatch(ledLit(true));
        await api.delay(onMs);
        api.dispatch(ledLit(false));
        await api.delay(offMs);
      }
      // Reached on disarm. Not reached on cancellation — api.delay throws
      // there — but the instance that cancelled us owns the pin from then on.
      api.dispatch(ledLit(false));
    },
  });
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/led.js src/led.test.js
git commit -m "feat: pulse the LED while a fault is unacknowledged"
```

---

### Task 6: Internal sensor status reporting

**Files:**
- Modify: `src/sensors.js`
- Test: `src/sensors.test.js`

**Interfaces:**
- Consumes: `setInternalStatus` from `src/store.js` (Task 1).
- Produces: `pollInternal` dispatches `sensors/internal/status` with `"ok"` on a good read and `"error"` on a failed one. No signature change.

`src/push.js` needs no change: it already returns `null` when no key is configured and throws on a failed POST, which is exactly the three-way outcome Task 9 needs.

- [ ] **Step 1: Write the failing tests**

Append to `src/sensors.test.js`:

```js
test("pollInternal reports ok on a good read", async () => {
  const sensor = { read: async () => ({ temperature: 21, humidity: 55 }) };
  const actions = [];
  await pollInternal(sensor, (a) => actions.push(a));
  const status = actions.find((a) => a.type === "sensors/internal/status");
  assert.equal(status.payload, "ok");
});

test("pollInternal reports error when the read throws", async () => {
  const sensor = { read: async () => { throw new Error("i2c timeout"); } };
  const actions = [];
  await pollInternal(sensor, (a) => actions.push(a));
  const status = actions.find((a) => a.type === "sensors/internal/status");
  assert.equal(status.payload, "error");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot read properties of undefined (reading 'payload')`, because no status action is dispatched.

- [ ] **Step 3: Implement**

In `src/sensors.js`, extend the import:

```js
import { setInternalTemp, setInternalHumidity, setExternalTemp, setExternalStatus, setInternalStatus } from "./store.js";
```

and replace `pollInternal`:

```js
export const pollInternal = async (sensor, dispatch) => {
  try {
    const { temperature, humidity } = await sensor.read();
    dispatch(setInternalTemp(temperature));
    dispatch(setInternalHumidity(humidity));
    dispatch(setInternalStatus("ok"));
  } catch (e) {
    console.error("internal sensor read failed:", e.message);
    dispatch(setInternalTemp(null));
    dispatch(setInternalHumidity(null));
    dispatch(setInternalStatus("error"));
  }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sensors.js src/sensors.test.js
git commit -m "feat: report internal sensor health to state"
```

---

### Task 7: DIAG screen shows the new faults

**Files:**
- Modify: `src/render.js`
- Test: `src/render.test.js`

**Interfaces:**
- Consumes: `selectFaults` from `src/faults.js` (Task 2).
- Produces: `formatDiagLines(state)` unchanged in signature; line 1 now shows space-joined non-`ext` fault keys when any are active, and the external diagnostic otherwise.

Line 1 worst case is `"int psh clk"` — 11 characters, inside the 16-column limit.

- [ ] **Step 1: Write the failing tests**

Append to `src/render.test.js`:

```js
test("DIAG shows the diagnostic when only the external sensor is faulty", () => {
  const state = {
    ...initialState,
    sensors: { ...initialState.sensors, external_status: "absent", external_diagnostic: "not on bus" },
  };
  assert.deepEqual(formatDiagLines(state), ["ext: absent", "not on bus"]);
});

test("DIAG shows fault flags when a non-external fault is live", () => {
  const state = {
    ...initialState,
    sensors: {
      ...initialState.sensors,
      external_status: "absent",
      external_diagnostic: "not on bus",
      internal_status: "error",
      push_failures: 3,
    },
    led: { ...initialState.led, clockWasInsane: true },
  };
  const [line0, line1] = formatDiagLines(state);
  assert.equal(line0, "ext: absent");
  assert.equal(line1, "int psh clk");
  assert.ok(line1.length <= 16);
});

test("DIAG flags appear even when the external sensor is fine", () => {
  const state = {
    ...initialState,
    sensors: { ...initialState.sensors, external_status: "ok", internal_status: "error" },
  };
  assert.deepEqual(formatDiagLines(state), ["ext: ok", "int"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — line 1 is the diagnostic (or `""`) where flags are expected.

- [ ] **Step 3: Implement**

In `src/render.js`, add the import:

```js
import { selectFaults } from "./faults.js";
```

and replace `formatDiagLines`:

```js
// Non-external faults preempt the diagnostic text: 16x2 has no room for both,
// they are rarer, and they are the more urgent news. The diagnostic returns
// as soon as they clear.
export const formatDiagLines = (state) => {
  const { sensors } = state;
  const line0 = `ext: ${sensors.external_status}`;
  const others = selectFaults(state).filter((key) => key !== "ext");
  const line1 = others.length
    ? others.join(" ")
    : (sensors.external_diagnostic || "").substring(0, 16);
  return [line0, line1];
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. If a pre-existing `formatDiagLines` test fails with `Cannot read properties of undefined (reading 'clockWasInsane')`, that test builds a partial state without `led` — spread `initialState` into it rather than weakening `selectFaults`.

- [ ] **Step 5: Commit**

```bash
git add src/render.js src/render.test.js
git commit -m "feat: surface non-external faults on the DIAG screen"
```

---

### Task 8: Configuration

**Files:**
- Modify: `src/config.js`, `.env.example`
- Test: `src/config.test.js`

**Interfaces:**
- Produces: `cfg.siteLat` (`50.7744`), `cfg.siteLon` (`-2.4753`), `cfg.quietMarginMs` (`1800000`), `cfg.ledBlinkOnMs` (`750`), `cfg.ledBlinkOffMs` (`2250`), `cfg.ledQuietRecheckMs` (`60000`), `cfg.ignoreQuiet` (boolean from `LED_IGNORE_QUIET`). Task 9 reads all of these.

- [ ] **Step 1: Write the failing tests**

Append to `src/config.test.js`:

```js
test("loadConfig carries the site and LED constants", () => {
  const cfg = loadConfig({ VIRTUAL_MODE: "true" });
  assert.equal(cfg.siteLat, 50.7744);
  assert.equal(cfg.siteLon, -2.4753);
  assert.equal(cfg.quietMarginMs, 30 * 60 * 1000);
  assert.equal(cfg.ledBlinkOnMs, 750);
  assert.equal(cfg.ledBlinkOffMs, 2250);
  assert.equal(cfg.ledQuietRecheckMs, 60000);
});

test("the quiet period is honoured unless explicitly overridden", () => {
  assert.equal(loadConfig({ VIRTUAL_MODE: "true" }).ignoreQuiet, false);
  assert.equal(loadConfig({ VIRTUAL_MODE: "true", LED_IGNORE_QUIET: "true" }).ignoreQuiet, true);
  assert.equal(loadConfig({ VIRTUAL_MODE: "true", LED_IGNORE_QUIET: "1" }).ignoreQuiet, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `cfg.siteLat` is `undefined`.

- [ ] **Step 3: Implement**

In `src/config.js`, add to the returned object:

```js
    // Polytunnel location, for the sunset/sunrise calculation. Not a secret.
    siteLat: 50.7744,
    siteLon: -2.4753,
    quietMarginMs: 30 * 60 * 1000,
    ledBlinkOnMs: 750,
    ledBlinkOffMs: 2250,
    ledQuietRecheckMs: 60000,
    // Dev only: without this, evening work on the laptop shows a permanently
    // dark virtual LED and reads as a broken feature.
    ignoreQuiet: env.LED_IGNORE_QUIET === "true",
```

Append to `.env.example`:

```
# Dev only — bypass the night quiet period so the LED can be seen blinking
LED_IGNORE_QUIET=false
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js src/config.test.js .env.example
git commit -m "feat: add site coordinates and LED timing config"
```

---

### Task 9: Wire it into the app

**Files:**
- Modify: `app.js`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: running behaviour. No exports; `app.js` is not in the test import graph, so this task is verified by running the app, not by the suite.

- [ ] **Step 1: Replace the boot LED call**

In `app.js`, change:

```js
await led.on();
```

to:

```js
// Force a known dark state: SIGINT cleanup writes 0, but a crash or a pm2
// restart mid-run can leave the pin high.
await led.off();
```

- [ ] **Step 2: Add the imports**

```js
import { appReducer, buttonPress, recordSample, pushResult } from "./src/store.js";
import { registerLedBlink } from "./src/led.js";
import { isQuietPeriod } from "./src/solar.js";
```

(The first line replaces the existing `./src/store.js` import — keep any other names it already brings in.)

- [ ] **Step 3: Register the two LED listeners**

Immediately after the existing backlight hardware-sync listener, and before `registerBacklightTimeout(...)`:

```js
// LED hardware sync — fires only when isLit actually changes
listener.startListening({
  predicate: (_action, curr, prev) => curr.led.isLit !== prev.led.isLit,
  effect: (_action, api) => led.write(api.getState().led.isLit),
});

registerLedBlink(listener, {
  onMs: cfg.ledBlinkOnMs,
  offMs: cfg.ledBlinkOffMs,
  quietRecheckMs: cfg.ledQuietRecheckMs,
  isQuiet: (ts) =>
    !cfg.ignoreQuiet &&
    isQuietPeriod(ts, { lat: cfg.siteLat, lon: cfg.siteLon, marginMs: cfg.quietMarginMs }),
});
```

- [ ] **Step 4: Report push outcomes**

Replace the body of the push interval callback with:

```js
const push = setInterval(async () => {
  if (pushing) return;
  pushing = true;
  try {
    const res = await pushData(axios, { feedId: cfg.feedId, key: cfg.iotplotterKey }, store.getState());
    // null means no key configured (virtual mode) — neither success nor
    // failure, and counting it would arm the LED on every virtual run.
    if (res !== null) store.dispatch(pushResult(true));
  } catch (e) {
    console.error("push failed:", e.message);
    store.dispatch(pushResult(false));
  } finally {
    pushing = false;
  }
}, cfg.pollMs);
```

- [ ] **Step 5: Verify the healthy path in virtual mode**

Run: `LED_IGNORE_QUIET=true npm run dev`
Expected: startup logs, no `[LED GPIO 17]` lines at all — a healthy virtual device never pulses. Press `1` four times: the display cycles to DIAG and still no LED output. Ctrl-C to stop.

- [ ] **Step 6: Verify the fault path in virtual mode (temporary edit)**

Temporarily change the external sensor construction in `app.js` to force a fault:

```js
const external = await createSensor({ type: "ds18b20", id: cfg.externalSensorId, virtual: { fault: "absent" } });
```

Run: `LED_IGNORE_QUIET=true npm run dev`
Expected: after the first poll, `[LED GPIO 17] 🔴 ON` / `⚫ OFF` alternating on a 3-second cycle. Press `1` four times to reach DIAG; the pulsing stops and does not resume.

Then run it again **without** the override:

Run: `npm run dev`
Expected: if you are running this after dark, no `[LED GPIO 17]` lines despite the fault. If in daylight, pulsing as above. Either way it confirms the quiet gate is wired to real time.

Now revert the temporary edit:

Run: `git checkout -- app.js` **only if you have not yet committed Steps 1–4** — otherwise remove the `virtual: { fault: "absent" }` argument by hand and confirm with `git diff` that nothing else changed.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add app.js
git commit -m "feat: wire the LED fault signal into the app"
```

---

### Task 10: Release notes

**Files:**
- Modify: `CHANGELOG.md`, `package.json`

**Interfaces:**
- Produces: version `2.1.0` and a changelog entry. Nothing consumes these.

Minor bump: new feature, no breaking change to any interface the device depends on.

- [ ] **Step 1: Bump the version**

In `package.json`, change `"version": "2.0.0"` to `"version": "2.1.0"`.

- [ ] **Step 2: Add the changelog entry**

Add at the top of the entries in `CHANGELOG.md`, matching the existing format in that file:

```markdown
## 2.1.0

### Added
- Button LED now signals an unacknowledged fault instead of being permanently on. It pulses (750 ms on / 2250 ms off) when the external probe, the internal AHT20, the iotplotter push or the boot clock is faulty, and goes dark once the fault has been seen on the DIAG screen.
- Night suppression: the LED is silent between sunset + 30 min and sunrise − 30 min, computed locally from the site coordinates via `suncalc`. No network call.
- Internal sensor health and push failures are now tracked in state; the DIAG screen shows `int` / `psh` / `clk` flags when those faults are live.
- `LED_IGNORE_QUIET=true` bypasses night suppression for development.

### Changed
- The LED is no longer switched on at boot.
```

- [ ] **Step 3: Run the suite one last time**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "chore: release 2.1.0"
```

---

## Deploy (after merge, not part of the task sequence)

1. On the device: `git checkout -- package-lock.json` before pulling — the device's npm 8 rewrites it.
2. `git pull && npm install` — `suncalc` 2.0.1 is a single pure-JS file with no runtime
   dependencies, no native bindings and no postinstall, so armv6 is not a risk. It is ESM
   with named exports only (no default export) — the import form is
   `import { getTimes } from "suncalc"`. The device cannot run the suite, so a load-time
   import error would only surface here: watch the first `pm2 logs polyteknix` after restart.
3. `pm2 restart polyteknix` — and confirm `NODE_ENV=production` survived, since it lives only in pm2's saved dump. If the dump was rebuilt: `NODE_ENV=production pm2 restart polyteknix --update-env && pm2 save`.
4. Sanity check: the LED should be dark on a device whose only fault is the known-dead external probe **after** you cycle to DIAG once. Before that first acknowledgement it will pulse — expected, that is the restart re-arm.
