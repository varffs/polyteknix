import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDataLines, formatDiagLines, formatMinMaxLines, formatDayCompLines, renderDisplay } from "./render.js";
import { appReducer, initialState, buttonPress, setExternalStatus, setInternalStatus, pushResult, recordSample, SANITY_EPOCH } from "./store.js";

const makeFakeDisplay = () => {
  const calls = [];
  return { calls, clear: () => calls.push(["clear"]), printLine: (n, t) => calls.push(["printLine", n, t]) };
};

test("DEFAULT formats internal + external when both present", () => {
  const state = { ...initialState, data: { ...initialState.data, temperature_internal: 21.44, humidity_internal: 63.2, temperature_external: 12.8 } };
  const [l0, l1] = formatDataLines(state);
  assert.equal(l0, "int: 21.4c 63.2%");
  assert.equal(l1, "ext: 12.8c");
});

// pollInternal dispatches temperature and humidity separately and we re-render
// on each, so this intermediate state is reachable on sensor recovery
test("DEFAULT shows a humidity placeholder when only the temperature has arrived", () => {
  const state = { ...initialState, data: { ...initialState.data, temperature_internal: 21.44, humidity_internal: null } };
  const [l0] = formatDataLines(state);
  assert.equal(l0, "int: 21.4c --%");
  assert.ok(l0.length <= 16);
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

test("renderDisplay in DEFAULT mode clears then prints DEFAULT-formatted lines in order", () => {
  const state = { ...initialState, data: { ...initialState.data, temperature_internal: 21.44, humidity_internal: 63.2, temperature_external: 12.8 } };
  const display = makeFakeDisplay();
  renderDisplay(state, display);
  const [l0, l1] = formatDataLines(state);
  assert.deepEqual(display.calls, [["clear"], ["printLine", 0, l0], ["printLine", 1, l1]]);
});

test("renderDisplay in DIAG mode routes to the DIAG formatter", () => {
  const state = {
    ...initialState,
    display: { ...initialState.display, mode: "DIAG" },
    sensors: { external_status: "absent", external_diagnostic: "no devices on 1-wire bus (check pull-up)" },
  };
  const display = makeFakeDisplay();
  renderDisplay(state, display);
  const [l0, l1] = formatDiagLines(state);
  assert.deepEqual(display.calls, [["clear"], ["printLine", 0, l0], ["printLine", 1, l1]]);
});

test("renderDisplay falls back to DEFAULT formatter for an unknown mode", () => {
  const state = {
    ...initialState,
    display: { ...initialState.display, mode: "NOPE" },
    data: { ...initialState.data, temperature_internal: 21.44, humidity_internal: 63.2, temperature_external: 12.8 },
  };
  const display = makeFakeDisplay();
  renderDisplay(state, display);
  const [l0, l1] = formatDataLines(state);
  assert.deepEqual(display.calls, [["clear"], ["printLine", 0, l0], ["printLine", 1, l1]]);
});

test("renderDisplay does not throw on all-null initial state and prints graceful placeholders", () => {
  const display = makeFakeDisplay();
  assert.doesNotThrow(() => renderDisplay(initialState, display));
  assert.equal(display.calls[0][0], "clear");
  assert.equal(display.calls.length, 3);
  const [, line0Num, line0] = display.calls[1];
  const [, line1Num, line1] = display.calls[2];
  assert.equal(line0Num, 0);
  assert.equal(line1Num, 1);
  assert.equal(line0, "int: -- --");
  assert.equal(line1, "ext: -- (unknown)");
});

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
  assert.equal(l0, "i24 L-3 H31");
  assert.equal(l1, "e24 L-- H--");
});

test("MINMAX shows external min/max once the probe reports", () => {
  const samples = [
    { ts: at(2026, 6, 26, 3), temperature_internal: 12, temperature_external: 4.1 },
    { ts: at(2026, 6, 26, 11), temperature_internal: 20, temperature_external: 18.6 },
  ];
  const [, l1] = formatMinMaxLines(stateWithHistory(samples), NOW);
  assert.equal(l1, "e24 L4 H19");
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
  assert.equal(l0, "tdy L-3 H31");
  assert.equal(l1, "yst L-2 H29");
});

test("DAYCOMP shows a placeholder for yesterday before the first midnight", () => {
  const samples = [{ ts: at(2026, 6, 26, 11), temperature_internal: 31.4 }];
  const [l0, l1] = formatDayCompLines(stateWithHistory(samples), NOW);
  assert.equal(l0, "tdy L31 H31");
  assert.equal(l1, "yst L-- H--");
});

// Worst case is an all-day freeze: BOTH values two-digit negative, on both days.
// This is what a one-decimal layout could not fit.
test("new formatters stay within 16 characters at worst-case values", () => {
  const samples = [
    { ts: at(2026, 6, 25, 4), temperature_internal: -19.9, temperature_external: -19.9 },
    { ts: at(2026, 6, 25, 15), temperature_internal: -13.2, temperature_external: -13.2 },
    { ts: at(2026, 6, 26, 3), temperature_internal: -19.9, temperature_external: -19.9 },
    { ts: at(2026, 6, 26, 11), temperature_internal: -13.2, temperature_external: -13.2 },
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

test("renderDisplay defaults now to the current clock", () => {
  const display = makeFakeDisplay();
  const state = stateWithHistory([{ ts: Date.now(), temperature_internal: 7 }], "MINMAX");
  renderDisplay(state, display);
  assert.equal(display.calls[1][2], "i24 L7 H7");
});

test("DIAG shows the diagnostic when only the external sensor is faulty", () => {
  const state = {
    ...initialState,
    sensors: { ...initialState.sensors, external_status: "absent", external_diagnostic: "not on bus" },
  };
  assert.deepEqual(formatDiagLines(state), ["ext: absent", "not on bus"]);
});

/** dark -> wake (DEFAULT), then MINMAX, DAYCOMP, DIAG. Driving the real
 *  reducer is the point: a hand-built state with clockWasInsane set while the
 *  mode is DIAG was unreachable, and hid a bug where entering DIAG cleared the
 *  flag before this screen could ever render it. */
const pressToDiag = (state) => {
  let s = state;
  for (let i = 0; i < 4; i += 1) s = appReducer(s, buttonPress());
  return s;
};

const allFourFaults = () => {
  let s = appReducer(initialState, recordSample(SANITY_EPOCH - 1)); // clk
  s = appReducer(s, setInternalStatus("error")); // int
  for (let i = 0; i < 3; i += 1) s = appReducer(s, pushResult(false)); // psh
  return appReducer(s, setExternalStatus({ status: "absent", detail: "not on bus" })); // ext
};

test("DIAG shows fault flags when a non-external fault is live", () => {
  const state = pressToDiag(allFourFaults());
  assert.equal(state.display.mode, "DIAG");
  const [line0, line1] = formatDiagLines(state);
  assert.equal(line0, "ext: absent");
  assert.equal(line1, "int psh clk");
  assert.ok(line1.length <= 16);
});

test("renderDisplay prints the fault flags on the screen the press just opened", () => {
  const state = pressToDiag(allFourFaults());
  const display = makeFakeDisplay();
  renderDisplay(state, display);
  assert.deepEqual(display.calls, [["clear"], ["printLine", 0, "ext: absent"], ["printLine", 1, "int psh clk"]]);
});

test("the diagnostic returns to DIAG line 1 once the clock flag has been read", () => {
  let s = appReducer(initialState, recordSample(SANITY_EPOCH - 1));
  s = appReducer(s, setExternalStatus({ status: "absent", detail: "not on bus" }));

  s = pressToDiag(s);
  assert.deepEqual(formatDiagLines(s), ["ext: absent", "clk"]);

  s = appReducer(s, buttonPress()); // leave DIAG — the sticky flag has been read
  s = appReducer(s, buttonPress()); // MINMAX
  s = appReducer(s, buttonPress()); // DAYCOMP
  s = appReducer(s, buttonPress()); // DIAG again
  assert.deepEqual(formatDiagLines(s), ["ext: absent", "not on bus"]);
});

test("DIAG flags appear even when the external sensor is fine", () => {
  const state = {
    ...initialState,
    sensors: { ...initialState.sensors, external_status: "ok", internal_status: "error" },
  };
  assert.deepEqual(formatDiagLines(state), ["ext: ok", "int"]);
});
