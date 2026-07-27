import { test } from "node:test";
import assert from "node:assert/strict";
import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import { appReducer, setExternalStatus, buttonPress } from "./store.js";
import { registerLedBlink } from "./led.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const makeStore = ({ quiet = false } = {}) => {
  const listener = createListenerMiddleware();
  registerLedBlink(listener, {
    onMs: 20,
    offMs: 20,
    quietRecheckMs: 20,
    isQuiet: () => quiet,
  });
  const store = configureStore({
    reducer: appReducer,
    middleware: (getDefault) => getDefault().prepend(listener.middleware),
  });
  const seen = [];
  store.subscribe(() => seen.push(store.getState().led.isLit));
  return { store, seen };
};

const goFaulty = (store) => store.dispatch(setExternalStatus({ status: "absent", detail: "no bus" }));
const walkToDiag = (store) => {
  store.dispatch(buttonPress()); // wake
  store.dispatch(buttonPress()); // MINMAX
  store.dispatch(buttonPress()); // DAYCOMP
  store.dispatch(buttonPress()); // DIAG -> acknowledged
};

test("a healthy device never lights the LED", async () => {
  const { store, seen } = makeStore();
  await wait(80);
  assert.equal(seen.includes(true), false);
  assert.equal(store.getState().led.isLit, false);
});

test("an unacknowledged fault pulses on and off", async () => {
  const { store, seen } = makeStore();
  goFaulty(store);
  await wait(70);
  assert.ok(seen.includes(true), "expected at least one lit pulse");
  assert.ok(seen.includes(false), "expected the pulse to end");
  walkToDiag(store);
  await wait(70);
});

test("the quiet period suppresses the pulse entirely", async () => {
  const { store, seen } = makeStore({ quiet: true });
  goFaulty(store);
  await wait(80);
  assert.equal(seen.includes(true), false, "the LED must never light during the quiet period");
  walkToDiag(store);
  await wait(40);
});

test("acknowledging stops the loop and leaves the LED dark", async () => {
  const { store } = makeStore();
  goFaulty(store);
  await wait(50);
  walkToDiag(store);
  await wait(80);
  assert.equal(store.getState().led.isLit, false);

  const before = store.getState().led;
  await wait(60);
  assert.equal(store.getState().led, before, "no further led state churn once disarmed");
});
