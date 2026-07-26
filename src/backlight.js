import { sleep } from "./store.js";

/**
 * Arms a sleep timer on every button press. A new press cancels the
 * pending timer (cancelActiveListeners) and starts a fresh one, so the
 * backlight goes dark timeoutMs after the LAST press.
 */
export const registerBacklightTimeout = (listener, { timeoutMs }) => {
  listener.startListening({
    type: "display/buttonPress",
    effect: async (_action, api) => {
      api.cancelActiveListeners();
      await api.delay(timeoutMs);
      api.dispatch(sleep());
    },
  });
};
