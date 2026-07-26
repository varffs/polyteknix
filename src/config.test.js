import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("loadConfig reads key from env", () => {
  const cfg = loadConfig({ IOTPLOTTER_KEY: "abc", VIRTUAL_MODE: "false" });
  assert.equal(cfg.iotplotterKey, "abc");
  assert.equal(cfg.feedId, "408491097864656092");
  assert.equal(cfg.backlightTimeoutMs, 30000);
});

test("loadConfig throws on missing key in hardware mode", () => {
  assert.throws(() => loadConfig({ VIRTUAL_MODE: "false" }), /IOTPLOTTER_KEY/);
});

test("loadConfig allows missing key in virtual mode", () => {
  const cfg = loadConfig({ VIRTUAL_MODE: "true" });
  assert.equal(cfg.iotplotterKey, null);
});
