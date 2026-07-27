import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDataLines, formatDiagLines, formatMinMaxLines, formatDayCompLines, renderDisplay } from "./render.js";
import { initialState } from "./store.js";

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
