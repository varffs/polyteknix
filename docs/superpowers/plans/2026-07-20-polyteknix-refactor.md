# polyteknix Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `polyteknix` as a thin, virtual-first application on the `piteknix` hardware abstraction library, driving its LCD via redux listener middleware (no display loop), with software diagnostics for the dead external DS18B20 sensor.

**Architecture:** `polyteknix/app.js` composes a Redux Toolkit store whose listener middleware re-renders the LCD on state change. Sensors/display/inputs come from `piteknix` (auto-detects virtual vs Pi hardware). The refactor is also the first integration test of `piteknix`: every capability the app touches gains a `node --test` regression test in the lib.

**Tech Stack:** Node.js ESM, `@reduxjs/toolkit` v2 (listener middleware), `piteknix` (local `file:` dep), `axios` (iotplotter push), `node --test` + `node:assert/strict`.

## Global Constraints

- ESM only — both packages have `"type": "module"`. Use `import`, top-level `await` allowed.
- Node `>=18`. Tests run via `node --test`; test files named `*.test.js`; assertions via `node:assert/strict`.
- Redux Toolkit **v2** named imports: `import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";`. polyteknix currently pins v1.9.5 with a `pkg` default-import hack — replace it.
- **No secrets in source.** iotplotter api-key comes from `process.env.IOTPLOTTER_KEY`. `.env` is gitignored; `.env.example` documents keys.
- `polyteknix` consumes `piteknix` via `file:../piteknix`.
- Render is **listener-driven** — no `setInterval` display loop anywhere.
- Deterministic tests: drive virtual sensors with `min === max` configs so generated values are exact.
- piteknix is currently NOT a git repo — Task 1 initializes it. Commit lib tasks in `piteknix`, app tasks in `polyteknix` (branch `refactor/piteknix-integration`).

---

### Task 1: Initialize piteknix repo + terminal-LCD testability

**Files:**
- Init: `~/Sites/worldofpi/piteknix/.git`
- Modify: `~/Sites/worldofpi/piteknix/src/displays/terminal.js` (add `getLines()` to terminal-lcd return object, ~line 92)
- Test: `~/Sites/worldofpi/piteknix/src/displays/terminal.test.js`

**Interfaces:**
- Produces: terminal-lcd instance gains `getLines(): string[]` — returns a copy of the current buffer (one padded string per row). Enables asserting rendered content without scraping stdout.

- [ ] **Step 1: Ensure piteknix is a git repo**

```bash
cd ~/Sites/worldofpi/piteknix
git rev-parse --is-inside-work-tree 2>/dev/null || git init
git add -A && git commit -q -m "chore: baseline piteknix before integration hardening" || echo "nothing to commit"
```

- [ ] **Step 2: Write the failing test**

Create `src/displays/terminal.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerminalDisplay } from "./terminal.js";

test("terminal lcd printLine truncates and pads to width", async () => {
  const lcd = await createTerminalDisplay({ type: "lcd", width: 16, height: 2 });
  lcd.printLine(0, "hello");
  lcd.printLine(1, "this is way too long for sixteen chars");
  const lines = lcd.getLines();
  assert.equal(lines[0], "hello".padEnd(16));
  assert.equal(lines[1], "this is way too l"); // NOTE: replaced below
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/Sites/worldofpi/piteknix && node --test src/displays/terminal.test.js`
Expected: FAIL — `lcd.getLines is not a function`.

- [ ] **Step 4: Add `getLines()` to terminal-lcd**

In `src/displays/terminal.js`, inside the object returned by `createTerminalLcd` (alongside `clear`, `printLine`), add:

```js
    getLines() {
      return buffer.slice();
    },
```

- [ ] **Step 5: Fix the test assertion to the real width (16)**

Replace the second assertion so it matches `substring(0,16)`:

```js
  assert.equal(lines[1], "this is way too ".padEnd(16)); // 16 chars, no pad needed
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test src/displays/terminal.test.js`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
cd ~/Sites/worldofpi/piteknix
git add src/displays/terminal.js src/displays/terminal.test.js
git commit -m "test: cover terminal lcd width clamp; add getLines accessor"
```

---

### Task 2: Regression test — AHT20 virtual sensor (internal sensor)

**Files:**
- Test: `~/Sites/worldofpi/piteknix/src/sensors/sensors.test.js`

**Interfaces:**
- Consumes: `createSensor({ type, calibrationOffset, virtual })` from `src/sensors/index.js`. Virtual aht20 `read()` resolves `{ temperature, humidity }`, with `calibrationOffset` added to temperature.

- [ ] **Step 1: Write the failing test**

Create `src/sensors/sensors.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSensor } from "./index.js";

// Force virtual mode regardless of host
process.env.VIRTUAL_MODE = "true";

test("aht20 virtual read applies calibration offset and returns humidity", async () => {
  const sensor = await createSensor({
    type: "aht20",
    calibrationOffset: 1.2,
    virtual: {
      temperature: { min: 20, max: 20, initialValue: 20 },
      humidity: { min: 50, max: 50 },
    },
  });
  const data = await sensor.read();
  assert.equal(data.temperature, 21.2); // 20 + 1.2
  assert.equal(data.humidity, 50);
  await sensor.cleanup();
});
```

- [ ] **Step 2: Run test to verify it passes (documents existing behavior)**

Run: `cd ~/Sites/worldofpi/piteknix && node --test src/sensors/sensors.test.js`
Expected: PASS. (This is a regression guard on current lib behavior — if it fails, the drift/humidity generators changed; investigate before proceeding.)

- [ ] **Step 3: Commit**

```bash
cd ~/Sites/worldofpi/piteknix
git add src/sensors/sensors.test.js
git commit -m "test: aht20 virtual read offset + humidity (deterministic)"
```

---

### Task 3: DS18B20 virtual fault simulation (dead-sensor path)

**Files:**
- Modify: `~/Sites/worldofpi/piteknix/src/sensors/virtual.js`
- Test: `~/Sites/worldofpi/piteknix/src/sensors/sensors.test.js` (append)

**Interfaces:**
- Produces: `createSensor`/`createVirtualSensor` accept `config.virtual.fault`: `"absent" | "enoent" | "stuck85" | null`.
  - `"enoent"` → `read()` rejects with an error whose `.code === "ENOENT"`.
  - `"stuck85"` → `read()` resolves `{ temperature: 85 }` (raw power-on default; calibration offset NOT applied to the fault value).
  - `"absent"` → `read()` rejects with `.code === "ENOENT"`; `listSensors()` resolves `[]`.
  - falsy/absent → normal drift behavior (unchanged).

- [ ] **Step 1: Write the failing tests (append to sensors.test.js)**

```js
test("ds18b20 virtual fault 'enoent' makes read reject with ENOENT", async () => {
  const sensor = await createSensor({
    type: "ds18b20",
    virtual: { fault: "enoent" },
  });
  await assert.rejects(() => sensor.read(), (err) => err.code === "ENOENT");
  await sensor.cleanup();
});

test("ds18b20 virtual fault 'stuck85' returns raw 85.0", async () => {
  const sensor = await createSensor({
    type: "ds18b20",
    calibrationOffset: 1.2,
    virtual: { fault: "stuck85" },
  });
  const data = await sensor.read();
  assert.equal(data.temperature, 85); // raw, offset not applied to fault
  await sensor.cleanup();
});

test("ds18b20 virtual fault 'absent' lists no sensors", async () => {
  const sensor = await createSensor({
    type: "ds18b20",
    virtual: { fault: "absent" },
  });
  assert.deepEqual(await sensor.listSensors(), []);
  await assert.rejects(() => sensor.read(), (err) => err.code === "ENOENT");
  await sensor.cleanup();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/sensors/sensors.test.js`
Expected: FAIL — fault ignored, `read()` resolves normally.

- [ ] **Step 3: Implement fault handling in `createVirtualSensor`**

In `src/sensors/virtual.js`, destructure `fault` and branch `read`/`listSensors`. Replace the return object's `read` and `listSensors` with fault-aware versions:

```js
export const createVirtualSensor = async (config) => {
  const { type, virtual = {}, calibrationOffset = 0 } = config;
  const { fault = null } = virtual;

  // ... existing defaults / generator setup unchanged ...

  const enoent = () => Object.assign(new Error("ENOENT: sensor not found"), { code: "ENOENT" });

  return {
    type: `virtual-${type}`,
    isVirtual: true,
    fault,

    async read() {
      if (fault === "enoent" || fault === "absent") throw enoent();
      if (fault === "stuck85") return { temperature: 85 };

      const result = { temperature: tempGenerator() + calibrationOffset };
      if (humidityGenerator) result.humidity = humidityGenerator();
      if (pressureGenerator) result.pressure = pressureGenerator();
      return result;
    },

    async readTemperature() {
      const data = await this.read();
      return data.temperature;
    },

    async readHumidity() {
      if (!humidityGenerator) throw new Error(`Sensor type ${type} does not support humidity`);
      return humidityGenerator();
    },

    async readPressure() {
      if (!pressureGenerator) throw new Error(`Sensor type ${type} does not support pressure`);
      return pressureGenerator();
    },

    async listSensors() {
      return fault === "absent" ? [] : ["virtual-sensor-001"];
    },

    async cleanup() {},
  };
};
```

(Keep the existing generator-setup lines above the `return`; only the returned methods change.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/sensors/sensors.test.js`
Expected: PASS (4 tests total in file).

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/worldofpi/piteknix
git add src/sensors/virtual.js src/sensors/sensors.test.js
git commit -m "feat: virtual ds18b20 fault simulation (enoent/absent/stuck85)"
```

---

### Task 4: DS18B20 `diagnose()` — virtual + hardware

**Files:**
- Modify: `~/Sites/worldofpi/piteknix/src/sensors/virtual.js` (add `diagnose` to returned object)
- Modify: `~/Sites/worldofpi/piteknix/src/sensors/index.js` (add `diagnose` to `createDs18b20Sensor` return)
- Test: `~/Sites/worldofpi/piteknix/src/sensors/sensors.test.js` (append)

**Interfaces:**
- Produces: ds18b20 sensor (virtual and hardware) gains `async diagnose(): Promise<Diagnosis>` where
  `Diagnosis = { status, detail, busDevices, targetPresent, lastError }`,
  `status ∈ "ok" | "absent" | "error"`, `detail` is a human-readable string, `busDevices` is a string[] of 1-wire ids, `targetPresent` is boolean, `lastError` is `{ code, message } | null`.
  Classification rules:
  - no devices on bus → `absent`, detail "no devices on 1-wire bus (check w1 enabled / data-line pull-up)"
  - devices present but target id missing → `absent`, detail "target <id> not on bus (wrong id or sensor disconnected)"
  - read throws ENOENT → `error`, detail "device dropped off bus during read (loose connection)"
  - read returns ~85.0 → `error`, detail "reads 85.0 power-on default — check power / data line / parasitic power"
  - read returns other CRC/throw → `error`, detail from error message
  - read returns a plausible value → `ok`, detail "reading <v>c"

- [ ] **Step 1: Write the failing tests (append to sensors.test.js)**

```js
test("diagnose: healthy virtual ds18b20 -> ok", async () => {
  const s = await createSensor({ type: "ds18b20", id: "28-x", virtual: { temperature: { min: 22, max: 22, initialValue: 22 } } });
  const d = await s.diagnose();
  assert.equal(d.status, "ok");
  assert.equal(d.targetPresent, true);
});

test("diagnose: absent -> status absent, empty bus", async () => {
  const s = await createSensor({ type: "ds18b20", id: "28-x", virtual: { fault: "absent" } });
  const d = await s.diagnose();
  assert.equal(d.status, "absent");
  assert.deepEqual(d.busDevices, []);
  assert.equal(d.targetPresent, false);
});

test("diagnose: stuck85 -> error flagged for wiring/power", async () => {
  const s = await createSensor({ type: "ds18b20", id: "28-x", virtual: { fault: "stuck85" } });
  const d = await s.diagnose();
  assert.equal(d.status, "error");
  assert.match(d.detail, /85\.0/);
});

test("diagnose: enoent -> error, dropped off bus", async () => {
  const s = await createSensor({ type: "ds18b20", id: "28-x", virtual: { fault: "enoent" } });
  const d = await s.diagnose();
  assert.equal(d.status, "error");
  assert.equal(d.lastError.code, "ENOENT");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/sensors/sensors.test.js`
Expected: FAIL — `s.diagnose is not a function`.

- [ ] **Step 3: Add a shared classifier + wire into virtual sensor**

Create `src/sensors/diagnose.js`:

```js
/**
 * Classify a ds18b20 diagnosis from raw observations.
 * @param {Object} o
 * @param {string} o.id            - target sensor id
 * @param {string[]} o.busDevices  - ids present on the 1-wire bus
 * @param {number|null} o.reading  - raw temperature read (offset NOT applied), or null if read failed
 * @param {{code?:string,message?:string}|null} o.error - read error if any
 * @returns {{status:string,detail:string,busDevices:string[],targetPresent:boolean,lastError:object|null}}
 */
export const classifyDs18b20 = ({ id, busDevices, reading, error }) => {
  const targetPresent = !!id && busDevices.includes(id);
  const lastError = error ? { code: error.code ?? null, message: error.message ?? String(error) } : null;

  if (busDevices.length === 0) {
    return { status: "absent", detail: "no devices on 1-wire bus (check w1 enabled / data-line pull-up)", busDevices, targetPresent, lastError };
  }
  if (id && !targetPresent) {
    return { status: "absent", detail: `target ${id} not on bus (wrong id or sensor disconnected)`, busDevices, targetPresent, lastError };
  }
  if (error) {
    if (error.code === "ENOENT") {
      return { status: "error", detail: "device dropped off bus during read (loose connection)", busDevices, targetPresent, lastError };
    }
    return { status: "error", detail: `read error: ${error.message ?? error}`, busDevices, targetPresent, lastError };
  }
  if (reading !== null && Math.abs(reading - 85) < 0.05) {
    return { status: "error", detail: "reads 85.0 power-on default — check power / data line / parasitic power", busDevices, targetPresent, lastError };
  }
  return { status: "ok", detail: `reading ${reading}c`, busDevices, targetPresent, lastError };
};
```

In `src/sensors/virtual.js`, add to the returned object (virtual sensor knows its own fault, so it can build the observation set):

```js
    async diagnose() {
      const { classifyDs18b20 } = await import("./diagnose.js");
      const busDevices = await this.listSensors();
      let reading = null;
      let error = null;
      try {
        const data = await this.read();
        reading = data.temperature;
      } catch (e) {
        error = e;
      }
      return classifyDs18b20({ id: config.id, busDevices, reading, error });
    },
```

- [ ] **Step 4: Wire into hardware ds18b20**

In `src/sensors/index.js`, add to the object returned by `createDs18b20Sensor` (uses the existing `listSensors`/`read`):

```js
    async diagnose() {
      const { classifyDs18b20 } = await import("./diagnose.js");
      let busDevices = [];
      try {
        busDevices = await this.listSensors();
      } catch (e) {
        return { status: "error", detail: `1-wire bus error: ${e.message}`, busDevices: [], targetPresent: false, lastError: { code: e.code ?? null, message: e.message } };
      }
      let reading = null;
      let error = null;
      try {
        // read() adds calibrationOffset; subtract it back for raw 85.0 detection
        const raw = await new Promise((res, rej) => this._rawRead ? this._rawRead(res, rej) : rej(new Error("no raw read")));
        reading = raw;
      } catch (e) {
        error = e;
      }
      return classifyDs18b20({ id: sensorId, busDevices, reading, error });
    },
```

To provide a raw (offset-free) read for diagnosis, also add `_rawRead` to the same return object:

```js
    _rawRead(resolve, reject) {
      ds18b20.temperature(sensorId, (err, value) => (err ? reject(err) : resolve(value)));
    },
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test src/sensors/sensors.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 6: Commit**

```bash
cd ~/Sites/worldofpi/piteknix
git add src/sensors/diagnose.js src/sensors/virtual.js src/sensors/index.js src/sensors/sensors.test.js
git commit -m "feat: ds18b20 diagnose() with wiring/power heuristics + tests"
```

---

### Task 5: Regression test — virtual button simulatePress

**Files:**
- Test: `~/Sites/worldofpi/piteknix/src/inputs/inputs.test.js`

**Interfaces:**
- Consumes: `createButton({ gpio, virtualKey })` → virtual button with `watch(cb)` and `simulatePress()`. `simulatePress()` invokes registered watchers with `(null, 1)`.

- [ ] **Step 1: Write the failing test**

Create `src/inputs/inputs.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createButton } from "./index.js";

process.env.VIRTUAL_MODE = "true";

test("virtual button simulatePress fires watcher with rising edge", async () => {
  const button = createButton({ gpio: 27, virtualKey: "1" });
  let fired = null;
  button.watch((err, value) => { fired = { err, value }; });
  button.simulatePress();
  assert.deepEqual(fired, { err: null, value: 1 });
  await button.cleanup();
});
```

- [ ] **Step 2: Run to verify pass**

Run: `cd ~/Sites/worldofpi/piteknix && node --test src/inputs/inputs.test.js`
Expected: PASS. (Regression guard on existing behavior.)

- [ ] **Step 3: Run the full lib suite**

Run: `node --test 'src/**/*.test.js'`
Expected: PASS — all files (terminal, sensors, inputs).

- [ ] **Step 4: Commit**

```bash
cd ~/Sites/worldofpi/piteknix
git add src/inputs/inputs.test.js
git commit -m "test: virtual button simulatePress fires watcher"
```

---

### Task 6: polyteknix — file dep + secret-free config

**Files:**
- Modify: `~/Sites/worldofpi/polyteknix/package.json` (toolkit v2, add `piteknix` file dep, `dotenv`, test script)
- Create: `~/Sites/worldofpi/polyteknix/.env.example`
- Modify: `~/Sites/worldofpi/polyteknix/.gitignore` (ensure `.env`, `node_modules`)
- Create: `~/Sites/worldofpi/polyteknix/src/config.js`
- Test: `~/Sites/worldofpi/polyteknix/src/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env)` from `src/config.js` → `{ iotplotterKey, feedId, pollMs, tempCalibrationOffset, externalSensorId }`. Throws if `IOTPLOTTER_KEY` missing AND `env.VIRTUAL_MODE !== "true"` (virtual runs allowed without a key; hardware runs require it).

- [ ] **Step 1: Update package.json**

Set `dependencies` to (replacing the toolkit v1 pin):

```json
  "dependencies": {
    "@reduxjs/toolkit": "^2.11.2",
    "axios": "^1.4.0",
    "dotenv": "^16.4.0",
    "piteknix": "file:../piteknix"
  },
```

Set scripts:

```json
  "scripts": {
    "start": "node app.js",
    "dev": "VIRTUAL_MODE=true node app.js",
    "test": "node --test 'src/**/*.test.js'"
  },
```

- [ ] **Step 2: Install**

Run: `cd ~/Sites/worldofpi/polyteknix && npm install`
Expected: installs toolkit v2, axios, dotenv, and links `piteknix`. Verify: `node -e "import('piteknix').then(m=>console.log(typeof m.createSensor))"` prints `function`.

- [ ] **Step 3: gitignore + .env.example**

Ensure `.gitignore` contains:

```
node_modules
.env
```

Create `.env.example`:

```
# iotplotter feed api-key — get a fresh one from iotplotter.com (old committed key is burned)
IOTPLOTTER_KEY=
```

- [ ] **Step 4: Write the failing test**

Create `src/config.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("loadConfig reads key from env", () => {
  const cfg = loadConfig({ IOTPLOTTER_KEY: "abc", VIRTUAL_MODE: "false" });
  assert.equal(cfg.iotplotterKey, "abc");
  assert.equal(cfg.feedId, "408491097864656092");
});

test("loadConfig throws on missing key in hardware mode", () => {
  assert.throws(() => loadConfig({ VIRTUAL_MODE: "false" }), /IOTPLOTTER_KEY/);
});

test("loadConfig allows missing key in virtual mode", () => {
  const cfg = loadConfig({ VIRTUAL_MODE: "true" });
  assert.equal(cfg.iotplotterKey, null);
});
```

- [ ] **Step 5: Run to verify failure**

Run: `node --test src/config.test.js`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 6: Implement config.js**

```js
export const loadConfig = (env = process.env) => {
  const isVirtual = env.VIRTUAL_MODE === "true";
  const iotplotterKey = env.IOTPLOTTER_KEY || null;
  if (!iotplotterKey && !isVirtual) {
    throw new Error("IOTPLOTTER_KEY is required in hardware mode (set it in .env)");
  }
  return {
    iotplotterKey,
    feedId: "408491097864656092",
    pollMs: isVirtual ? 3000 : 1000 * 60 * 5,
    tempCalibrationOffset: 1.2,
    externalSensorId: "28-0301a279e8e6",
  };
};
```

- [ ] **Step 7: Run to verify pass**

Run: `node --test src/config.test.js`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
cd ~/Sites/worldofpi/polyteknix
git add package.json package-lock.json .gitignore .env.example src/config.js src/config.test.js
git commit -m "feat: piteknix file dep, toolkit v2, secret-free config module"
```

---

### Task 7: polyteknix — store + reducer

**Files:**
- Create: `~/Sites/worldofpi/polyteknix/src/store.js`
- Test: `~/Sites/worldofpi/polyteknix/src/store.test.js`

**Interfaces:**
- Produces: `initialState`, `appReducer`, `displayModes`, `getNextMode`, and action-creator helpers from `src/store.js`:
  - `setInternalTemp(v)` → `{ type: "data/temperature/internal", payload: v }`
  - `setExternalTemp(v)` → `{ type: "data/temperature/external", payload: v }`
  - `setInternalHumidity(v)` → `{ type: "data/humidity/internal", payload: v }`
  - `setExternalStatus({status, detail})` → `{ type: "sensors/external/status", payload }`
  - `nextMode()` → `{ type: "display/next" }` (reducer advances `display.mode` via `getNextMode`)
  - `displayModes = ["DEFAULT", "DIAG"]`; `getNextMode(mode)` returns the next mode, cycling.
  - State shape per spec: `{ data:{temperature_internal,temperature_external,humidity_internal,pressure}, display:{mode:"DEFAULT",isBacklit:false}, sensors:{external_status:"unknown",external_diagnostic:null} }`

- [ ] **Step 1: Write the failing test**

Create `src/store.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { appReducer, initialState, setInternalTemp, setExternalStatus } from "./store.js";

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

test("display/next cycles DEFAULT -> DIAG -> DEFAULT", () => {
  const s1 = appReducer(initialState, nextMode());
  assert.equal(s1.display.mode, "DIAG");
  const s2 = appReducer(s1, nextMode());
  assert.equal(s2.display.mode, "DEFAULT");
});
```

(Add `nextMode` to the import line at the top of the test:
`import { appReducer, initialState, setInternalTemp, setExternalStatus, nextMode } from "./store.js";`)

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/Sites/worldofpi/polyteknix && node --test src/store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement store.js**

```js
export const initialState = {
  data: {
    temperature_internal: null,
    temperature_external: null,
    humidity_internal: null,
    pressure: null,
  },
  display: { mode: "DEFAULT", isBacklit: false },
  sensors: { external_status: "unknown", external_diagnostic: null },
};

export const displayModes = ["DEFAULT", "DIAG"];
export const getNextMode = (mode) =>
  displayModes[(displayModes.indexOf(mode) + 1) % displayModes.length];

export const setInternalTemp = (v) => ({ type: "data/temperature/internal", payload: v });
export const setExternalTemp = (v) => ({ type: "data/temperature/external", payload: v });
export const setInternalHumidity = (v) => ({ type: "data/humidity/internal", payload: v });
export const setExternalStatus = (payload) => ({ type: "sensors/external/status", payload });
export const nextMode = () => ({ type: "display/next" });

export function appReducer(state = initialState, action) {
  switch (action.type) {
    case "data/temperature/internal":
      return { ...state, data: { ...state.data, temperature_internal: action.payload } };
    case "data/temperature/external":
      return { ...state, data: { ...state.data, temperature_external: action.payload } };
    case "data/humidity/internal":
      return { ...state, data: { ...state.data, humidity_internal: action.payload } };
    case "sensors/external/status":
      return {
        ...state,
        sensors: {
          ...state.sensors,
          external_status: action.payload.status,
          external_diagnostic: action.payload.detail,
        },
      };
    case "display/next":
      return { ...state, display: { ...state.display, mode: getNextMode(state.display.mode) } };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/store.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/worldofpi/polyteknix
git add src/store.js src/store.test.js
git commit -m "feat: redux state shape + reducer with external sensor status"
```

---

### Task 8: polyteknix — render (pure formatter + LCD writer)

**Files:**
- Create: `~/Sites/worldofpi/polyteknix/src/render.js`
- Test: `~/Sites/worldofpi/polyteknix/src/render.test.js`

**Interfaces:**
- Consumes: `formatFloat` from `piteknix`; state shape + `display.mode` from Task 7.
- Produces:
  - `formatDataLines(state)` → `[string, string]` — DEFAULT mode, pure. Line 0: `int: <t>c <h>%`. Line 1: `ext: <t>c` when `temperature_external` is a number, else `ext: -- (<external_status>)`.
  - `formatDiagLines(state)` → `[string, string]` — DIAG mode, pure. Line 0: `ext: <external_status>`. Line 1: `external_diagnostic` truncated to 16 chars (or `""`).
  - `renderDisplay(state, display)` — dispatcher (spec signature `(state, display)`): clears display, then writes the two lines for the current `state.display.mode` via `display.printLine`. Unknown mode falls back to DEFAULT.

- [ ] **Step 1: Write the failing test**

Create `src/render.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDataLines, formatDiagLines } from "./render.js";
import { initialState } from "./store.js";

test("DEFAULT formats internal + external when both present", () => {
  const state = { ...initialState, data: { ...initialState.data, temperature_internal: 21.44, humidity_internal: 63.2, temperature_external: 12.8 } };
  const [l0, l1] = formatDataLines(state);
  assert.equal(l0, "int: 21.4c 63.2%");
  assert.equal(l1, "ext: 12.8c");
});

test("DEFAULT shows -- and status when external absent", () => {
  const state = { ...initialState, data: { ...initialState.data, temperature_internal: 20, humidity_internal: 50 }, sensors: { external_status: "absent", external_diagnostic: "x" } };
  const [, l1] = formatDataLines(state);
  assert.equal(l1, "ext: -- (absent)");
});

test("DIAG shows status + truncated diagnostic", () => {
  const state = { ...initialState, sensors: { external_status: "absent", external_diagnostic: "no devices on 1-wire bus (check pull-up)" } };
  const [l0, l1] = formatDiagLines(state);
  assert.equal(l0, "ext: absent");
  assert.equal(l1, "no devices on 1-"); // 16 chars
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/render.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement render.js**

```js
import { formatFloat } from "piteknix";

export const formatDataLines = (state) => {
  const { data, sensors } = state;
  const line0 = `int: ${formatFloat(data.temperature_internal)}c ${formatFloat(data.humidity_internal)}%`;
  const line1 =
    typeof data.temperature_external === "number"
      ? `ext: ${formatFloat(data.temperature_external)}c`
      : `ext: -- (${sensors.external_status})`;
  return [line0, line1];
};

export const formatDiagLines = (state) => {
  const { sensors } = state;
  const line0 = `ext: ${sensors.external_status}`;
  const line1 = (sensors.external_diagnostic || "").substring(0, 16);
  return [line0, line1];
};

const MODE_FORMATTERS = {
  DEFAULT: formatDataLines,
  DIAG: formatDiagLines,
};

export const renderDisplay = (state, display) => {
  const formatter = MODE_FORMATTERS[state.display.mode] || formatDataLines;
  const [line0, line1] = formatter(state);
  display.clear();
  display.printLine(0, line0);
  display.printLine(1, line1);
};
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/render.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/worldofpi/polyteknix
git add src/render.js src/render.test.js
git commit -m "feat: listener render — pure line formatter + lcd writer"
```

---

### Task 9: polyteknix — iotplotter payload builder (null-safe)

**Files:**
- Create: `~/Sites/worldofpi/polyteknix/src/push.js`
- Test: `~/Sites/worldofpi/polyteknix/src/push.test.js`

**Interfaces:**
- Produces:
  - `buildPayload(state)` → iotplotter `{ data: {...} }` object. Omits a feed field when its value is `null` (iotplotter rejects null values). Includes `External_Temperature` only when numeric; always includes `External_Status` as a string.
  - `pushData(axiosInstance, { feedId, key }, state)` → posts `buildPayload(state)`; no-op (returns `null`) when `key` is falsy (virtual mode without a key).

- [ ] **Step 1: Write the failing test**

Create `src/push.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, pushData } from "./push.js";
import { initialState } from "./store.js";

test("payload omits null fields, keeps status", () => {
  const state = { ...initialState, data: { ...initialState.data, temperature_internal: 20, humidity_internal: 50, temperature_external: null }, sensors: { external_status: "absent", external_diagnostic: "x" } };
  const p = buildPayload(state);
  assert.ok(p.data.Internal_Temperature);
  assert.ok(p.data.Internal_Humidity);
  assert.equal(p.data.External_Temperature, undefined);
  assert.equal(p.data.External_Status[0].value, "absent");
});

test("pushData is a no-op without a key", async () => {
  let called = false;
  const fakeAxios = { post: async () => { called = true; } };
  const res = await pushData(fakeAxios, { feedId: "f", key: null }, initialState);
  assert.equal(res, null);
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/push.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement push.js**

```js
export const buildPayload = (state) => {
  const { data, sensors } = state;
  const feed = {};
  if (data.temperature_internal !== null) feed.Internal_Temperature = [{ value: data.temperature_internal }];
  if (data.humidity_internal !== null) feed.Internal_Humidity = [{ value: data.humidity_internal }];
  if (typeof data.temperature_external === "number") feed.External_Temperature = [{ value: data.temperature_external }];
  feed.External_Status = [{ value: sensors.external_status }];
  return { data: feed };
};

export const pushData = async (axiosInstance, { feedId, key }, state) => {
  if (!key) return null;
  return axiosInstance.post(`http://iotplotter.com/api/v2/feed/${feedId}`, buildPayload(state), {
    headers: { "api-key": key },
  });
};
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/push.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/worldofpi/polyteknix
git add src/push.js src/push.test.js
git commit -m "feat: null-safe iotplotter payload builder + keyless no-op push"
```

---

### Task 10: polyteknix — sensor polling with graceful external + diagnose

**Files:**
- Create: `~/Sites/worldofpi/polyteknix/src/sensors.js`
- Test: `~/Sites/worldofpi/polyteknix/src/sensors.test.js`

**Interfaces:**
- Consumes: `createSensor` from `piteknix`; store action creators from Task 7.
- Produces: `pollExternal(sensor, dispatch)` — reads the external DS18B20; on success dispatches `setExternalTemp(value)` + `setExternalStatus({status:"ok",...})`; on failure dispatches `setExternalTemp(null)` + `setExternalStatus(await sensor.diagnose())`. Never throws.
- Produces: `pollInternal(sensor, dispatch)` — reads AHT20, dispatches internal temp + humidity; on failure dispatches nothing and logs.

- [ ] **Step 1: Write the failing test**

Create `src/sensors.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
process.env.VIRTUAL_MODE = "true";
const { createSensor } = await import("piteknix");
const { pollExternal } = await import("./sensors.js");

test("pollExternal on dead sensor dispatches null temp + diagnosis", async () => {
  const sensor = await createSensor({ type: "ds18b20", id: "28-0301a279e8e6", virtual: { fault: "absent" } });
  const actions = [];
  await pollExternal(sensor, (a) => actions.push(a));
  const temp = actions.find((a) => a.type === "data/temperature/external");
  const status = actions.find((a) => a.type === "sensors/external/status");
  assert.equal(temp.payload, null);
  assert.equal(status.payload.status, "absent");
});

test("pollExternal on healthy sensor dispatches numeric temp + ok", async () => {
  const sensor = await createSensor({ type: "ds18b20", id: "28-x", virtual: { temperature: { min: 12, max: 12, initialValue: 12 } } });
  const actions = [];
  await pollExternal(sensor, (a) => actions.push(a));
  const temp = actions.find((a) => a.type === "data/temperature/external");
  const status = actions.find((a) => a.type === "sensors/external/status");
  assert.equal(temp.payload, 12);
  assert.equal(status.payload.status, "ok");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test src/sensors.test.js`
Expected: FAIL — `./sensors.js` not found.

- [ ] **Step 3: Implement sensors.js**

```js
import { setInternalTemp, setInternalHumidity, setExternalTemp, setExternalStatus } from "./store.js";

export const pollExternal = async (sensor, dispatch) => {
  try {
    const { temperature } = await sensor.read();
    dispatch(setExternalTemp(temperature));
    dispatch(setExternalStatus({ status: "ok", detail: `reading ${temperature}c` }));
  } catch {
    dispatch(setExternalTemp(null));
    const diag = await sensor.diagnose();
    dispatch(setExternalStatus({ status: diag.status, detail: diag.detail }));
  }
};

export const pollInternal = async (sensor, dispatch) => {
  try {
    const { temperature, humidity } = await sensor.read();
    dispatch(setInternalTemp(temperature));
    dispatch(setInternalHumidity(humidity));
  } catch (e) {
    console.error("internal sensor read failed:", e.message);
  }
};
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test src/sensors.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/worldofpi/polyteknix
git add src/sensors.js src/sensors.test.js
git commit -m "feat: graceful external polling with diagnose fallback"
```

---

### Task 11: polyteknix — main app wiring + retire old files

**Files:**
- Rewrite: `~/Sites/worldofpi/polyteknix/app.js`
- Delete: `~/Sites/worldofpi/polyteknix/redux-build.js`, `~/Sites/worldofpi/polyteknix/test-everything.js`

**Interfaces:**
- Consumes: everything from Tasks 6–10 + `piteknix` (`createSensor`, `createDisplay`, `createButton`, `createLed`, `setupKeyboardListener`, `isVirtualMode`, `minutesToMs`).

- [ ] **Step 1: Rewrite app.js**

```js
import "dotenv/config";
import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import {
  isVirtualMode, getMode, createSensor, createDisplay, createButton, createLed, setupKeyboardListener,
} from "piteknix";

import { loadConfig } from "./src/config.js";
import { appReducer, nextMode } from "./src/store.js";
import { renderDisplay } from "./src/render.js";
import { pollInternal, pollExternal } from "./src/sensors.js";
import { buildPayload, pushData } from "./src/push.js";
import axios from "axios";

const cfg = loadConfig();
console.log(`polyteknix starting in ${getMode()} mode`);

// Hardware (auto virtual/real)
const internal = await createSensor({ type: "aht20", calibrationOffset: cfg.tempCalibrationOffset });
const external = await createSensor({ type: "ds18b20", id: cfg.externalSensorId });
const display = await createDisplay({ type: "lcd", width: 16, height: 2 });
const led = createLed({ gpio: 17 });
const button = createButton({ gpio: 27, virtualKey: "1" });

// Redux + listener-driven render
const listener = createListenerMiddleware();
listener.startListening({
  predicate: (action) =>
    action.type.startsWith("data/") ||
    action.type.startsWith("sensors/") ||
    action.type === "display/next",
  effect: (_action, api) => renderDisplay(api.getState(), display),
});
const store = configureStore({
  reducer: appReducer,
  middleware: (getDefault) => getDefault().prepend(listener.middleware),
});

await display.clear();
display.printLine(0, "starting up...");
await led.on();

// initial + interval polling
const pollAll = async () => {
  await pollInternal(internal, store.dispatch);
  await pollExternal(external, store.dispatch);
};
await pollAll();
const poll = setInterval(pollAll, cfg.pollMs);

const push = setInterval(() => {
  pushData(axios, { feedId: cfg.feedId, key: cfg.iotplotterKey }, store.getState())
    .catch((e) => console.error("push failed:", e.message));
}, cfg.pollMs);

if (isVirtualMode()) {
  setupKeyboardListener({ onDebug: () => console.log(JSON.stringify(store.getState(), null, 2)) });
}
// Button (GPIO 27 / key "1") cycles display modes: DEFAULT <-> DIAG
button.watch(() => store.dispatch(nextMode()));

process.on("SIGINT", async () => {
  clearInterval(poll);
  clearInterval(push);
  await led.cleanup();
  await button.cleanup();
  await display.cleanup();
  await internal.cleanup();
  await external.cleanup();
  process.exit();
});
```

- [ ] **Step 2: Delete retired files**

```bash
cd ~/Sites/worldofpi/polyteknix
git rm redux-build.js test-everything.js
```

- [ ] **Step 3: Run the full polyteknix test suite**

Run: `cd ~/Sites/worldofpi/polyteknix && npm test`
Expected: PASS — config, store, render, push, sensors test files all green.

- [ ] **Step 4: Smoke-run in virtual mode**

Run: `cd ~/Sites/worldofpi/polyteknix && VIRTUAL_MODE=true node app.js > /tmp/polyteknix.out 2>&1 &` then after ~4s inspect `/tmp/polyteknix.out` and `kill %1`.
Expected: terminal LCD frame renders `int: ..c ..%` on line 0 and `ext: -- (...)` on line 1 (external has no real sensor in virtual mode → dead-path exercised); no crash.

- [ ] **Step 5: Commit**

```bash
cd ~/Sites/worldofpi/polyteknix
git add app.js
git commit -m "feat: rewrite app on piteknix — listener render, graceful external, retire legacy files"
```

---

### Task 12: Security — rotate iotplotter key + scrub git history

**Files:**
- History rewrite across all commits touching `redux-build.js`.

**⚠️ This task has a manual checkpoint. Do the rotation with the user before scrubbing.**

- [ ] **Step 1: Rotate the key (MANUAL — user action)**

At iotplotter.com, regenerate the feed api-key. The old key `<OLD_IOTPLOTTER_KEY>` (redacted here; recover it from old git history of `redux-build.js` if needed) is compromised (public git history) and must be treated as burned. Put the new key in `~/Sites/worldofpi/polyteknix/.env` (gitignored):

```
IOTPLOTTER_KEY=<new-key>
```

- [ ] **Step 2: Confirm no secret remains in the working tree**

Run: `cd ~/Sites/worldofpi/polyteknix && grep -rn "<OLD_IOTPLOTTER_KEY>" . --exclude-dir=node_modules --exclude-dir=.git` (substitute the real old key)
Expected: no matches (the string only lives in old git history now).

- [ ] **Step 3: Scrub history with git filter-repo**

```bash
cd ~/Sites/worldofpi/polyteknix
pip install git-filter-repo 2>/dev/null || brew install git-filter-repo
echo "<OLD_IOTPLOTTER_KEY>==>REDACTED" > /tmp/pt-secrets.txt  # substitute the real old key
git filter-repo --replace-text /tmp/pt-secrets.txt --force
```

- [ ] **Step 4: Verify history is clean**

Run: `git log --all -p | grep -c "<OLD_IOTPLOTTER_KEY>" || echo 0` (substitute the real old key)
Expected: `0`.

- [ ] **Step 5: Force-push (MANUAL confirm — rewrites public history)**

Confirm branch and remote with the user first, then:

```bash
git push origin --force --all
git push origin --force --tags
```

---

## Self-Review

**Spec coverage:**
- Thin app on piteknix, listener render, no loop → Tasks 7, 8, 11. ✓
- Display-mode system (REDUX-SPEC): `displayModes`/`getNextMode`/`display/next` + button cycling + per-mode render fns + `renderDisplay(state,display)` dispatcher → Tasks 7 (reducer + cycling), 8 (formatters + dispatcher), 11 (button → `nextMode()`, listener predicate). Modes DEFAULT + DIAG. ✓
- Virtual-first dev/deploy unchanged → env auto-detect used throughout; Task 11 Step 4 smoke run. ✓
- Hardware map (aht20 internal, ds18b20 external, lcd 16x2, button 27, led 17, iotplotter) → Task 11. ✓
- State shape → Task 7. ✓
- Dead external + graceful degradation → Task 10 (`pollExternal` null path). ✓
- Diagnostics (`diagnose()` + heuristics incl. 85.0, ENOENT, absent) → Task 4. ✓
- Drop TIMER/MESSAGE stubs → Task 11 rewrite omits them; Task 11 deletes redux-build.js. ✓
- Data push null-safe, env key → Task 9 + Task 6. ✓
- Security: rotate, env, scrub → Tasks 6 + 12. ✓
- Testing: aht20 virtual, lcd 16x2 virtual, ds18b20 failure, diagnose, button → Tasks 1–5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `diagnose()` return `{status,detail,busDevices,targetPresent,lastError}` defined in Task 4, consumed in Task 10 (`diag.status`, `diag.detail`). Action creators defined in Task 7, used in Tasks 8/10/11. `formatDataLines`/`formatDiagLines`/`renderDisplay` defined Task 8, `renderDisplay` used Task 11. `displayModes`/`getNextMode`/`nextMode` defined Task 7, `nextMode` used Task 11. `buildPayload`/`pushData` defined Task 9, used Task 11. `loadConfig` fields defined Task 6, used Task 11. Consistent. ✓
