# Backlight timeout + button wake — design

**Date:** 2026-07-25
**Status:** approved (brainstormed with user)
**Repo:** polyteknix (builds on the piteknix refactor, PR #1, merged)

## What

The LCD backlight turns off after a timeout. Button behaviour becomes
context-sensitive:

- **Backlight off + press** → backlight on. Display mode untouched.
- **Backlight on + press** → cycle display mode (DEFAULT ↔ DIAG) **and**
  reset the timeout.
- **No press for 30 s** → backlight off, display mode resets to DEFAULT
  (next wake always shows the main readings).
- **Boot** → backlight on with the timeout armed ("starting up..." is
  visible; goes dark 30 s after boot if untouched).

Sensor polling, rendering, and iotplotter push are unaffected. Content
keeps rendering while dark — the sleep affects backlight only (plus the
mode reset). LCD text remains readable in daylight without backlight.

Decisions taken with the user: 30 s timeout; mode resets to DEFAULT on
sleep; boot starts lit with the timer running.

## How

Approach: **reducer owns press semantics, RTK listener middleware owns
the timer** (chosen over an app-shell `setTimeout`, which would put the
behaviour in the untested app.js, and over a timestamp-in-state poll
check, which is useless at the 5-minute hardware poll cadence).

### State + actions (`src/store.js`)

`initialState.display.isBacklit` stays `false` — boot wakes it via the
first press (see Boot below). Action changes:

- New `display/buttonPress` (`buttonPress()` creator). Reducer:
  - `isBacklit === false` → `{ isBacklit: true }`, mode untouched.
  - `isBacklit === true` → `{ mode: getNextMode(mode) }`.
- New `display/sleep` (`sleep()` creator). Reducer:
  `{ isBacklit: false, mode: "DEFAULT" }`.
- `display/next` is **retired** — `buttonPress` replaces it. The
  GPIO/keyboard button is its only caller.

### Timeout listener (`src/backlight.js`, wired in `app.js`)

Factored into its own module so it is testable without hardware:

```js
export const registerBacklightTimeout = (listener, { timeoutMs }) => {
  listener.startListening({
    type: "display/buttonPress",
    effect: async (_action, api) => {
      api.cancelActiveListeners();      // a new press cancels the pending sleep
      await api.delay(timeoutMs);
      api.dispatch(sleep());
    },
  });
};
```

`api.delay()` rejects on cancellation; RTK treats that as listener
completion — no timer leak, no unhandled rejection.

### Backlight hardware sync (`app.js`)

```js
listener.startListening({
  predicate: (_a, curr, prev) => curr.display.isBacklit !== prev.display.isBacklit,
  effect: (_a, api) => display.setBacklight(api.getState().display.isBacklit),
});
```

Fires only on the edge — no repeated I2C backlight writes per render.
Both display drivers already implement `setBacklight(on)`: hardware LCD
via `backlightSync()/noBacklightSync()`, virtual terminal via blue-bg vs
dim rendering. **No piteknix change needed.**

The existing render listener predicate widens from `display/next` to the
`display/` prefix so the sleep's mode reset triggers a redraw.

### Boot + config

- `src/config.js`: `backlightTimeoutMs: 30_000` constant (not
  env-driven — YAGNI). Tests don't need a config override — they pass a
  short `timeoutMs` straight into `registerBacklightTimeout`.
- `app.js` after the initial render: `store.dispatch(buttonPress())` —
  boot literally *is* the first press: lights the backlight, arms the
  timer. No special-cased boot path.

### Error handling

No new failure modes: reducer is pure; the only side effects are
`setBacklight` (already-handled display driver call) and a dispatched
action. A press during the sleep dispatch is ordered by the store —
worst case the screen sleeps and the same press wakes it.

## Testing

- **Reducer** (`src/store.test.js`): press-when-dark wakes without
  cycling; press-when-lit cycles without touching backlight; sleep
  resets both mode and backlight; boot-press from initialState lights up
  on DEFAULT.
- **Integration** (`src/backlight.test.js`, real store + listener
  middleware, `timeoutMs` ~25 ms injected — no fake timers):
  - press → wait past timeout → state slept (isBacklit false, DEFAULT);
  - press → second press mid-window → wait the original window out →
    still lit (reset actually reset);
  - press-while-lit cycled the mode.
- **Eyeball** (`npm run dev`): virtual LCD renders dim vs blue —
  the whole feature is verifiable on the laptop before deploy.
