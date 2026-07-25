import { test } from "node:test";
import assert from "node:assert/strict";
import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import { appReducer, buttonPress } from "./store.js";
import { registerBacklightTimeout } from "./backlight.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const makeStore = (timeoutMs) => {
  const listener = createListenerMiddleware();
  registerBacklightTimeout(listener, { timeoutMs });
  return configureStore({
    reducer: appReducer,
    middleware: (getDefault) => getDefault().prepend(listener.middleware),
  });
};

test("backlight sleeps after the timeout", async () => {
  const store = makeStore(25);
  store.dispatch(buttonPress());
  assert.equal(store.getState().display.isBacklit, true);
  await wait(60);
  assert.equal(store.getState().display.isBacklit, false);
  assert.equal(store.getState().display.mode, "DEFAULT");
});

test("a press mid-window resets the timeout", async () => {
  const store = makeStore(50);
  store.dispatch(buttonPress());          // lit, timer armed
  await wait(30);
  store.dispatch(buttonPress());          // lit -> cycles mode, re-arms timer
  await wait(30);                         // 60ms after first press, 30ms after second
  assert.equal(store.getState().display.isBacklit, true, "reset should have kept it lit");
  assert.equal(store.getState().display.mode, "DIAG");
  await wait(40);                         // 70ms after second press — past its window
  assert.equal(store.getState().display.isBacklit, false);
});

test("press while lit cycles the mode", async () => {
  const store = makeStore(200); // short enough not to hold the event loop long after the suite

  store.dispatch(buttonPress());
  store.dispatch(buttonPress());
  assert.equal(store.getState().display.mode, "DIAG");
  assert.equal(store.getState().display.isBacklit, true);
});
