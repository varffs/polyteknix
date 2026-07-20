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
