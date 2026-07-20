import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDataLines, formatDiagLines, renderDisplay } from "./render.js";
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
