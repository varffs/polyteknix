import { formatFloat } from "piteknix";

export const formatDataLines = (state) => {
  const { data, sensors } = state;
  const line0 = `int: ${formatFloat(data.temperature_internal)}c ${formatFloat(data.humidity_internal)}%`;
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

const MODE_FORMATTERS = {
  DEFAULT: formatDataLines,
  DIAG: formatDiagLines,
};

export const renderDisplay = (state, display) => {
  const formatter = MODE_FORMATTERS[state.display.mode] || formatDataLines;
  const [line0, line1] = formatter(state);
  display.clear();
  display.printLine(0, line0);
  display.printLine(1, line1);
};
