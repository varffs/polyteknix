import { test } from "node:test";
import assert from "node:assert/strict";
process.env.VIRTUAL_MODE = "true";
const { createSensor } = await import("piteknix");
const { pollExternal } = await import("./sensors.js");

test("pollExternal on dead sensor dispatches null temp + diagnosis", async () => {
  const sensor = await createSensor({ type: "ds18b20", id: "28-0301a279e8e6", virtual: { fault: "absent" } });
  const actions = [];
  await pollExternal(sensor, (a) => actions.push(a));
  const temp = actions.find((a) => a.type === "data/temperature/external");
  const status = actions.find((a) => a.type === "sensors/external/status");
  assert.equal(temp.payload, null);
  assert.equal(status.payload.status, "absent");
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
