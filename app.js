import "dotenv/config";
import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import {
  isVirtualMode, getMode, createSensor, createDisplay, createButton, createLed, setupKeyboardListener,
  cleanupKeyboardListener,
} from "piteknix";

import { loadConfig } from "./src/config.js";
import { appReducer, buttonPress, recordSample, pushResult } from "./src/store.js";
import { registerBacklightTimeout } from "./src/backlight.js";
import { registerLedBlink } from "./src/led.js";
import { isQuietPeriod } from "./src/solar.js";
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

// LED hardware sync — fires only when isLit actually changes
listener.startListening({
  predicate: (_action, curr, prev) => curr.led.isLit !== prev.led.isLit,
  // write() is async and the blink loop drives it up to 40x a minute, where the
  // backlight is written twice a day. Awaiting it inside a catch keeps a failed
  // GPIO write to one readable line instead of a listenerMiddleware/error
  // stack trace, and keeps the failure out of the blink loop.
  effect: async (_action, api) => {
    try {
      await led.write(api.getState().led.isLit);
    } catch (e) {
      console.error("led write failed:", e.message);
    }
  },
});

registerLedBlink(listener, {
  onMs: cfg.ledBlinkOnMs,
  offMs: cfg.ledBlinkOffMs,
  quietRecheckMs: cfg.ledQuietRecheckMs,
  isQuiet: (ts) =>
    !cfg.ignoreQuiet &&
    isQuietPeriod(ts, { lat: cfg.siteLat, lon: cfg.siteLon, marginMs: cfg.quietMarginMs }),
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
// Force a known dark state: SIGINT cleanup writes 0, but a crash or a pm2
// restart mid-run can leave the pin high.
await led.off();

// initial + interval polling; in-flight guard so a slow poll (hung 1-wire
// read) never overlaps the next tick
let polling = false;
const pollAll = async () => {
  if (polling) return;
  polling = true;
  try {
    await pollInternal(internal, store.dispatch);
    await pollExternal(external, store.dispatch);
    // one sample per cycle, after both sensors settle. A failed read records
    // null for that field — pollExternal nulls before diagnosing, pollInternal
    // nulls in its catch. See src/sensors.js.
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
    const res = await pushData(axios, { feedId: cfg.feedId, key: cfg.iotplotterKey }, store.getState());
    // null means no key configured (virtual mode) — neither success nor
    // failure, and counting it would arm the LED on every virtual run.
    if (res !== null) store.dispatch(pushResult(true));
  } catch (e) {
    console.error("push failed:", e.message);
    store.dispatch(pushResult(false));
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
  // First, before any hardware is torn down: cancel every pending listener
  // task. Otherwise the blink loop's in-flight api.delay fires after
  // led.cleanup() has unexported the pin and spends the rest of the shutdown
  // writing to a closed fd. Also cancels the pending backlight timeout, which
  // is what we want on the way out.
  listener.clearListeners();
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
