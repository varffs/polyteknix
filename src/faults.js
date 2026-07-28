/**
 * Pure fault derivation. Imports nothing — store.js needs selectFaultKey for
 * acknowledgement and led.js needs action creators from store.js, so these
 * selectors have to live outside both to avoid an import cycle.
 */

/** Fixed order makes the key a stable identity for a fault *set*, so "same
 *  problems as before" and "something new" are distinguishable by string
 *  comparison alone. */
export const FAULT_ORDER = ["int", "psh", "clk", "ext"];

/** 3 failures at a 5-minute push interval = 15 minutes of sustained failure,
 *  so one flaky POST or a router reboot cannot arm the LED. */
export const PUSH_FAILURE_THRESHOLD = 3;

export const selectFaults = (state) => {
  const { sensors, led } = state;
  const active = new Set();
  if (sensors.internal_status === "error") active.add("int");
  if (sensors.push_failures >= PUSH_FAILURE_THRESHOLD) active.add("psh");
  if (led.clockWasInsane) active.add("clk");
  // "unknown" is the pre-first-poll boot value, not a fault.
  if (sensors.external_status !== "ok" && sensors.external_status !== "unknown") active.add("ext");
  return FAULT_ORDER.filter((key) => active.has(key));
};

export const selectFaultKey = (state) => selectFaults(state).join("|");

/** seenFaultKey is stored as the joined string so state stays serializable;
 *  comparison needs the set, so unpack it here. null / "" = nothing seen. */
const seenSet = (seenFaultKey) => new Set(seenFaultKey ? seenFaultKey.split("|") : []);

/** Armed when some LIVE fault has not been looked at. Containment, not string
 *  equality: a set that only shrinks means every fault still present has been
 *  acknowledged and the situation strictly improved, which is not worth a walk
 *  outside — equality re-armed on that, and with ext permanently live here it
 *  fired for every transient fault that cleared after being acknowledged. */
export const selectArmed = (state) => {
  const seen = seenSet(state.led.seenFaultKey);
  return selectFaults(state).some((key) => !seen.has(key));
};
