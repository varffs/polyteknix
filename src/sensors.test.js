import { test } from "node:test";
import assert from "node:assert/strict";
process.env.VIRTUAL_MODE = "true";
const { createSensor } = await import("piteknix");
const { pollExternal, pollInternal } = await import("./sensors.js");

test("pollExternal on dead sensor dispatches null temp + diagnosis", async () => {
  const sensor = await createSensor({ type: "ds18b20", id: "28-0301a279e8e6", virtual: { fault: "absent" } });
  const actions = [];
  await pollExternal(sensor, (a) => actions.push(a));
  const temp = actions.find((a) => a.type === "data/temperature/external");
  const status = actions.find((a) => a.type === "sensors/external/status");
  assert.equal(temp.payload, null);
  assert.equal(status.payload.status, "absent");
});

test("pollExternal on stuck-85 sensor dispatches null temp + power-fault diagnosis", async () => {
  const sensor = await createSensor({ type: "ds18b20", id: "28-0301a279e8e6", virtual: { fault: "stuck85" } });
  const actions = [];
  await pollExternal(sensor, (a) => actions.push(a));
  const temp = actions.find((a) => a.type === "data/temperature/external");
  const status = actions.find((a) => a.type === "sensors/external/status");
  assert.equal(temp.payload, null);
  assert.equal(status.payload.status, "error");
  assert.match(status.payload.detail, /85/);
});

test("pollExternal on healthy sensor dispatches numeric temp + ok", async () => {
  const sensor = await createSensor({ type: "ds18b20", id: "28-x", virtual: { temperature: { min: 12, max: 12, initialValue: 12 } } });
  const actions = [];
  await pollExternal(sensor, (a) => actions.push(a));
  const temp = actions.find((a) => a.type === "data/temperature/external");
  const status = actions.find((a) => a.type === "sensors/external/status");
  assert.equal(temp.payload, 12);
  assert.equal(status.payload.status, "ok");
});

test("pollInternal on healthy sensor dispatches numeric temp + humidity", async () => {
  const sensor = await createSensor({
    type: "aht20",
    virtual: {
      temperature: { min: 20, max: 20, initialValue: 20 },
      humidity: { min: 50, max: 50 },
    },
  });
  const actions = [];
  await pollInternal(sensor, (a) => actions.push(a));
  const temp = actions.find((a) => a.type === "data/temperature/internal");
  const humidity = actions.find((a) => a.type === "data/humidity/internal");
  assert.equal(temp.payload, 20);
  assert.equal(humidity.payload, 50);
});

test("pollInternal on dead sensor dispatches null temp + null humidity and does not throw", async () => {
  const sensor = await createSensor({ type: "aht20", virtual: { fault: "enoent" } });
  const actions = [];
  await assert.doesNotReject(() => pollInternal(sensor, (a) => actions.push(a)));
  const temp = actions.find((a) => a.type === "data/temperature/internal");
  const humidity = actions.find((a) => a.type === "data/humidity/internal");
  assert.equal(temp.payload, null);
  assert.equal(humidity.payload, null);
});
