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
