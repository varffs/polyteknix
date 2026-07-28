import { setInternalTemp, setInternalHumidity, setExternalTemp, setExternalStatus, setInternalStatus } from "./store.js";

const diagnoseAndDispatch = async (sensor, dispatch) => {
  dispatch(setExternalTemp(null));
  let diag;
  try {
    diag = await sensor.diagnose();
  } catch (e) {
    diag = { status: "error", detail: `diagnose failed: ${e.message}` };
  }
  dispatch(setExternalStatus({ status: diag.status, detail: diag.detail }));
};

export const pollExternal = async (sensor, dispatch) => {
  try {
    const { temperature } = await sensor.read();
    // 85.0 is the DS18B20 power-on default: a "successful" read of it means
    // the conversion never ran (power/wiring fault), not a real temperature
    if (Math.abs(temperature - 85) < 0.05) {
      await diagnoseAndDispatch(sensor, dispatch);
      return;
    }
    dispatch(setExternalTemp(temperature));
    dispatch(setExternalStatus({ status: "ok", detail: `reading ${temperature}c` }));
  } catch {
    await diagnoseAndDispatch(sensor, dispatch);
  }
};

export const pollInternal = async (sensor, dispatch) => {
  try {
    const { temperature, humidity } = await sensor.read();
    dispatch(setInternalTemp(temperature));
    dispatch(setInternalHumidity(humidity));
    dispatch(setInternalStatus("ok"));
  } catch (e) {
    console.error("internal sensor read failed:", e.message);
    dispatch(setInternalTemp(null));
    dispatch(setInternalHumidity(null));
    dispatch(setInternalStatus("error"));
  }
};
