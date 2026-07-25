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
  assert.equal(p.data.External_Diagnostic[0].value, "x");
});

test("payload omits diagnostic when null", () => {
  const p = buildPayload(initialState);
  assert.equal(p.data.External_Diagnostic, undefined);
});

test("payload omits undefined readings and diagnostic", () => {
  const state = {
    ...initialState,
    data: { ...initialState.data, temperature_internal: undefined, humidity_internal: undefined },
    sensors: { external_status: "ok", external_diagnostic: undefined },
  };
  const p = buildPayload(state);
  assert.equal(p.data.Internal_Temperature, undefined);
  assert.equal(p.data.Internal_Humidity, undefined);
  assert.equal(p.data.External_Diagnostic, undefined);
});

test("pushData posts to https endpoint", async () => {
  let url = null;
  const fakeAxios = { post: async (u) => { url = u; } };
  await pushData(fakeAxios, { feedId: "f", key: "k" }, initialState);
  assert.ok(url.startsWith("https://"));
});

test("payload preserves genuine 0 readings (not omitted as falsy)", () => {
  const state = { ...initialState, data: { ...initialState.data, temperature_internal: 0, humidity_internal: 0, temperature_external: 0 } };
  const p = buildPayload(state);
  assert.equal(p.data.Internal_Temperature[0].value, 0);
  assert.equal(p.data.Internal_Humidity[0].value, 0);
  assert.equal(p.data.External_Temperature[0].value, 0);
});

test("pushData is a no-op without a key", async () => {
  let called = false;
  const fakeAxios = { post: async () => { called = true; } };
  const res = await pushData(fakeAxios, { feedId: "f", key: null }, initialState);
  assert.equal(res, null);
  assert.equal(called, false);
});
