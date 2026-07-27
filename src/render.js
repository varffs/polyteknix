import { formatFloat } from "piteknix";
import { selectWindow, selectMinMax, selectDayMinMax, DAY_MS } from "./history.js";

// formatFloat renders null as "0". pollInternal dispatches temperature and
// humidity as separate actions and we re-render on each, so between the two a
// recovered sensor would briefly show a fabricated "0%" without this guard.
const fmtHumidity = (v) => (typeof v === "number" ? formatFloat(v) : "--");

export const formatDataLines = (state) => {
  const { data, sensors } = state;
  const line0 =
    typeof data.temperature_internal === "number"
      ? `int: ${formatFloat(data.temperature_internal)}c ${fmtHumidity(data.humidity_internal)}%`
      : "int: -- --";
  const line1 =
    typeof data.temperature_external === "number"
      ? `ext: ${formatFloat(data.temperature_external)}c`
      : `ext: -- (${sensors.external_status})`;
  return [line0, line1];
};

export const formatDiagLines = (state) => {
  const { sensors } = state;
  const line0 = `ext: ${sensors.external_status}`;
  const line1 = (sensors.external_diagnostic || "").substring(0, 16);
  return [line0, line1];
};

// Whole degrees (0 dp): one decimal overflows 16 chars when both values are
// two-digit negative, e.g. "tdy L-12.4 H-10.1" = 17. formatFloat also renders
// null as "0", which would be a lie for an absent reading, so missing min/max
// data gets its own placeholder rather than going through it.
const minMaxLine = (label, mm) =>
  mm === null
    ? `${label} L-- H--`
    : `${label} L${formatFloat(mm.min, 0)} H${formatFloat(mm.max, 0)}`;

export const formatMinMaxLines = (state, now) => {
  const window = selectWindow(state.history.samples, DAY_MS, now);
  return [
    minMaxLine("i24", selectMinMax(window, "temperature_internal")),
    minMaxLine("e24", selectMinMax(window, "temperature_external")),
  ];
};

export const formatDayCompLines = (state, now) => {
  const { samples } = state.history;
  return [
    minMaxLine("tdy", selectDayMinMax(samples, "temperature_internal", 0, now)),
    minMaxLine("yst", selectDayMinMax(samples, "temperature_internal", 1, now)),
  ];
};

const MODE_FORMATTERS = {
  DEFAULT: formatDataLines,
  MINMAX: formatMinMaxLines,
  DAYCOMP: formatDayCompLines,
  DIAG: formatDiagLines,
};

export const renderDisplay = (state, display, now = Date.now()) => {
  const formatter = MODE_FORMATTERS[state.display.mode] || formatDataLines;
  const [line0, line1] = formatter(state, now);
  display.clear();
  display.printLine(0, line0);
  display.printLine(1, line1);
};
