import { test } from "node:test";
import assert from "node:assert/strict";
import { selectWindow, selectMinMax, selectDayMinMax, DAY_MS } from "./history.js";

const at = (y, m, d, h) => new Date(y, m, d, h, 0, 0).getTime();
const NOW = at(2026, 6, 26, 12); // Sun 26 Jul 2026, 12:00 local

test("selectWindow keeps only samples inside the window", () => {
  const samples = [
    { ts: at(2026, 6, 25, 6) }, // 30h ago
    { ts: at(2026, 6, 25, 18) }, // 18h ago
    { ts: at(2026, 6, 26, 11) }, // 1h ago
  ];
  const got = selectWindow(samples, DAY_MS, NOW);
  assert.deepEqual(
    got.map((s) => s.ts),
    [at(2026, 6, 25, 18), at(2026, 6, 26, 11)],
  );
});

test("selectWindow excludes a sample exactly on the window boundary", () => {
  const samples = [{ ts: NOW - DAY_MS }, { ts: NOW - DAY_MS + 1 }];
  const got = selectWindow(samples, DAY_MS, NOW);
  assert.deepEqual(
    got.map((s) => s.ts),
    [NOW - DAY_MS + 1],
  );
});

test("selectWindow excludes samples from the future", () => {
  const got = selectWindow([{ ts: NOW + 1000 }], DAY_MS, NOW);
  assert.deepEqual(got, []);
});

test("selectMinMax returns null for an empty list", () => {
  assert.equal(selectMinMax([], "temperature_internal"), null);
});

test("selectMinMax returns null when the field is null in every sample", () => {
  const samples = [{ ts: 1, temperature_external: null }, { ts: 2, temperature_external: null }];
  assert.equal(selectMinMax(samples, "temperature_external"), null);
});

test("selectMinMax skips null values but uses the rest", () => {
  const samples = [
    { ts: 1, temperature_internal: null },
    { ts: 2, temperature_internal: -3.2 },
    { ts: 3, temperature_internal: 31.4 },
  ];
  assert.deepEqual(selectMinMax(samples, "temperature_internal"), { min: -3.2, max: 31.4 });
});

test("selectMinMax on a single sample gives equal min and max", () => {
  assert.deepEqual(selectMinMax([{ ts: 1, temperature_internal: 20 }], "temperature_internal"), {
    min: 20,
    max: 20,
  });
});

test("selectDayMinMax separates today from yesterday across local midnight", () => {
  const samples = [
    { ts: at(2026, 6, 25, 4), temperature_internal: -1.9 },
    { ts: at(2026, 6, 25, 15), temperature_internal: 28.8 },
    { ts: at(2026, 6, 26, 3), temperature_internal: -3.2 },
    { ts: at(2026, 6, 26, 11), temperature_internal: 31.4 },
  ];
  assert.deepEqual(selectDayMinMax(samples, "temperature_internal", 0, NOW), {
    min: -3.2,
    max: 31.4,
  });
  assert.deepEqual(selectDayMinMax(samples, "temperature_internal", 1, NOW), {
    min: -1.9,
    max: 28.8,
  });
});

test("selectDayMinMax returns null when the requested day has no samples", () => {
  const samples = [{ ts: at(2026, 6, 26, 11), temperature_internal: 31.4 }];
  assert.equal(selectDayMinMax(samples, "temperature_internal", 1, NOW), null);
});

test("selectDayMinMax counts a sample at one second past midnight as today", () => {
  const justAfterMidnight = new Date(2026, 6, 26, 0, 0, 1).getTime();
  const samples = [{ ts: justAfterMidnight, temperature_internal: 9.9 }];
  assert.deepEqual(selectDayMinMax(samples, "temperature_internal", 0, NOW), { min: 9.9, max: 9.9 });
  assert.equal(selectDayMinMax(samples, "temperature_internal", 1, NOW), null);
});
