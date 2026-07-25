import { test } from "node:test";
import assert from "node:assert/strict";
import { appReducer, initialState, setInternalTemp, setExternalStatus, nextMode } from "./store.js";

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
