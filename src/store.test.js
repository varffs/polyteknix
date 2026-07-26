import { test } from "node:test";
import assert from "node:assert/strict";
import { appReducer, initialState, setInternalTemp, setExternalStatus, buttonPress, sleep } from "./store.js";

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

test("buttonPress when dark wakes backlight without cycling mode", () => {
  const s = appReducer(initialState, buttonPress());
  assert.equal(s.display.isBacklit, true);
  assert.equal(s.display.mode, "DEFAULT");
});

test("buttonPress when lit cycles mode and keeps backlight on", () => {
  const lit = appReducer(initialState, buttonPress());
  const s1 = appReducer(lit, buttonPress());
  assert.equal(s1.display.mode, "DIAG");
  assert.equal(s1.display.isBacklit, true);
  const s2 = appReducer(s1, buttonPress());
  assert.equal(s2.display.mode, "DEFAULT");
});

test("sleep turns backlight off and resets mode to DEFAULT", () => {
  const lit = appReducer(initialState, buttonPress());
  const onDiag = appReducer(lit, buttonPress());
  const s = appReducer(onDiag, sleep());
  assert.equal(s.display.isBacklit, false);
  assert.equal(s.display.mode, "DEFAULT");
});

test("sleep when already dark is a no-op shape-wise", () => {
  const s = appReducer(initialState, sleep());
  assert.equal(s.display.isBacklit, false);
  assert.equal(s.display.mode, "DEFAULT");
});
