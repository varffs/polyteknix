# Backlight Timeout + Button Wake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LCD backlight sleeps after 30 s; first button press wakes it, presses while lit cycle the display mode and reset the timeout.

**Architecture:** Reducer owns press semantics (a single `display/buttonPress` action means "wake" when dark, "cycle mode" when lit; `display/sleep` darkens and resets mode to DEFAULT). An RTK listener-middleware entry owns the 30 s timer via `cancelActiveListeners()` + `delay()`. A second edge-triggered listener syncs `isBacklit` to the display hardware. Boot dispatches one `buttonPress` so startup behaves exactly like a first press.

**Tech Stack:** Node.js ESM, `@reduxjs/toolkit` v2 (`configureStore`, `createListenerMiddleware`), `node --test` + `node:assert/strict`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-25-backlight-timeout-design.md`

## Global Constraints

- Node >= 18, ESM (`"type": "module"`), test runner is `node --test 'src/**/*.test.js'` via `npm test`.
- Working dir: `~/Sites/worldofpi/polyteknix`, branch `feature/backlight-timeout`.
- Action naming follows REDUX-SPEC `slice/property` convention.
- Reducer must stay pure — timers and hardware calls live in listener middleware only.
- `display/next` and the `nextMode()` action creator are retired; `getNextMode` (the pure helper) stays.
- No piteknix changes — both display drivers already implement `setBacklight(on)`.
- After Task 1 and until Task 3 completes, `app.js` still references the removed `nextMode` — tests stay green throughout (app.js is not in the test import graph), but do not `npm run dev` between those tasks.

---

### Task 1: Reducer press/sleep semantics

**Files:**
- Modify: `src/store.js`
- Test: `src/store.test.js`

**Interfaces:**
- Consumes: existing `initialState`, `getNextMode` in `src/store.js`.
- Produces: `buttonPress()` → `{ type: "display/buttonPress" }` and `sleep()` → `{ type: "display/sleep" }` action creators, exported from `src/store.js`. Reducer honours both. `nextMode` export and `display/next` case removed. Tasks 2 and 3 import `buttonPress`/`sleep` by these exact names.

- [ ] **Step 1: Write the failing tests**

In `src/store.test.js`, change the import line and replace the `display/next` test with the four new tests:

```js
import { appReducer, initialState, setInternalTemp, setExternalStatus, buttonPress, sleep } from "./store.js";
```

Delete the `test("display/next cycles DEFAULT -> DIAG -> DEFAULT", ...)` block. Append:

```js
test("buttonPress when dark wakes backlight without cycling mode", () => {
  const s = appReducer(initialState, buttonPress());
  assert.equal(s.display.isBacklit, true);
  assert.equal(s.display.mode, "DEFAULT");
});

test("buttonPress when lit cycles mode and keeps backlight on", () => {
  const lit = appReducer(initialState, buttonPress());
  const s1 = appReducer(lit, buttonPress());
  assert.equal(s1.display.mode, "DIAG");
  assert.equal(s1.display.isBacklit, true);
  const s2 = appReducer(s1, buttonPress());
  assert.equal(s2.display.mode, "DEFAULT");
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Sites/worldofpi/polyteknix && npm test`
Expected: FAIL — `buttonPress` is not exported (SyntaxError on import in `store.test.js`).

- [ ] **Step 3: Implement in `src/store.js`**

Replace the `nextMode` creator with the two new creators (leave the other creators untouched):

```js
export const buttonPress = () => ({ type: "display/buttonPress" });
export const sleep = () => ({ type: "display/sleep" });
```

In `appReducer`, replace the `case "display/next":` block with:

```js
    case "display/buttonPress":
      if (!state.display.isBacklit) {
        return { ...state, display: { ...state.display, isBacklit: true } };
      }
      return { ...state, display: { ...state.display, mode: getNextMode(state.display.mode) } };
    case "display/sleep":
      return { ...state, display: { ...state.display, isBacklit: false, mode: "DEFAULT" } };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 28 tests, 0 fail (25 before this task, minus the deleted display/next test, plus these 4).

- [ ] **Step 5: Commit**

```bash
git add src/store.js src/store.test.js
git commit -m "feat: buttonPress/sleep reducer semantics for backlight wake"
```

---

### Task 2: Backlight timeout listener module

**Files:**
- Create: `src/backlight.js`
- Test: `src/backlight.test.js`

**Interfaces:**
- Consumes: `sleep` creator from `src/store.js` (Task 1); RTK `listenerMiddleware.startListening` API.
- Produces: `registerBacklightTimeout(listener, { timeoutMs })` exported from `src/backlight.js` — `listener` is the object returned by `createListenerMiddleware()`. Task 3 calls it with `{ timeoutMs: cfg.backlightTimeoutMs }`.

- [ ] **Step 1: Write the failing tests**

Create `src/backlight.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import { appReducer, buttonPress } from "./store.js";
import { registerBacklightTimeout } from "./backlight.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const makeStore = (timeoutMs) => {
  const listener = createListenerMiddleware();
  registerBacklightTimeout(listener, { timeoutMs });
  return configureStore({
    reducer: appReducer,
    middleware: (getDefault) => getDefault().prepend(listener.middleware),
  });
};

test("backlight sleeps after the timeout", async () => {
  const store = makeStore(25);
  store.dispatch(buttonPress());
  assert.equal(store.getState().display.isBacklit, true);
  await wait(60);
  assert.equal(store.getState().display.isBacklit, false);
  assert.equal(store.getState().display.mode, "DEFAULT");
});

test("a press mid-window resets the timeout", async () => {
  const store = makeStore(50);
  store.dispatch(buttonPress());          // lit, timer armed
  await wait(30);
  store.dispatch(buttonPress());          // lit -> cycles mode, re-arms timer
  await wait(30);                         // 60ms after first press, 30ms after second
  assert.equal(store.getState().display.isBacklit, true, "reset should have kept it lit");
  assert.equal(store.getState().display.mode, "DIAG");
  await wait(40);                         // 70ms after second press — past its window
  assert.equal(store.getState().display.isBacklit, false);
});

test("press while lit cycles the mode", async () => {
  const store = makeStore(200); // short enough not to hold the event loop long after the suite

  store.dispatch(buttonPress());
  store.dispatch(buttonPress());
  assert.equal(store.getState().display.mode, "DIAG");
  assert.equal(store.getState().display.isBacklit, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot find module `./backlight.js`.

- [ ] **Step 3: Implement `src/backlight.js`**

```js
import { sleep } from "./store.js";

/**
 * Arms a sleep timer on every button press. A new press cancels the
 * pending timer (cancelActiveListeners) and starts a fresh one, so the
 * backlight goes dark timeoutMs after the LAST press.
 */
export const registerBacklightTimeout = (listener, { timeoutMs }) => {
  listener.startListening({
    type: "display/buttonPress",
    effect: async (_action, api) => {
      api.cancelActiveListeners();
      await api.delay(timeoutMs);
      api.dispatch(sleep());
    },
  });
};
```

Note: `api.delay()` rejects with `TaskAbortError` when cancelled; RTK's listener runtime catches that internally — do NOT wrap in try/catch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 0 fail. If the reset test flakes on a loaded machine, widen the windows proportionally (50→100, waits ×2) — keep ratios, don't tighten.

- [ ] **Step 5: Commit**

```bash
git add src/backlight.js src/backlight.test.js
git commit -m "feat: backlight sleep timer as RTK listener (cancel-on-press)"
```

---

### Task 3: Config + app wiring

**Files:**
- Modify: `src/config.js`
- Modify: `src/config.test.js`
- Modify: `app.js`

**Interfaces:**
- Consumes: `buttonPress` from `src/store.js` (Task 1); `registerBacklightTimeout` from `src/backlight.js` (Task 2).
- Produces: `loadConfig()` result gains `backlightTimeoutMs: 30000`. Running app has the full behaviour.

- [ ] **Step 1: Write the failing config test**

In `src/config.test.js`, add to the first test (`loadConfig reads key from env`):

```js
  assert.equal(cfg.backlightTimeoutMs, 30000);
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npm test`
Expected: FAIL — `undefined !== 30000`.

- [ ] **Step 3: Add the constant to `src/config.js`**

In the returned object, after `pollMs`:

```js
    backlightTimeoutMs: 30000,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, 0 fail.

- [ ] **Step 5: Wire `app.js`**

Four edits:

1. Import line — replace `nextMode` with `buttonPress`, add the backlight module:

```js
import { appReducer, buttonPress } from "./src/store.js";
import { registerBacklightTimeout } from "./src/backlight.js";
```

2. Listener block — widen the render predicate from `action.type === "display/next"` to `action.type.startsWith("display/")`, and register the two new listeners right after the existing `listener.startListening({...})` render block (before `configureStore`):

```js
listener.startListening({
  predicate: (action) =>
    action.type.startsWith("data/") ||
    action.type.startsWith("sensors/") ||
    action.type.startsWith("display/"),
  effect: (_action, api) => renderDisplay(api.getState(), display),
});

// Backlight hardware sync — fires only when isBacklit actually changes
listener.startListening({
  predicate: (_action, curr, prev) => curr.display.isBacklit !== prev.display.isBacklit,
  effect: (_action, api) => display.setBacklight(api.getState().display.isBacklit),
});

registerBacklightTimeout(listener, { timeoutMs: cfg.backlightTimeoutMs });
```

3. Button handler — replace `button.watch(() => store.dispatch(nextMode()));` with:

```js
button.watch(() => store.dispatch(buttonPress()));
```

4. Boot press — immediately after `await pollAll();` (before the `setInterval` lines):

```js
store.dispatch(buttonPress()); // boot behaves like a first press: light up, arm the sleep timer
```

- [ ] **Step 6: Run full suite**

Run: `npm test`
Expected: PASS, 0 fail.

- [ ] **Step 7: Virtual-mode smoke test (scripted, ~50 s)**

```bash
S=$(mktemp -d); mkfifo $S/in
cd ~/Sites/worldofpi/polyteknix
(sleep 120 > $S/in &)
VIRTUAL_MODE=true IOTPLOTTER_KEY= node app.js < $S/in > $S/out.log 2>&1 &
sleep 2
grep -c $'\x1B\[44m' $S/out.log   # blue-bg frames => backlight ON at boot; expect >= 1
sleep 33
tail -c 300 $S/out.log | grep -c $'\x1B\[40m\x1B\[90m'   # dim frame => slept; expect >= 1
printf '1' > $S/in; sleep 1
tail -c 300 $S/out.log | grep -c $'\x1B\[44m'   # wake press => blue again; expect >= 1
printf '1' > $S/in; sleep 1
tail -c 400 $S/out.log | grep -c 'ext:'          # second press => DIAG frame ("ext:" on line 0)
printf 'q' > $S/in
```

Expected: each grep count >= 1 at its step. (`IOTPLOTTER_KEY=` override prevents pushing synthetic data to the real feed.)

- [ ] **Step 8: Commit**

```bash
git add src/config.js src/config.test.js app.js
git commit -m "feat: wire backlight timeout + context-sensitive button into app"
```
