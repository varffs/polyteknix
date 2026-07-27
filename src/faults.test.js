import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "./store.js";
import { selectFaults, selectFaultKey, selectArmed, PUSH_FAILURE_THRESHOLD } from "./faults.js";

const withState = (overrides) => ({
  ...initialState,
  sensors: { ...initialState.sensors, ...(overrides.sensors || {}) },
  led: { ...initialState.led, ...(overrides.led || {}) },
});

test("a fresh device is healthy — unknown statuses are not faults", () => {
  assert.deepEqual(selectFaults(initialState), []);
  assert.equal(selectFaultKey(initialState), "");
  assert.equal(selectArmed(initialState), false);
});

test("an ok external sensor is not a fault", () => {
  assert.deepEqual(selectFaults(withState({ sensors: { external_status: "ok" } })), []);
});

test("each fault is detected on its own", () => {
  assert.deepEqual(selectFaults(withState({ sensors: { internal_status: "error" } })), ["int"]);
  assert.deepEqual(selectFaults(withState({ sensors: { push_failures: PUSH_FAILURE_THRESHOLD } })), ["psh"]);
  assert.deepEqual(selectFaults(withState({ led: { clockWasInsane: true } })), ["clk"]);
  assert.deepEqual(selectFaults(withState({ sensors: { external_status: "absent" } })), ["ext"]);
});

test("the push threshold is exclusive below 3", () => {
  assert.deepEqual(selectFaults(withState({ sensors: { push_failures: 2 } })), []);
});

test("multiple faults come out in fixed order regardless of how they arose", () => {
  const state = withState({
    sensors: { external_status: "absent", internal_status: "error", push_failures: 5 },
    led: { clockWasInsane: true },
  });
  assert.deepEqual(selectFaults(state), ["int", "psh", "clk", "ext"]);
  assert.equal(selectFaultKey(state), "int|psh|clk|ext");
});

test("armed only when the live key differs from the acknowledged one", () => {
  const faulty = withState({ sensors: { external_status: "absent" } });
  assert.equal(selectArmed(faulty), true);

  const acknowledged = withState({
    sensors: { external_status: "absent" },
    led: { seenFaultKey: "ext" },
  });
  assert.equal(selectArmed(acknowledged), false);

  const worsened = withState({
    sensors: { external_status: "absent", internal_status: "error" },
    led: { seenFaultKey: "ext" },
  });
  assert.equal(selectArmed(worsened), true, "a new fault on top of an acknowledged one must re-arm");
});
