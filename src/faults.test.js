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

test("armed only when a live fault is missing from the acknowledged set", () => {
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

// ext is permanently live on this device until the probe is replaced, so the
// shrinking-set case is the common one: every transient int/psh that gets
// acknowledged and then clears used to raise a false alarm.
test("a fault clearing does not re-arm when every remaining fault was acknowledged", () => {
  const both = withState({
    sensors: { external_status: "absent", push_failures: PUSH_FAILURE_THRESHOLD },
    led: { seenFaultKey: "psh|ext" },
  });
  assert.equal(selectArmed(both), false);

  const pushRecovered = withState({
    sensors: { external_status: "absent", push_failures: 0 },
    led: { seenFaultKey: "psh|ext" },
  });
  assert.equal(
    selectArmed(pushRecovered),
    false,
    "the set shrinking is strictly better news, not a new fault",
  );
});

test("an acknowledged key holding a fault the live set has lost does not re-arm", () => {
  // The sticky clock flag is cleared on leaving DIAG, so seenFaultKey outlives
  // it by design. Containment is what makes that safe.
  const state = withState({
    sensors: { external_status: "absent" },
    led: { seenFaultKey: "clk|ext" },
  });
  assert.equal(selectArmed(state), false);
});

test("a healthy device is never armed however stale the acknowledged key", () => {
  const state = withState({ sensors: { external_status: "ok" }, led: { seenFaultKey: "psh|ext" } });
  assert.equal(selectArmed(state), false);
});
