import { selectFaults, selectFaultKey } from "./faults.js";

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

/** The sticky clock flag has done its job once the DIAG screen carrying it has
 *  been read, and it must go or it displaces the external diagnostic on line 1
 *  for the rest of the process. Both ways out of DIAG count as read: cycling
 *  on (DIAG wraps to DEFAULT) and the backlight timing out. Clearing it here
 *  rather than on entry is what lets DIAG render "clk" at all; safe because
 *  losing a fault never arms — selectArmed compares by containment, and the
 *  post-pass narrows "clk" out of the acknowledgement in the same dispatch. */
const forgetClockFlagOnLeavingDiag = (prev, next) =>
  prev.display.mode === "DIAG" && next.led.clockWasInsane
    ? { ...next, led: { ...next.led, clockWasInsane: false } }
    : next;

function baseReducer(state = initialState, action) {
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
    case "display/buttonPress": {
      if (!state.display.isBacklit) {
        return { ...state, display: { ...state.display, isBacklit: true } };
      }
      const mode = getNextMode(state.display.mode);
      const next = { ...state, display: { ...state.display, mode } };
      if (mode === "DIAG") {
        // Reaching DIAG means someone is standing at the device reading the
        // fault detail — that IS the acknowledgement. Capture the key from the
        // current state, "clk" included, and leave clockWasInsane raised: the
        // screen this press opens is the only one that reports it, and DIAG's
        // line 1 is derived from the same state. "clk" is live at this instant
        // so it survives the post-pass narrowing; it is dropped from the
        // acknowledgement later, when leaving DIAG clears the flag.
        return { ...next, led: { ...next.led, seenFaultKey: selectFaultKey(next) } };
      }
      return forgetClockFlagOnLeavingDiag(state, next);
    }
    case "display/sleep":
      return forgetClockFlagOnLeavingDiag(state, {
        ...state,
        display: { ...state.display, isBacklit: false, mode: "DEFAULT" },
      });
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

/** An acknowledgement covers only the faults that were still live when it was
 *  made: intersect it with the live set after every action, so a fault that
 *  clears and later returns is new again and re-arms. Narrowing rather than
 *  only resetting at full health matters because ext is permanently live on
 *  this device — the key never reaches "", so a reset conditioned on that could
 *  never fire and the acknowledged set only ever grew, silencing every genuine
 *  recurrence of int or psh for the rest of the process. Full health is now
 *  just the case where the intersection comes out empty.
 *
 *  A fault can clear via several different actions, so doing this once after
 *  the switch means no path can forget. Empty normalises to null, never "":
 *  "" is not a valid stored key and must not become observable in state.
 *  Ordering comes from selectFaults, so the string keeps FAULT_ORDER. */
const narrowAcknowledgementToLiveFaults = (state) => {
  const { seenFaultKey } = state.led;
  if (seenFaultKey === null) return state;
  const seen = new Set(seenFaultKey ? seenFaultKey.split("|") : []);
  const kept = selectFaults(state).filter((key) => seen.has(key));
  const narrowed = kept.length > 0 ? kept.join("|") : null;
  return narrowed === seenFaultKey
    ? state
    : { ...state, led: { ...state.led, seenFaultKey: narrowed } };
};

export function appReducer(state = initialState, action) {
  return narrowAcknowledgementToLiveFaults(baseReducer(state, action));
}
