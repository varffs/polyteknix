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
  const store = makeStore(100);
  store.dispatch(buttonPress());
  assert.equal(store.getState().display.isBacklit, true);
  await wait(240);
  assert.equal(store.getState().display.isBacklit, false);
  assert.equal(store.getState().display.mode, "DEFAULT");
});

test("a press mid-window resets the timeout", async () => {
  const store = makeStore(200);
  store.dispatch(buttonPress());          // lit, timer armed
  await wait(120);
  store.dispatch(buttonPress());          // lit -> cycles mode, re-arms timer
  await wait(120);                        // 240ms after first press, 120ms after second
  assert.equal(store.getState().display.isBacklit, true, "reset should have kept it lit");
  assert.equal(store.getState().display.mode, "MINMAX");
  await wait(160);                        // 280ms after second press — past its window
  assert.equal(store.getState().display.isBacklit, false);
});

test("press while lit cycles the mode", async () => {
  const store = makeStore(30);

  store.dispatch(buttonPress());
  store.dispatch(buttonPress());
  assert.equal(store.getState().display.mode, "MINMAX");
  assert.equal(store.getState().display.isBacklit, true);
  await wait(50); // let the armed timer fire so no pending listener outlives the test
});
