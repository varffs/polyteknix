# History + MINMAX/DAYCOMP Display Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the polytunnel LCD two history screens — rolling 24h min/max temperature, and today-vs-yesterday min/max — fed by an in-memory ring of sensor snapshots.

**Architecture:** A `history.samples` array is added to the existing plain-object Redux state. A new `history/record` action, dispatched from `pollAll` after both sensor polls settle, appends a snapshot of `state.data` stamped with a caller-supplied timestamp, then prunes to 48 hours. All display values are derived by pure selectors over that array at render time — there are no running aggregates, no buckets, and nothing is written to disk.

**Tech Stack:** Node 16.14 (ESM), Redux Toolkit `configureStore` with a hand-written plain reducer, `node:test` + `node:assert/strict`, `piteknix` (pinned github dep) for `formatFloat`.

## Global Constraints

- **Node 16.14 on the device.** No `structuredClone` (Node 17+), no `Array.prototype.findLast` / `findLastIndex` (Node 18+). `Array.prototype.at` and `Object.hasOwn` are available but avoided here for clarity.
- **No new dependencies.** Not for storage, not for date handling. No `date-fns`, no `dayjs`.
- **No filesystem access.** No persistence of any kind — this is a deliberate spec decision, not an oversight.
- **Every line produced by a NEW formatter must be ≤ 16 characters** at worst realistic values (min `-19.9`, max `49.9`). Note the *existing* `formatDataLines` already emits `ext: -- (unknown)` at 17 chars; that is pre-existing and out of scope — do not "fix" it and do not apply the width assertion to the old formatters.
- **Time is always injected, never read inside a pure function.** Selectors and formatters take `now` as a parameter; only `app.js` and `renderDisplay`'s default argument call `Date.now()`.
- **Calendar days are local**, not UTC. The device answers "how cold was last night".
- Reducer stays a plain `switch` returning new objects — match the existing style in `src/store.js`, do not introduce `createSlice`.
- Run tests with `npm test` (`node --test 'src/**/*.test.js'`).

## File Structure

| File | Responsibility |
|---|---|
| `src/store.js` (modify) | Add `history` slice to `initialState`, the `recordSample` action creator, the `history/record` reducer case, ring constants, and the extended `displayModes` list. |
| `src/store.test.js` (modify) | Reducer tests for recording/pruning/capping/sanity-epoch. Update the existing mode-cycling test for the new 4-mode order. |
| `src/history.js` (create) | Pure selectors over the sample ring. No React, no store import, no clock. |
| `src/history.test.js` (create) | Selector tests, including local-midnight boundaries. |
| `src/render.js` (modify) | Two new formatters plus a shared min/max line helper; register them in `MODE_FORMATTERS`; thread `now` through `renderDisplay`. |
| `src/render.test.js` (modify) | Formatter tests including the 16-character width assertion. |
| `app.js` (modify) | Dispatch `recordSample` after both polls settle; add `history/` to the render listener predicate. |

---

### Task 1: History slice — record, prune, cap, clock sanity

**Files:**
- Modify: `src/store.js`
- Test: `src/store.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `initialState.history` → `{ samples: [] }`
  - `recordSample(ts: number)` → `{ type: "history/record", payload: number }`
  - `SANITY_EPOCH: number`, `HISTORY_WINDOW_MS: number`, `HISTORY_MAX_SAMPLES: number` — all exported from `src/store.js`
  - A sample is `{ ts: number, temperature_internal, temperature_external, humidity_internal, pressure }` — i.e. `{ ts, ...state.data }`

- [ ] **Step 1: Write the failing tests**

Append to `src/store.test.js`. Also add `recordSample`, `HISTORY_MAX_SAMPLES` and `SANITY_EPOCH` to the existing import from `./store.js` at the top of the file.

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `recordSample is not a function` / `SANITY_EPOCH is not defined` at import time.

- [ ] **Step 3: Write the implementation**

In `src/store.js`, add the constants and action creator near the existing ones:

```js
/** Samples timestamped before this are from a pre-NTP boot clock, not real history. */
export const SANITY_EPOCH = Date.UTC(2024, 0, 1);
/** 48h, not 24h: DAYCOMP's "yesterday" needs data from up to two days back just after midnight. */
export const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Backstop against a clock anomaly inflating the ring. */
export const HISTORY_MAX_SAMPLES = 1000;

export const recordSample = (ts) => ({ type: "history/record", payload: ts });
```

Add the slice to `initialState`:

```js
  history: { samples: [] },
```

Add the reducer case:

```js
    case "history/record": {
      const ts = action.payload;
      if (!Number.isFinite(ts) || ts < SANITY_EPOCH) return state;
      const appended = state.history.samples.concat({ ts, ...state.data });
      const pruned = appended.filter((s) => s.ts > ts - HISTORY_WINDOW_MS);
      const capped =
        pruned.length > HISTORY_MAX_SAMPLES
          ? pruned.slice(pruned.length - HISTORY_MAX_SAMPLES)
          : pruned;
      return { ...state, history: { samples: capped } };
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all previous tests still green plus 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/store.test.js
git commit -m "feat: record sensor snapshots into a pruned 48h in-memory ring"
```

---

### Task 2: History selectors

**Files:**
- Create: `src/history.js`
- Test: `src/history.test.js`

**Interfaces:**
- Consumes: the sample shape from Task 1 (`{ ts, temperature_internal, temperature_external, humidity_internal, pressure }`).
- Produces:
  - `selectWindow(samples, windowMs, now)` → `Array<sample>`
  - `selectMinMax(samples, field)` → `{ min: number, max: number } | null`
  - `selectDayMinMax(samples, field, offset, now)` → `{ min, max } | null` (`offset` 0 = today, 1 = yesterday)
  - `DAY_MS: number`

- [ ] **Step 1: Write the failing tests**

Create `src/history.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectWindow, selectMinMax, selectDayMinMax, DAY_MS } from "./history.js";

const at = (y, m, d, h) => new Date(y, m, d, h, 0, 0).getTime();
const NOW = at(2026, 6, 26, 12); // Sun 26 Jul 2026, 12:00 local

test("selectWindow keeps only samples inside the window", () => {
  const samples = [
    { ts: at(2026, 6, 25, 6) }, // 30h ago
    { ts: at(2026, 6, 25, 18) }, // 18h ago
    { ts: at(2026, 6, 26, 11) }, // 1h ago
  ];
  const got = selectWindow(samples, DAY_MS, NOW);
  assert.deepEqual(
    got.map((s) => s.ts),
    [at(2026, 6, 25, 18), at(2026, 6, 26, 11)],
  );
});

test("selectWindow excludes a sample exactly on the window boundary", () => {
  const samples = [{ ts: NOW - DAY_MS }, { ts: NOW - DAY_MS + 1 }];
  const got = selectWindow(samples, DAY_MS, NOW);
  assert.deepEqual(
    got.map((s) => s.ts),
    [NOW - DAY_MS + 1],
  );
});

test("selectWindow excludes samples from the future", () => {
  const got = selectWindow([{ ts: NOW + 1000 }], DAY_MS, NOW);
  assert.deepEqual(got, []);
});

test("selectMinMax returns null for an empty list", () => {
  assert.equal(selectMinMax([], "temperature_internal"), null);
});

test("selectMinMax returns null when the field is null in every sample", () => {
  const samples = [{ ts: 1, temperature_external: null }, { ts: 2, temperature_external: null }];
  assert.equal(selectMinMax(samples, "temperature_external"), null);
});

test("selectMinMax skips null values but uses the rest", () => {
  const samples = [
    { ts: 1, temperature_internal: null },
    { ts: 2, temperature_internal: -3.2 },
    { ts: 3, temperature_internal: 31.4 },
  ];
  assert.deepEqual(selectMinMax(samples, "temperature_internal"), { min: -3.2, max: 31.4 });
});

test("selectMinMax on a single sample gives equal min and max", () => {
  assert.deepEqual(selectMinMax([{ ts: 1, temperature_internal: 20 }], "temperature_internal"), {
    min: 20,
    max: 20,
  });
});

test("selectDayMinMax separates today from yesterday across local midnight", () => {
  const samples = [
    { ts: at(2026, 6, 25, 4), temperature_internal: -1.9 },
    { ts: at(2026, 6, 25, 15), temperature_internal: 28.8 },
    { ts: at(2026, 6, 26, 3), temperature_internal: -3.2 },
    { ts: at(2026, 6, 26, 11), temperature_internal: 31.4 },
  ];
  assert.deepEqual(selectDayMinMax(samples, "temperature_internal", 0, NOW), {
    min: -3.2,
    max: 31.4,
  });
  assert.deepEqual(selectDayMinMax(samples, "temperature_internal", 1, NOW), {
    min: -1.9,
    max: 28.8,
  });
});

test("selectDayMinMax returns null when the requested day has no samples", () => {
  const samples = [{ ts: at(2026, 6, 26, 11), temperature_internal: 31.4 }];
  assert.equal(selectDayMinMax(samples, "temperature_internal", 1, NOW), null);
});

test("selectDayMinMax counts a sample at one second past midnight as today", () => {
  const justAfterMidnight = new Date(2026, 6, 26, 0, 0, 1).getTime();
  const samples = [{ ts: justAfterMidnight, temperature_internal: 9.9 }];
  assert.deepEqual(selectDayMinMax(samples, "temperature_internal", 0, NOW), { min: 9.9, max: 9.9 });
  assert.equal(selectDayMinMax(samples, "temperature_internal", 1, NOW), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './history.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/history.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 10 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/history.js src/history.test.js
git commit -m "feat: add pure window and min/max selectors over the sample ring"
```

---

### Task 3: MINMAX and DAYCOMP formatters + mode registration

**Files:**
- Modify: `src/render.js`
- Modify: `src/store.js` (the `displayModes` array only)
- Test: `src/render.test.js`, `src/store.test.js` (update one existing test)

**Interfaces:**
- Consumes: `selectWindow`, `selectMinMax`, `selectDayMinMax`, `DAY_MS` from Task 2; `initialState` from Task 1.
- Produces:
  - `formatMinMaxLines(state, now)` → `[string, string]`
  - `formatDayCompLines(state, now)` → `[string, string]`
  - `renderDisplay(state, display, now)` — third parameter added, defaults to `Date.now()`
  - `displayModes` → `["DEFAULT", "MINMAX", "DAYCOMP", "DIAG"]`

**Note:** adding two modes breaks the existing `store.test.js` test `"buttonPress when lit cycles mode and keeps backlight on"`, which asserts `DEFAULT → DIAG`. Updating it is Step 1 below, not an accident.

- [ ] **Step 1: Update the existing cycling test and write the new failing tests**

Replace the existing `"buttonPress when lit cycles mode and keeps backlight on"` test in `src/store.test.js` with:

```js
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
```

The other existing test `"sleep turns backlight off and resets mode to DEFAULT"` presses twice to leave DEFAULT; it lands on MINMAX instead of DIAG now but only asserts the post-sleep state, so it still passes unchanged. Leave it alone.

Append to `src/render.test.js`, adding `formatMinMaxLines` and `formatDayCompLines` to the existing import from `./render.js`:

```js
const at = (y, m, d, h) => new Date(y, m, d, h, 0, 0).getTime();
const NOW = at(2026, 6, 26, 12);

const stateWithHistory = (samples, mode = "DEFAULT") => ({
  ...initialState,
  display: { ...initialState.display, mode },
  history: { samples },
});

test("MINMAX shows internal 24h min/max and a placeholder for the dead external probe", () => {
  const samples = [
    { ts: at(2026, 6, 25, 6), temperature_internal: 99, temperature_external: null }, // 30h ago, excluded
    { ts: at(2026, 6, 25, 18), temperature_internal: -3.2, temperature_external: null },
    { ts: at(2026, 6, 26, 11), temperature_internal: 31.44, temperature_external: null },
  ];
  const [l0, l1] = formatMinMaxLines(stateWithHistory(samples), NOW);
  assert.equal(l0, "i24 L-3.2 H31.4");
  assert.equal(l1, "e24 L-- H--");
});

test("MINMAX shows external min/max once the probe reports", () => {
  const samples = [
    { ts: at(2026, 6, 26, 3), temperature_internal: 12, temperature_external: 4.1 },
    { ts: at(2026, 6, 26, 11), temperature_internal: 20, temperature_external: 18.6 },
  ];
  const [, l1] = formatMinMaxLines(stateWithHistory(samples), NOW);
  assert.equal(l1, "e24 L4.1 H18.6");
});

test("MINMAX on an empty ring renders placeholders on both lines", () => {
  const [l0, l1] = formatMinMaxLines(stateWithHistory([]), NOW);
  assert.equal(l0, "i24 L-- H--");
  assert.equal(l1, "e24 L-- H--");
});

test("DAYCOMP shows today above yesterday", () => {
  const samples = [
    { ts: at(2026, 6, 25, 4), temperature_internal: -1.9 },
    { ts: at(2026, 6, 25, 15), temperature_internal: 28.8 },
    { ts: at(2026, 6, 26, 3), temperature_internal: -3.2 },
    { ts: at(2026, 6, 26, 11), temperature_internal: 31.4 },
  ];
  const [l0, l1] = formatDayCompLines(stateWithHistory(samples), NOW);
  assert.equal(l0, "tdy L-3.2 H31.4");
  assert.equal(l1, "yst L-1.9 H28.8");
});

test("DAYCOMP shows a placeholder for yesterday before the first midnight", () => {
  const samples = [{ ts: at(2026, 6, 26, 11), temperature_internal: 31.4 }];
  const [l0, l1] = formatDayCompLines(stateWithHistory(samples), NOW);
  assert.equal(l0, "tdy L31.4 H31.4");
  assert.equal(l1, "yst L-- H--");
});

test("new formatters stay within 16 characters at worst-case values", () => {
  const samples = [
    { ts: at(2026, 6, 25, 4), temperature_internal: -19.9, temperature_external: -19.9 },
    { ts: at(2026, 6, 26, 3), temperature_internal: -19.9, temperature_external: -19.9 },
    { ts: at(2026, 6, 26, 11), temperature_internal: 49.9, temperature_external: 49.9 },
  ];
  const state = stateWithHistory(samples);
  for (const line of [...formatMinMaxLines(state, NOW), ...formatDayCompLines(state, NOW)]) {
    assert.ok(line.length <= 16, `"${line}" is ${line.length} chars`);
  }
});

test("renderDisplay routes MINMAX and DAYCOMP to their formatters", () => {
  const samples = [{ ts: at(2026, 6, 26, 11), temperature_internal: 21.4 }];
  for (const [mode, formatter] of [
    ["MINMAX", formatMinMaxLines],
    ["DAYCOMP", formatDayCompLines],
  ]) {
    const state = stateWithHistory(samples, mode);
    const display = makeFakeDisplay();
    renderDisplay(state, display, NOW);
    const [l0, l1] = formatter(state, NOW);
    assert.deepEqual(display.calls, [["clear"], ["printLine", 0, l0], ["printLine", 1, l1]]);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `formatMinMaxLines is not a function`, plus the updated cycling test failing with `"DIAG" !== "MINMAX"`.

- [ ] **Step 3: Write the implementation**

In `src/store.js`, extend the mode list (leave `getNextMode` alone — it is already generic):

```js
export const displayModes = ["DEFAULT", "MINMAX", "DAYCOMP", "DIAG"];
```

In `src/render.js`, replace the existing `formatFloat` import line with the two imports
below, and insert the formatters **above** the existing `MODE_FORMATTERS` block — they
are `const` arrow functions, so they must be initialised before that object references
them at module evaluation time:

```js
import { formatFloat } from "piteknix";
import { selectWindow, selectMinMax, selectDayMinMax, DAY_MS } from "./history.js";

// formatFloat renders null as "0", which would be a lie for an absent reading,
// so missing min/max data gets its own placeholder.
const minMaxLine = (label, mm) =>
  mm === null
    ? `${label} L-- H--`
    : `${label} L${formatFloat(mm.min)} H${formatFloat(mm.max)}`;

export const formatMinMaxLines = (state, now) => {
  const window = selectWindow(state.history.samples, DAY_MS, now);
  return [
    minMaxLine("i24", selectMinMax(window, "temperature_internal")),
    minMaxLine("e24", selectMinMax(window, "temperature_external")),
  ];
};

export const formatDayCompLines = (state, now) => {
  const { samples } = state.history;
  return [
    minMaxLine("tdy", selectDayMinMax(samples, "temperature_internal", 0, now)),
    minMaxLine("yst", selectDayMinMax(samples, "temperature_internal", 1, now)),
  ];
};
```

Register them and thread `now` through the renderer:

```js
const MODE_FORMATTERS = {
  DEFAULT: formatDataLines,
  MINMAX: formatMinMaxLines,
  DAYCOMP: formatDayCompLines,
  DIAG: formatDiagLines,
};

export const renderDisplay = (state, display, now = Date.now()) => {
  const formatter = MODE_FORMATTERS[state.display.mode] || formatDataLines;
  const [line0, line1] = formatter(state, now);
  display.clear();
  display.printLine(0, line0);
  display.printLine(1, line1);
};
```

`formatDataLines` and `formatDiagLines` ignore the extra `now` argument — no change needed to either.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 7 new render tests, the updated cycling test green, all others unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/render.js src/render.test.js src/store.js src/store.test.js
git commit -m "feat: add MINMAX and DAYCOMP display modes"
```

---

### Task 4: Wire recording into the app loop

**Files:**
- Modify: `app.js`
- Test: `src/store.test.js` (one integration-style test)

**Interfaces:**
- Consumes: `recordSample` from Task 1, the formatters from Task 3.
- Produces: no new exports. This task makes the feature actually run.

- [ ] **Step 1: Write the failing test**

`app.js` has no test harness and is not worth building one for. What *is* worth pinning is that a realistic dispatch sequence produces a usable MINMAX screen — that is the contract between the poll loop and the display. Append to `src/store.test.js`, adding `formatMinMaxLines` to the imports (`import { formatMinMaxLines } from "./render.js";`):

```js
test("a poll cycle's dispatch sequence produces a renderable MINMAX screen", () => {
  const t1 = new Date(2026, 6, 26, 3, 0, 0).getTime();
  const t2 = new Date(2026, 6, 26, 11, 0, 0).getTime();
  const now = new Date(2026, 6, 26, 12, 0, 0).getTime();

  let s = initialState;
  s = appReducer(s, setInternalTemp(-3.2));
  s = appReducer(s, recordSample(t1));
  s = appReducer(s, setInternalTemp(31.4));
  s = appReducer(s, recordSample(t2));

  assert.deepEqual(formatMinMaxLines(s, now), ["i24 L-3.2 H31.4", "e24 L-- H--"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: PASS actually — Tasks 1–3 already make this work. That is the point: it is a regression guard on the seam, not a driver for new code. If it *fails*, something in Tasks 1–3 is wrong; stop and fix that before touching `app.js`.

- [ ] **Step 3: Wire `app.js`**

Add `recordSample` to the existing `./src/store.js` import:

```js
import { appReducer, buttonPress, recordSample } from "./src/store.js";
```

Extend the render listener predicate so the ring update triggers a redraw — without this MINMAX shows data one poll cycle stale:

```js
listener.startListening({
  predicate: (action) =>
    action.type.startsWith("data/") ||
    action.type.startsWith("sensors/") ||
    action.type.startsWith("display/") ||
    action.type.startsWith("history/"),
  effect: (_action, api) => renderDisplay(api.getState(), display),
});
```

Record one sample per poll cycle, after both sensors have settled, inside the existing `pollAll`:

```js
const pollAll = async () => {
  if (polling) return;
  polling = true;
  try {
    await pollInternal(internal, store.dispatch);
    await pollExternal(external, store.dispatch);
    // one sample per cycle, after both sensors settle — a failed read records
    // as null for that field rather than skipping the sample entirely
    store.dispatch(recordSample(Date.now()));
  } finally {
    polling = false;
  }
};
```

- [ ] **Step 4: Verify in virtual mode**

Run: `npm run dev`

Check, in order:
1. Boot shows `starting up...` then the DEFAULT screen with changing values.
2. Press `1` — backlight wakes (virtual display shows the state change), mode stays DEFAULT.
3. Press `1` again — screen shows `i24 L… H…` and `e24 L… H…`. The internal line must show real numbers within a couple of polls; the external line depends on whether the virtual ds18b20 generator produces readings, and either a real range or `L-- H--` is correct.
4. Press `1` again — `tdy L… H…` over `yst L-- H--`. Yesterday is empty; that is expected on a fresh process.
5. Press `1` again — DIAG. Press once more — back to DEFAULT.
6. Press `d` to dump state and confirm `history.samples` is growing and every entry has a plausible `ts`.
7. Leave it running ~1 minute and confirm the sample count keeps rising and nothing throws.

Note `pollMs` is 3000ms in virtual mode, so the `HISTORY_MAX_SAMPLES` cap binds after ~50 minutes of wall clock rather than 48 hours. Do not try to exercise day-boundary behaviour this way — that is what the injected-timestamp tests are for.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: PASS — full suite green.

```bash
git add app.js src/store.test.js
git commit -m "feat: record a history sample each poll cycle and redraw on it"
```

---

## Done criteria

- `npm test` green, with roughly 24 new tests on top of the existing 31.
- All four modes reachable by cycling the button in virtual mode.
- No new dependency in `package.json`.
- No filesystem writes anywhere in the diff.
- Every line emitted by `formatMinMaxLines` and `formatDayCompLines` is ≤ 16 characters.

## Follow-ups, explicitly out of scope

- Deploying to the Pi (separate exercise; remember `git checkout -- package-lock.json` before pulling on-device).
- Tagging polyteknix `v1.0.0`.
- Promoting the ring into `piteknix/history` — wait for the bathroom device to be a real second consumer.
- The pre-existing 17-character `ext: -- (unknown)` line in `formatDataLines`.
