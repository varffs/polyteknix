export const loadConfig = (env = process.env) => {
  const isVirtual = env.VIRTUAL_MODE === "true";
  const iotplotterKey = env.IOTPLOTTER_KEY || null;
  if (!iotplotterKey && !isVirtual) {
    throw new Error("IOTPLOTTER_KEY is required in hardware mode (set it in .env)");
  }
  return {
    iotplotterKey,
    feedId: "408491097864656092",
    pollMs: isVirtual ? 3000 : 1000 * 60 * 5,
    backlightTimeoutMs: 30000,
    tempCalibrationOffset: 1.2,
    externalSensorId: "28-0301a279e8e6",
  };
};
