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

test("loadConfig carries the site and LED constants", () => {
  const cfg = loadConfig({ VIRTUAL_MODE: "true" });
  assert.equal(cfg.siteLat, 50.7744);
  assert.equal(cfg.siteLon, -2.4753);
  assert.equal(cfg.quietMarginMs, 30 * 60 * 1000);
  assert.equal(cfg.ledBlinkOnMs, 750);
  assert.equal(cfg.ledBlinkOffMs, 2250);
  assert.equal(cfg.ledQuietRecheckMs, 60000);
});

test("the quiet period is honoured unless explicitly overridden", () => {
  assert.equal(loadConfig({ VIRTUAL_MODE: "true" }).ignoreQuiet, false);
  assert.equal(loadConfig({ VIRTUAL_MODE: "true", LED_IGNORE_QUIET: "true" }).ignoreQuiet, true);
  assert.equal(loadConfig({ VIRTUAL_MODE: "true", LED_IGNORE_QUIET: "1" }).ignoreQuiet, false);
});
