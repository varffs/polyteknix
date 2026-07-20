export const initialState = {
  data: {
    temperature_internal: null,
    temperature_external: null,
    humidity_internal: null,
    pressure: null,
  },
  display: { mode: "DEFAULT", isBacklit: false },
  sensors: { external_status: "unknown", external_diagnostic: null },
};

export const displayModes = ["DEFAULT", "DIAG"];
export const getNextMode = (mode) =>
  displayModes[(displayModes.indexOf(mode) + 1) % displayModes.length];

export const setInternalTemp = (v) => ({ type: "data/temperature/internal", payload: v });
export const setExternalTemp = (v) => ({ type: "data/temperature/external", payload: v });
export const setInternalHumidity = (v) => ({ type: "data/humidity/internal", payload: v });
export const setExternalStatus = (payload) => ({ type: "sensors/external/status", payload });
export const nextMode = () => ({ type: "display/next" });

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
    case "display/next":
      return { ...state, display: { ...state.display, mode: getNextMode(state.display.mode) } };
    default:
      return state;
  }
}
