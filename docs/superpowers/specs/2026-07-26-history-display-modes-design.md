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
{ ts, temperature_internal, temperature_external, humidity_internal, pressure }
```

The ring retains **49 hours**, not 48 — 24h is not enough, because DAYCOMP's "yesterday"
needs data from up to two days back just after midnight, and a plain 48h window drops
yesterday's 00:00–01:00 samples on the evening a `TZ=Europe/London` DST fall-back
lengthens a local day to 25 hours: "yesterday" then starts up to 48h59m before now. At
the 5-minute production poll interval 49h is ~588 entries, roughly 25 KB — about 12
samples more than a flat 48h window. A hard cap of 1000 entries backstops against
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
`ts - 49h`, then — if still over the cap — drops from the oldest end until at the cap.

Note the cap binds in virtual mode: `pollMs` is 3000ms there, so 1000 samples is about
50 minutes of wall clock rather than 49 hours. Time-based window logic is exercised in
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

Min and max are rendered as **whole degrees**. One decimal place does not fit: the
worst case is not "negative min, positive max" but an all-day freeze where *both*
values are two-digit negative, and `tdy L-12.4 H-10.1` is 17 characters on a 16-column
display. That is ordinary winter, not a contrived value. Whole degrees fit with margin
(worst case `tdy L-20 H-13`, 13 characters) and keep the explicit L/H labelling, at the
cost of 0.1° resolution on these two screens — `DEFAULT` still shows the live reading to
one decimal, so the precision is not lost from the device, only from the summaries.

This was an amendment made during the build, not the original decision: the layout
originally drafted here kept one decimal place and only widened the three-character
labels, on the assumption that the worst case was one negative and one positive value
(e.g. `-3.2` / `31.4`). Implementation testing found the real worst case — both values
two-digit negative on the same line, `tdy L-12.4 H-10.1` — overflows at 17 characters,
which is what forced the drop to whole degrees above.

```
MINMAX    |i24 L-3 H31     |     worst case: |i24 L-20 H-13| = 13
          |e24 L-- H--     |

DAYCOMP   |tdy L-3 H31     |
          |yst L-2 H29     |
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
  The existing cycling tests in `store.test.js` **and `backlight.test.js`** assert the
  old order and must be updated as part of this work.
- All history is lost on restart or power cut.
- For roughly the first hour after a restart, MINMAX's "24h" window contains only the
  samples taken since boot. The label still reads `24h`; it is not qualified.

## Testing

Everything added here is pure — no hardware, no filesystem, no clock mocking. Added to
the existing 31 tests with `node --test`:

- **Reducer:** appends a snapshot; prunes beyond 49h; enforces the cap; ignores
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
