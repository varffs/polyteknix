import "dotenv/config";
import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import {
  isVirtualMode, getMode, createSensor, createDisplay, createButton, createLed, setupKeyboardListener,
  cleanupKeyboardListener,
} from "piteknix";

import { loadConfig } from "./src/config.js";
import { appReducer, buttonPress, recordSample } from "./src/store.js";
import { registerBacklightTimeout } from "./src/backlight.js";
import { renderDisplay } from "./src/render.js";
import { pollInternal, pollExternal } from "./src/sensors.js";
import { pushData } from "./src/push.js";
import axios from "axios";

const cfg = loadConfig();
console.log(`polyteknix starting in ${getMode()} mode`);

// Hardware (auto virtual/real)
const internal = await createSensor({ type: "aht20", calibrationOffset: cfg.tempCalibrationOffset });
const external = await createSensor({ type: "ds18b20", id: cfg.externalSensorId });
const display = await createDisplay({ type: "lcd", width: 16, height: 2 });
const led = createLed({ gpio: 17 });
const button = createButton({ gpio: 27, virtualKey: "1" });

// Redux + listener-driven render
const listener = createListenerMiddleware();
listener.startListening({
  predicate: (action) =>
    action.type.startsWith("data/") ||
    action.type.startsWith("sensors/") ||
    action.type.startsWith("display/") ||
    action.type.startsWith("history/"),
  effect: (_action, api) => renderDisplay(api.getState(), display),
});

// Backlight hardware sync — fires only when isBacklit actually changes
listener.startListening({
  predicate: (_action, curr, prev) => curr.display.isBacklit !== prev.display.isBacklit,
  effect: (_action, api) => display.setBacklight(api.getState().display.isBacklit),
});

registerBacklightTimeout(listener, { timeoutMs: cfg.backlightTimeoutMs });
const store = configureStore({
  reducer: appReducer,
  middleware: (getDefault) => getDefault().prepend(listener.middleware),
});

// boot behaves like a first press: light up, arm the sleep timer. Dispatched
// before the initial poll so a slow 1-wire read can't delay arming it.
store.dispatch(buttonPress());

await display.clear();
display.printLine(0, "starting up...");
await led.on();

// initial + interval polling; in-flight guard so a slow poll (hung 1-wire
// read) never overlaps the next tick
let polling = false;
const pollAll = async () => {
  if (polling) return;
  polling = true;
  try {
    await pollInternal(internal, store.dispatch);
    await pollExternal(external, store.dispatch);
    // one sample per cycle, after both sensors settle — a failed read records
    // as null for that field rather than skipping the sample entirely
    store.dispatch(recordSample(Date.now()));
  } finally {
    polling = false;
  }
};
await pollAll();
const poll = setInterval(pollAll, cfg.pollMs);

// in-flight guard: a slow POST skips the next tick instead of overlapping
let pushing = false;
const push = setInterval(async () => {
  if (pushing) return;
  pushing = true;
  try {
    await pushData(axios, { feedId: cfg.feedId, key: cfg.iotplotterKey }, store.getState());
  } catch (e) {
    console.error("push failed:", e.message);
  } finally {
    pushing = false;
  }
}, cfg.pollMs);

if (isVirtualMode()) {
  setupKeyboardListener({ onDebug: () => console.log(JSON.stringify(store.getState(), null, 2)) });
}
// Button (GPIO 27 / key "1") is context-sensitive: wakes backlight when dark, cycles DEFAULT <-> DIAG when lit
button.watch(() => store.dispatch(buttonPress()));

process.on("SIGINT", async () => {
  clearInterval(poll);
  clearInterval(push);
  await led.cleanup();
  await button.cleanup();
  await display.cleanup();
  await internal.cleanup();
  await external.cleanup();
  if (isVirtualMode()) {
    cleanupKeyboardListener();
  }
  process.exit();
});
