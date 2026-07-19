# polyteknix refactor — design

Date: 2026-07-20
Status: approved (pending spec review)

## Goal

Rebuild `polyteknix` as a thin application on top of the `piteknix` hardware
abstraction library. Develop and run fully in virtual mode on a dev machine,
deploy unchanged to the Raspberry Pi in the polytunnel. This refactor doubles
as the **first real integration test of `piteknix`** — every lib capability
the app exercises gains a regression test, filling the lib's current zero-test
gap.

## Context

- `piteknix` (`~/Sites/worldofpi/piteknix`) — hardware abstraction lib. Virtual
  + hardware auto-detect, redux-friendly (listener middleware), terminal
  display rendering, keyboard-as-buttons. Proven to run in virtual mode. No
  tests yet.
- `polyteknix` current state: `redux-build.js` is a half-done redux port that
  still drives the display on a `setInterval` loop. `app.js` is older. Both
  talk to hardware directly.
- Consumed as a **local file dependency** (`file:../piteknix`). Work happens in
  place in the existing `polyteknix` git repo; history preserved.

## Non-goals

- TIMER and MESSAGE display modes (unfinished stubs in `redux-build.js`) are
  **dropped** — only the stubs, not the mode system itself. Modes DEFAULT and
  DIAG ship working (see Display modes). Re-add TIMER/MESSAGE later if wanted.
- No monorepo migration. Empty `PiTeknix/` dir stays unused for now.
- Music-streaming Pi, bathroom device, sensor-platform device — out of scope;
  separate specs later.

## Architecture

Thin app over `piteknix`. Redux Toolkit store + listener middleware. State
change triggers render — **no display loop**.

```
sensors (poll) ──dispatch──> store ──listener middleware──> render LCD
buttons ─────────dispatch──> store ──listener────────────> mode / actions
                             store ──interval─────────────> push to iotplotter
```

Env auto-detect: `VIRTUAL_MODE=true node app.js` on laptop (terminal LCD,
keyboard buttons, simulated sensors); on Pi, real hardware. Faster poll
interval in virtual mode.

## Hardware map

| Role      | Device   | Bus / pin            | Lib call                              |
|-----------|----------|----------------------|---------------------------------------|
| Internal  | AHT20    | I2C                  | `createSensor({type:'aht20'})` temp+humidity, `calibrationOffset: 1.2` |
| External  | DS18B20  | 1-wire `28-0301a279e8e6` | `createSensor({type:'ds18b20'})` — **currently failed (mechanical)** |
| Display   | LCD 16x2 | I2C `0x27`           | `createDisplay({type:'lcd', width:16, height:2})` |
| Button    | —        | GPIO 27              | `createButton({gpio:27, virtualKey:'1'})` |
| LED       | —        | GPIO 17              | `createLed({gpio:17})` |
| Data push | iotplotter | HTTP               | `axios` POST, api-key from env |

## State shape

```js
{
  data: {
    temperature_internal: null,   // AHT20, calibrated
    temperature_external: null,   // DS18B20 — null while sensor dead
    humidity_internal:    null,   // AHT20
    pressure:             null,   // reserved (no sensor yet)
  },
  display: {
    mode: 'DEFAULT',              // cycles through displayModes (see below)
    isBacklit: false,
  },
  sensors: {
    external_status: 'unknown',   // 'ok' | 'absent' | 'error' | 'unknown'
    external_diagnostic: null,    // human-readable last diagnosis
  },
}
```

Action types: `data/temperature/internal`, `data/temperature/external`,
`data/humidity/internal`, `sensors/external/status`, `display/next`.

## Display modes

Per `REDUX-SPEC.md`, modes live in a `displayModes` array and the button
cycles through them with `getNextMode`. Two modes for the 16x2:

- `DEFAULT` — live readings.
- `DIAG` — external-sensor diagnosis, surfaced on the LCD itself (not just logs).

```js
const displayModes = ["DEFAULT", "DIAG"];
const getNextMode = (mode) => displayModes[(displayModes.indexOf(mode) + 1) % displayModes.length];
```

The single hardware button (GPIO 27) dispatches `display/next`; the reducer
advances `display.mode`; a listener re-renders. (redux-build.js used GPIO 27
for the button and GPIO 17 for the on-LED — one button, so cycling walks the
mode list.)

## Render

Per-mode pure render functions with the spec's signature `(state, display)`,
plus a `renderDisplay(state, display)` dispatcher that switches on
`state.display.mode`. Listener middleware subscribes to `data/*`, `sensors/*`
and `display/next` actions and calls `renderDisplay`. The `displayLoop`
setInterval is removed entirely.

DEFAULT layout on the 16x2:

```
int: 21.4c 63%
ext: -- (absent)
```

`ext:` shows the value when present, or `--` plus a short status token when the
external sensor is unavailable.

DIAG layout — the external sensor diagnosis:

```
ext: absent
no devices on bus
```

Line 0 is `ext: <external_status>`; line 1 is the diagnostic detail truncated
to 16 chars.

## Dead external sensor + diagnostics (new capability)

The polytunnel's external DS18B20 currently fails — suspected mechanical /
connection. Two requirements:

1. **Graceful degradation.** App keeps `temperature_external` in state as
   `null`, display shows `--`, polling does not crash or spam. When the sensor
   is physically reattached it resumes with **zero code change**.

2. **Software diagnostics** — because hardware/wiring is the hard part, the
   platform should help diagnose *why* the sensor is failing. Add a
   `diagnose()` method to the `piteknix` ds18b20 sensor that reports:

   | Observation | Likely cause | Reported status |
   |---|---|---|
   | 1-wire bus lists no devices | w1 not enabled, no pull-up, or bus dead | `absent` |
   | Bus lists devices but target id missing | wrong id, or that sensor disconnected | `absent` |
   | Target present, read returns `ENOENT` | device dropped off bus mid-read | `error` |
   | Reads exactly `85.0°C` | power-on default — loose data line / parasitic-power / bad connection | `error` (flagged) |
   | CRC / malformed read | noisy or marginal wiring | `error` |
   | Valid varying reads | healthy | `ok` |

   `diagnose()` returns `{ status, detail, busDevices, targetPresent,
   lastError }`. App dispatches `sensors/external/status` with the result;
   the diagnostic string is loggable and surfaceable on the display / iotplotter.

   In **virtual mode**, `diagnose()` is configurable so the failure path can be
   developed and tested without real broken hardware (e.g. simulate `absent`,
   `85.0` reading, ENOENT).

## Data push

Keep the iotplotter POST (feed `408491097864656092`). Push internal temp,
internal humidity, external temp (null-safe), and external status/diagnostic.
Poll and push on the same cadence as today (5 min hardware; faster virtual).

## Security (must-fix, this refactor)

`redux-build.js:5` hardcodes a live iotplotter api-key, committed to the public
`github.com/varffs/polyteknix` repo.

1. Rotate the key at iotplotter (old one is compromised — treat as burned).
2. Load from `process.env.IOTPLOTTER_KEY`; provide `.env.example`, gitignore
   `.env`.
3. Scrub the key from git history (`git filter-repo` or BFG) and force-push.

## Testing

The refactor drives lib hardening. Add `piteknix/src/**/*.test.js` covering
each capability polyteknix exercises:

- aht20 virtual sensor: read returns temp + humidity; calibration offset applied.
- lcd 16x2 virtual: `printLine` clamps to width, renders expected buffer.
- ds18b20 failure: `read()` on absent sensor returns null / does not throw.
- ds18b20 `diagnose()`: each status heuristic (absent / 85.0 / ENOENT / ok)
  returns the correct classification (using virtual simulation).
- button: `simulatePress` fires the watch callback.

Bugs found while porting become lib fixes + a regression test each.

## Deliverables

1. `piteknix`: `diagnose()` on ds18b20 (+ virtual simulation hooks); any fixes
   surfaced during integration; the test suite above.
2. `polyteknix`: new `app.js` on `piteknix`; `file:../piteknix` dep; `.env`
   handling; stub modes removed; old `redux-build.js` / dead `app.js` retired.
3. Security: key rotated, env-loaded, history scrubbed.
4. Verified running in virtual mode end to end; ready to deploy to the Pi.
