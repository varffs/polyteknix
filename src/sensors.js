import { setInternalTemp, setInternalHumidity, setExternalTemp, setExternalStatus } from "./store.js";

export const pollExternal = async (sensor, dispatch) => {
  try {
    const { temperature } = await sensor.read();
    dispatch(setExternalTemp(temperature));
    dispatch(setExternalStatus({ status: "ok", detail: `reading ${temperature}c` }));
  } catch {
    dispatch(setExternalTemp(null));
    let diag;
    try {
      diag = await sensor.diagnose();
    } catch (e) {
      diag = { status: "error", detail: `diagnose failed: ${e.message}` };
    }
    dispatch(setExternalStatus({ status: diag.status, detail: diag.detail }));
  }
};

export const pollInternal = async (sensor, dispatch) => {
  try {
    const { temperature, humidity } = await sensor.read();
    dispatch(setInternalTemp(temperature));
    dispatch(setInternalHumidity(humidity));
  } catch (e) {
    console.error("internal sensor read failed:", e.message);
  }
};
