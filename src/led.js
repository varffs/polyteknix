import { selectArmed } from "./faults.js";
import { ledLit } from "./store.js";

/**
 * Pulses the button LED while a fault is unacknowledged.
 *
 * The loop exists only while armed — a healthy device runs no timer, dispatches
 * nothing, and churns no state. Because the quiet check happens inside the
 * loop, the night window re-evaluates itself every cycle with no separate
 * clock ticker.
 *
 * `isQuiet` is injected rather than imported so the loop is testable without a
 * real clock or a real sun.
 */
export const registerLedBlink = (listener, { onMs, offMs, quietRecheckMs, isQuiet }) => {
  listener.startListening({
    predicate: (_action, curr, prev) => selectArmed(curr) && !selectArmed(prev),
    effect: async (_action, api) => {
      // A second instance would double-pulse the same pin.
      api.cancelActiveListeners();
      while (selectArmed(api.getState())) {
        if (isQuiet(Date.now())) {
          api.dispatch(ledLit(false));
          // Idle rather than churning a 3s cycle all night. One minute of
          // granularity is immaterial against a 30-minute margin.
          await api.delay(quietRecheckMs);
          continue;
        }
        api.dispatch(ledLit(true));
        await api.delay(onMs);
        api.dispatch(ledLit(false));
        await api.delay(offMs);
      }
      // Reached on disarm. Not reached on cancellation — api.delay throws
      // there — but the instance that cancelled us owns the pin from then on.
      api.dispatch(ledLit(false));
    },
  });
};
