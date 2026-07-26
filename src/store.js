export const initialState = {
  data: {
    temperature_internal: null,
    temperature_external: null,
    humidity_internal: null,
    pressure: null,
  },
  display: { mode: "DEFAULT", isBacklit: false },
  sensors: { external_status: "unknown", external_diagnostic: null },
  history: { samples: [] },
};

export const displayModes = ["DEFAULT", "DIAG"];
export const getNextMode = (mode) =>
  displayModes[(displayModes.indexOf(mode) + 1) % displayModes.length];

/** Samples timestamped before this are from a pre-NTP boot clock, not real history. */
export const SANITY_EPOCH = Date.UTC(2024, 0, 1);
/** 48h, not 24h: DAYCOMP's "yesterday" needs data from up to two days back just after midnight. */
export const HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Backstop against a clock anomaly inflating the ring. */
export const HISTORY_MAX_SAMPLES = 1000;

export const setInternalTemp = (v) => ({ type: "data/temperature/internal", payload: v });
export const setExternalTemp = (v) => ({ type: "data/temperature/external", payload: v });
export const setInternalHumidity = (v) => ({ type: "data/humidity/internal", payload: v });
export const setExternalStatus = (payload) => ({ type: "sensors/external/status", payload });
export const buttonPress = () => ({ type: "display/buttonPress" });
export const sleep = () => ({ type: "display/sleep" });
export const recordSample = (ts) => ({ type: "history/record", payload: ts });

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
    case "history/record": {
      const ts = action.payload;
      if (!Number.isFinite(ts) || ts < SANITY_EPOCH) return state;
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
