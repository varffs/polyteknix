export const initialState = {
  data: {
    temperature_internal: null,
    temperature_external: null,
    humidity_internal: null,
    pressure: null,
  },
  display: { mode: "DEFAULT", isBacklit: false },
  sensors: {
    external_status: "unknown",
    external_diagnostic: null,
    internal_status: "unknown",
    push_failures: 0,
  },
  history: { samples: [] },
  led: { seenFaultKey: null, isLit: false, clockWasInsane: false },
};

export const displayModes = ["DEFAULT", "MINMAX", "DAYCOMP", "DIAG"];
export const getNextMode = (mode) =>
  displayModes[(displayModes.indexOf(mode) + 1) % displayModes.length];

/** Samples timestamped before this are from a pre-NTP boot clock, not real history. */
export const SANITY_EPOCH = Date.UTC(2024, 0, 1);
/** 49h, not 48h: DAYCOMP's "yesterday" starts up to 48h59m before now on the
 *  evening a DST fall-back lengthens a local day. */
export const HISTORY_WINDOW_MS = 49 * 60 * 60 * 1000;
/** Backstop against a clock anomaly inflating the ring. */
export const HISTORY_MAX_SAMPLES = 1000;

export const setInternalTemp = (v) => ({ type: "data/temperature/internal", payload: v });
export const setExternalTemp = (v) => ({ type: "data/temperature/external", payload: v });
export const setInternalHumidity = (v) => ({ type: "data/humidity/internal", payload: v });
export const setExternalStatus = (payload) => ({ type: "sensors/external/status", payload });
export const buttonPress = () => ({ type: "display/buttonPress" });
export const sleep = () => ({ type: "display/sleep" });
export const recordSample = (ts) => ({ type: "history/record", payload: ts });
export const setInternalStatus = (status) => ({ type: "sensors/internal/status", payload: status });
/** Not namespaced under sensors/ — that prefix triggers an LCD redraw in app.js. */
export const pushResult = (ok) => ({ type: "push/result", payload: ok });
export const ledLit = (lit) => ({ type: "led/lit", payload: lit });

export function appReducer(state = initialState, action) {
  switch (action.type) {
    case "data/temperature/internal":
      return { ...state, data: { ...state.data, temperature_internal: action.payload } };
    case "data/temperature/external":
      return { ...state, data: { ...state.data, temperature_external: action.payload } };
    case "data/humidity/internal":
      return { ...state, data: { ...state.data, humidity_internal: action.payload } };
    case "sensors/external/status":
      return {
        ...state,
        sensors: {
          ...state.sensors,
          external_status: action.payload.status,
          external_diagnostic: action.payload.detail,
        },
      };
    case "display/buttonPress":
      if (!state.display.isBacklit) {
        return { ...state, display: { ...state.display, isBacklit: true } };
      }
      return { ...state, display: { ...state.display, mode: getNextMode(state.display.mode) } };
    case "display/sleep":
      return { ...state, display: { ...state.display, isBacklit: false, mode: "DEFAULT" } };
    case "sensors/internal/status":
      return { ...state, sensors: { ...state.sensors, internal_status: action.payload } };
    case "push/result":
      return {
        ...state,
        sensors: {
          ...state.sensors,
          push_failures: action.payload ? 0 : state.sensors.push_failures + 1,
        },
      };
    case "led/lit":
      if (state.led.isLit === action.payload) return state;
      return { ...state, led: { ...state.led, isLit: action.payload } };
    case "history/record": {
      const ts = action.payload;
      if (!Number.isFinite(ts) || ts < SANITY_EPOCH) {
        // The sample is still rejected — but the fact that the clock was wrong
        // is news, and it is the only evidence left once NTP corrects it.
        return state.led.clockWasInsane
          ? state
          : { ...state, led: { ...state.led, clockWasInsane: true } };
      }
      const appended = state.history.samples.concat({ ts, ...state.data });
      const pruned = appended.filter((s) => s.ts > ts - HISTORY_WINDOW_MS);
      const capped =
        pruned.length > HISTORY_MAX_SAMPLES
          ? pruned.slice(pruned.length - HISTORY_MAX_SAMPLES)
          : pruned;
      return { ...state, history: { samples: capped } };
    }
    default:
      return state;
  }
}
