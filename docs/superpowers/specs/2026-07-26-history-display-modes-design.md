# In-memory history + MINMAX / DAYCOMP display modes

_Design, 2026-07-26._

## Problem

The polytunnel display only ever shows the instantaneous reading. The question the
device is actually there to answer — "how cold did it get last night, and was that
worse than the night before?" — needs history, and right now that history only exists
in iotplotter, which means reaching for a phone while standing in the polytunnel.

## Goal

Two new 16x2 display modes fed by on-device history:

- **MINMAX** — rolling 24h min/max for internal and external temperature.
- **DAYCOMP** — today's internal min/max above yesterday's.

## Explicit non-goals

Decided during brainstorming, recorded so they are not re-litigated:

- **No database.** Not SQLite, not `better-sqlite3`. The data volume (288 samples/day)
  does not justify one, and a native module means an armv6 build step on every deploy.
- **No persistence of any kind.** No JSON snapshot, no append log. History lives in
  Redux memory and resets on restart.
- **No web dashboard, no local query API, no iotplotter backfill buffer.** The logged
  data exists to drive the LCD and nothing else.
- **No trend/delta screen.** `DEFAULT` already shows the current reading.

## Data model

One new slice on `initialState`:

```js
history: { samples: [] }
```

Each sample is a flat snapshot:

```js
{ ts, temperature_internal, temperature_external, humidity_internal }
```

The ring retains **48 hours** — 24h is not enough, because DAYCOMP's "yesterday" needs
data from up to 48h ago just after midnight. At the 5-minute production poll interval
that is ~576 entries, roughly 25 KB. A hard cap of 1000 entries backstops against
clock anomalies inflating the ring.

Storing whole `data` snapshots rather than per-field series means humidity and external
temperature get min/max support for free, with no extra state and no per-field wiring.

## Recording

Sampling is not currently atomic: `pollInternal` and `pollExternal` dispatch three
separate `data/*` actions, and either may fail independently. Rather than trying to
make those atomic, a fourth action is dispatched from `pollAll` in `app.js` once both
polls have settled:

```js
recordSample(Date.now())  // { type: "history/record", payload: ts }
```

The reducer already has `state.data` in hand, so it composes the sample itself and the
payload carries only the timestamp. This keeps the reducer pure and lets tests drive
time by passing a timestamp rather than mocking the clock.

On each `history/record` the reducer appends, then prunes entries older than
`ts - 48h`, then — if still over the cap — drops from the oldest end until at the cap.

Note the cap binds in virtual mode: `pollMs` is 3000ms there, so 1000 samples is about
50 minutes of wall clock rather than 48 hours. Time-based window logic is exercised in
unit tests by injecting timestamps, not by leaving `npm run dev` running.

### Clock sanity

The Pi Zero has no RTC. pm2 can start the app before NTP has synced, so early samples
can carry a 1970-era timestamp; when the clock then jumps forward those samples look
like ancient history and would corrupt DAYCOMP's day bucketing for the first day after
every reboot.

Guard: `history/record` is a no-op when `ts < SANITY_EPOCH` (2024-01-01). Samples taken
before the clock is trustworthy are simply not recorded.

## Selectors — `src/history.js`

Pure functions with `now` injected, so every one is testable without a clock:

```js
selectWindow(samples, windowMs, now)          // samples where ts > now - windowMs
selectMinMax(samples, field)                  // { min, max } | null — skips null values
selectDayMinMax(samples, field, offset, now)  // offset 0 = today, 1 = yesterday (local)
```

`selectMinMax` returns `null` rather than `{min: null, max: null}` when a field has no
usable values, so formatters have one condition to check. Day bucketing uses local
calendar days — the device is answering a question about last night, not about UTC.

## Display modes

`displayModes` becomes `["DEFAULT", "MINMAX", "DAYCOMP", "DIAG"]`. The existing
`getNextMode` cycling and the backlight rules are untouched: four modes is still
tolerable on a single button.

Both new screens are drawn to fit 16 characters at the **worst realistic value width** —
a two-digit negative minimum and a two-digit maximum, e.g. `-19.9` / `49.9`. The
polytunnel goes below zero, so the obvious `24h L -3.2 H 31.4` layout is wrong twice
over: it overflows at 17 characters, and shortening it only to `i24h L-3.2 H31.4` (16)
still overflows the moment the minimum reaches -13.2. Hence three-character labels:

```
MINMAX    |i24 L-3.2 H31.4 |     worst case: |i24 L-19.9 H49.9| = 16
          |e24 L-- H--     |

DAYCOMP   |tdy L-3.2 H31.4 |
          |yst L-1.9 H28.8 |
```

All four lines come from one helper, so missing data renders `L-- H--` everywhere
rather than a second "no data" wording.

MINMAX line 1 shows the external probe, which is currently dead — it renders
`e24 L-- H--` until the probe is replaced, then starts working with no code change.
DAYCOMP is internal-only; an external equivalent can be added later as another mode if
it turns out to be wanted.

Formatters live alongside the existing ones in `src/render.js` and are registered in
`MODE_FORMATTERS`.

## Wiring

One change in `app.js` beyond the new dispatch: the render listener predicate gains
`action.type.startsWith("history/")`. Without it the ring updates after the render for
that poll has already run, and MINMAX shows data one poll cycle stale.

## Accepted behaviours

Consequences of the no-persistence decision, accepted deliberately:

- DAYCOMP renders `yst L-- H--` until the device has been running across a midnight.
  It self-heals overnight.
- Adding two modes changes the button cycle from `DEFAULT → DIAG` to
  `DEFAULT → MINMAX → DAYCOMP → DIAG`, so DIAG moves from one press away to three.
  The existing cycling test in `store.test.js` asserts the old order and must be
  updated as part of this work.
- All history is lost on restart or power cut.
- For roughly the first hour after a restart, MINMAX's "24h" window contains only the
  samples taken since boot. The label still reads `24h`; it is not qualified.

## Testing

Everything added here is pure — no hardware, no filesystem, no clock mocking. Added to
the existing 31 tests with `node --test`:

- **Reducer:** appends a snapshot; prunes beyond 48h; enforces the cap; ignores
  timestamps below the sanity epoch; leaves other slices untouched.
- **Selectors:** empty ring; a field that is null in every sample; a single sample;
  samples either side of a local midnight; window boundary exactness.
- **Formatters:** negative minimum; missing external sensor; missing yesterday; and a
  width assertion that every produced line is 16 characters or fewer.

## Placement

Built in the polyteknix app, not in `piteknix`. The ring and selectors are ~40 lines
and the right generic API is not yet obvious; promotion to `piteknix/history` should
wait until the bathroom device is a real second consumer. No `piteknix` release is
needed for this feature.
