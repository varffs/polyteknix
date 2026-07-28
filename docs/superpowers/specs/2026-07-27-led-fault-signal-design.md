# LED fault signal — design

_2026-07-27_

## Problem

The button LED (GPIO 17) is switched on at boot in `app.js` and never switched off. It
carries no information: it is on when the device is healthy, on when the external probe is
dead, on at 3am. The polytunnel box is visible from the house, so a permanently-lit LED is
light pollution with no payload.

Turning it off is only half the job. The pin is a free output sitting on the one control the
device has, visible from indoors — it should earn its place by carrying a signal worth
walking out for.

## Decision

The LED means: **something is wrong, and you have not looked at it yet.**

It pulses slowly when a fault is unacknowledged, goes dark when you walk out and read the
DIAG screen, and is suppressed entirely during true night regardless of fault state.

Three conditions must hold simultaneously for the LED to be lit:

1. at least one fault is active, **and**
2. at least one active fault is **not in** the set last acknowledged, **and**
3. it is not the quiet period (sunset + 30 min → sunrise − 30 min).

There is no state in which the LED is steadily on. The lit state is a 750 ms pulse inside a
3 s cycle, and it is reachable only via the conjunction above.

The LED is deliberately **independent of the backlight**. No shared state, no cross-coupling,
no suppression of one by the other. Two separate concerns.

## Site constants

Polytunnel location, for the solar calculation:

```
lat  50.7744
lon  -2.4753
```

Not a secret. Lives in `src/config.js` as a plain constant. 4 dp is ~10 m; sunset error from
rounding is under a second.

## Fault set

| Fault | Key | Active when | State backing |
|---|---|---|---|
| External probe | `ext` | `sensors.external_status` is neither `"ok"` nor `"unknown"` | exists |
| Internal AHT20 | `int` | `sensors.internal_status === "error"` | **new** |
| Push to iotplotter | `psh` | `sensors.push_failures >= 3` | **new** |
| Boot clock | `clk` | `led.clockWasInsane === true` | **new** |

`"unknown"` is the boot value for both sensor statuses and must **not** count as a fault —
otherwise the LED arms during startup before the first poll has run.

The push threshold is 3 consecutive failures. At a 5-minute push interval that is 15 minutes
of sustained failure, so a single flaky POST or a router reboot cannot arm the LED. Any
successful push resets the counter to 0.

The clock fault is **sticky**. This resolves an otherwise unsolvable ordering problem: if the
clock is insane we cannot compute sunset, so we cannot know whether lighting the LED is
permitted, so we must fail dark — meaning the fault could never signal at the time it occurs.
Instead the flag is raised when a bad timestamp is seen and survives into sane time, so once
NTP lands the LED reports, in daylight, that this Pi booted blind and dropped history. The
flag is cleared when the display **leaves** DIAG, not by the clock becoming sane.

### Fault key

```js
selectFaultKey(state) // → "int|psh|clk|ext" subset, fixed order, "" when healthy
```

Fixed order makes the key a stable identity for a fault *set*, so an acknowledgement can be
stored as one serializable string.

`selectArmed` then tests **containment, not string equality**: armed when some live fault is
absent from the acknowledged set, derived by splitting `seenFaultKey` on `|`. The first draft
compared the two keys with `!==`, which re-armed on *any* change including the set shrinking —
so `psh|ext` acknowledged, then push recovering to `ext`, pulsed the LED at a strictly improved
situation the user had already read. With `ext` permanently live on this device that fired for
every transient fault that cleared after acknowledgement.

## Acknowledgement

Entering `DIAG` mode acknowledges the current fault set. Reaching DIAG requires pressing the
button while the backlight is lit, which requires standing at the device — so acknowledgement
is physically identical to having looked.

On entering DIAG: compute `faultKey` from the **current** state, `clk` included, and store it
as `led.seenFaultKey`. `led.clockWasInsane` is **not** touched here.

The sticky clock flag is cleared when the display **leaves** DIAG — on `display/sleep` and on
the `buttonPress` that cycles DIAG round to DEFAULT. Only leaving DIAG clears it: sleeping from
MINMAX would otherwise discard a fault the user never saw.

This corrects the first draft, which cleared the flag *before* capturing the key on entry to
DIAG. That made `clk` undisplayable and destroyed the evidence: `formatDiagLines` derives line 1
from `selectFaults` on the same post-clear state, and `renderDisplay` only reaches it once the
mode is already `DIAG`, so the flag was gone before the one screen that reports it ever
rendered — with `clk` as the only fault the user walked out to a screen reading as healthy, and
the flag never came back. The draft's clear-first ordering existed to stop acknowledgement from
instantly re-arming, a hazard that only exists under string equality; with `selectArmed` testing
containment, a live set that is a subset of the acknowledged one is not armed, so `clk`
vanishing from the live set after being acknowledged is harmless. Clearing on exit rather than
never is still necessary: a permanently-raised flag would displace the `diagnose()` text on DIAG
line 1 for the rest of the process.

Further rules:

- Fault key becomes `""` (everything healthy) → `seenFaultKey` resets to `null`, so a
  recurrence of the same fault re-arms rather than being silently pre-acknowledged.
- Restart re-arms, because `seenFaultKey` starts `null` and is not persisted. Deliberate: an
  unexplained restart is itself worth knowing about, and this device holds no state across
  reboots by design.

## Quiet period

New module `src/solar.js`, one exported pure function:

```js
isQuietPeriod(ts, { lat, lon, marginMs }) // → boolean
```

- Quiet window is `[sunset + marginMs, sunrise − marginMs]`, `marginMs` = 30 min.
- Spanning midnight is the whole difficulty: at 01:00 the governing pair is *yesterday's*
  sunset and *today's* sunrise. Each solar day opens one window (its sunset + margin → the
  next morning's sunrise − margin); the function tests membership of the two candidates
  opened by `ts − 24h` and `ts`, which is sufficient — no later window can contain `ts`. No
  local-midnight arithmetic, no DST branch, no `TZ` read: UTC epoch milliseconds throughout.
- `ts < SANITY_EPOCH` → returns `true`. An unknowable time never lights the LED.
- Takes `ts` as an argument and calls no clock itself, so it is testable at any date.

Sunrise/sunset come from **`suncalc`**, pinned at `^2.0.1` (verified at install, 2026-07-28).
Corrects the pre-install guess in the first draft of this spec, which said ES5/CJS: 2.0.1 is
`"type": "module"` with an `exports` map offering both an ESM entry and a CJS one, and it
exposes **named exports only — there is no default export**, so the import form is
`import { getTimes } from "suncalc"`. Still a single file with no runtime dependencies, no
native bindings and no postinstall, which is what actually matters for armv6 Node 16.14; the
published source uses no syntax newer than Node 16. The alternative considered was hand-rolling the NOAA solar position
algorithm (~40 lines) — rejected as owning astronomy edge cases for no gain. Fixed clock-hour
quiet periods were rejected outright: at this latitude sunset swings from roughly 16:00 in
December to roughly 21:30 in June, so any fixed window either mutes most of a summer evening
or blinks into full winter darkness.

Approximate consequence at 50.77°N, to be pinned by test fixtures rather than trusted from
here: the LED is permitted roughly 04:30–21:50 local at midsummer, roughly 07:40–16:35 at
midwinter. The long winter blackout is intended.

Dev escape hatch: `LED_IGNORE_QUIET=true` forces `isQuietPeriod` to be bypassed. Without it,
evening work on the laptop shows a permanently dark virtual LED and reads as a broken feature.

## Blink mechanics

750 ms on, 2250 ms off — 3 s period, 25% duty. A slow pulse rather than a flash: readable from
the house, distinguishable from any indicator LED on the hardware, minimal light thrown.

Driven by a listener, per REDUX-SPEC — no render loop, no free-running interval. Registered by
`registerLedBlink(listener, { onMs, offMs, quietRecheckMs, isQuiet })`, with `isQuiet` injected
so the loop is testable without a real clock or a real sun.

```
predicate: armed transitioned false → true
effect:
  api.cancelActiveListeners()
  while (selectArmed(api.getState())):
    if (isQuiet(Date.now())):
      dispatch(ledLit(false))
      await api.delay(quietRecheckMs)   // 60s — idle, don't churn all night
      continue
    dispatch(ledLit(true))
    await api.delay(onMs)
    dispatch(ledLit(false))
    await api.delay(offMs)
  dispatch(ledLit(false))
```

Consequences worth stating:

- The quiet window re-evaluates itself every cycle for free. No separate clock ticker exists.
- The loop runs **only while armed**. A healthy device does zero background work — no timers,
  no actions, no state churn.
- While armed but quiet, the loop idles at 60 s. Sunrise granularity of one minute is
  immaterial against a 30-minute margin.
- `led/lit` actions do not match the render listener's predicate (`data/ sensors/ display/
  history/`), so blinking triggers no display re-render.

### Division of responsibility

- **Reducer** owns *is there an unseen fault* — pure, no config, no clock.
- **Blink effect** owns *may I light it right now* — calls `Date.now()`, calls `isQuietPeriod`,
  dispatches a plain boolean.
- **Hardware sync listener** owns the GPIO write: predicate `curr.led.isLit !== prev.led.isLit`
  → `led.write(isLit)`. Same predicate shape as the existing backlight sync listener in `app.js`,
  but the effect is `async` and `await`s the write inside a `try/catch` that logs. `write()` is
  async, and this pin is written up to 40 times a minute where the backlight is written twice a
  day, so a failing write should cost one readable line rather than a
  `listenerMiddleware/error` stack trace per pulse.
- **Shutdown** calls `listener.clearListeners()` as the first line of the `SIGINT` handler,
  before any `cleanup()`. It aborts every executing listener, so the blink loop's in-flight
  `api.delay` cannot fire after `led.cleanup()` has unexported the pin and spend the rest of the
  shutdown writing to a closed fd. It also cancels the pending backlight timeout, which is
  wanted on the way out.

## State shape

```js
led: {
  seenFaultKey: null,      // fault key at last acknowledgement; null = nothing acknowledged
  isLit: false,            // desired GPIO state; hardware listener mirrors it
  clockWasInsane: false,   // sticky, cleared on leaving DIAG
},
sensors: {
  external_status,         // existing
  external_diagnostic,     // existing
  internal_status: "unknown",  // new: "unknown" | "ok" | "error"
  push_failures: 0,            // new
}
```

## DIAG screen

The display is 16x2 and a fifth display mode is not worth adding, so the new faults ride on the
existing DIAG screen:

- line 0: `ext: <status>` — unchanged
- line 1: if any of `int`/`psh`/`clk` is active → those flags space-joined (`"int psh clk"`,
  11 chars worst case); otherwise the external diagnostic text — unchanged

Accepted trade: while a non-ext fault is live, the `diagnose()` detail line is hidden until it
clears. Non-ext faults are rare and the flags are the more urgent news.

## Changes by file

| File | Change |
|---|---|
| `src/solar.js` | **new** — `isQuietPeriod` |
| `src/solar.test.js` | **new** |
| `src/faults.js` | **new** — `selectFaults`, `selectFaultKey`, `selectArmed`. Imports nothing: `store.js` needs the key for acknowledgement and `led.js` needs action creators from `store.js`, so the selectors must live outside both or the imports cycle |
| `src/faults.test.js` | **new** |
| `src/led.js` | **new** — `registerLedBlink` only |
| `src/led.test.js` | **new** |
| `src/store.js` | `led` slice, `internal_status`, `push_failures`, ack-on-DIAG, sticky clock flag |
| `src/sensors.js` | dispatch `internal_status` in both branches of `pollInternal` |
| `src/render.js` | DIAG line 1 fault flags |
| `src/config.js` | `siteLat`, `siteLon`, blink timings, quiet margin, `LED_IGNORE_QUIET` |
| `app.js` | `led.off()` at boot, register blink + hardware-sync listeners, dispatch push outcome |
| `package.json` | add `suncalc` |
| existing `*.test.js` | extend for the new state and render branches |

`src/push.js` needs no change. It already returns `null` when no key is configured (virtual
mode) and throws on a failed POST — exactly the three-way outcome `app.js` needs. The `null`
case must count as neither success nor failure, or every virtual run arms the LED after 15
minutes.

At boot, `await led.on()` in `app.js` is replaced by `await led.off()`. SIGINT cleanup already
writes 0, but a crash or `pm2 restart` mid-run can leave the pin high, so boot forces a known
dark state rather than assuming one.

## Testing

`node --test`, laptop only — the device is pinned to Node 16.14 and `node --test` needs 16.17+.
Same constraint as v2.0.0: the suite runs before deploy, the deploy target cannot verify itself.

Coverage required:

- `isQuietPeriod`: midsummer, midwinter, both boundary edges (± the 30 min margin), a
  midnight-spanning timestamp, a `ts < SANITY_EPOCH` timestamp.
- `selectFaultKey`: healthy, each fault alone, several at once, fixed ordering, `"unknown"`
  statuses excluded.
- Acknowledgement: arms on new fault, disarms on DIAG entry, re-arms when a fault appears that
  is **not** in the acknowledged set, does **not** re-arm when the set only shrinks, resets
  `seenFaultKey` when everything goes healthy. The clock flag survives DIAG entry (so line 1 can
  render `clk`), is cleared by both exits from DIAG, and does not re-arm when cleared. Any test
  asserting a DIAG-mode state must reach it by dispatching `buttonPress` through the real
  reducer — a hand-built `{ mode: "DIAG", clockWasInsane: true }` is unreachable and gives false
  confidence.
- Blink loop: pulses while armed, exits on disarm, leaves `isLit` false on exit, idles at the
  recheck interval while quiet, never dispatches `lit: true` while quiet.
- Push counter: increments on failure, resets on success, threshold at 3, ignores the no-key
  `null` return.
- Render: DIAG line 1 shows flags when non-ext faults are active and the diagnostic otherwise.

## Deploy notes

First registry dependency added since the piteknix pinning work. The known gotcha applies: the
device's npm 8 rewrites `package-lock.json`, so `git checkout -- package-lock.json` before
pulling. `suncalc` is pure JS with no build step, so armv6 is not a risk.

`NODE_ENV=production` remains required on the device and still lives only in pm2's saved dump.
Unchanged by this work, but the blink loop adds up to 2 actions per 3 s while armed, so a
device that lost the flag would feel it.

## Out of scope

- Frost or overheat alerting via the LED — considered and ruled out; fault signalling only.
- Any light sensor or ambient-brightness input.
- polyteknix#4 (a stale-but-post-2024 `fake-hwclock` time passes the `SANITY_EPOCH` guard). The
  `clk` fault catches only the gross case; a clock stale by hours passes the guard and skews
  the sunset calculation by however stale it is. Pre-existing, tracked separately.
- Persisting `seenFaultKey` across restarts.
