import test from "node:test";
import assert from "node:assert/strict";
import {
  fixedGain, nextStep, normaliseStress, resolveResult, stressDieFaces, stressLimit
} from "../scripts/math.mjs";

test("Stress Die is the inverse of the hit die", () => {
  assert.equal(stressDieFaces("d6"), 12);
  assert.equal(stressDieFaces("d8"), 10);
  assert.equal(stressDieFaces("d10"), 8);
  assert.equal(stressDieFaces("d12"), 6);
});

test("PDF example: Reynauld, Paladin (d10 HD → d8 Stress Die), WIS +2", () => {
  const base = { firstFaces: 8, wisMod: 2 };
  assert.equal(stressLimit({ ...base, level: 1 }), 10);
  assert.equal(stressLimit({ ...base, level: 2, gains: [4] }), 16);
  assert.equal(fixedGain(8), 5);
  assert.equal(stressLimit({ ...base, level: 3, gains: [4, 5] }), 23);
});

test("Missing gains default to half +1", () => {
  assert.equal(stressLimit({ firstFaces: 8, wisMod: 2, level: 3, gains: [4] }), 23);
  assert.equal(stressLimit({ firstFaces: 8, wisMod: 2, level: 3, gains: [4, null] }), 23);
});

test("Tough (2024) adds 2 per level to the Limit", () => {
  assert.equal(stressLimit({ firstFaces: 8, wisMod: 2, level: 3, gains: [4, 5], tough: true }), 29);
});

test("Limit never drops below 1", () => {
  assert.equal(stressLimit({ firstFaces: 6, wisMod: -5, level: 1 }), 1);
});

test("Stress gains are at least 1 (CR 1/8 skeleton example)", () => {
  assert.equal(normaliseStress(0.125), 1);
  assert.equal(normaliseStress(0.5), 1);
  assert.equal(normaliseStress(3.4), 3);
  assert.equal(normaliseStress(-2), -2);
  assert.equal(normaliseStress(0), 0);
});

test("Resolve table ranges match the PDF", () => {
  const expect = [
    [1, "paranoid"], [10, "paranoid"], [11, "selfish"], [20, "selfish"], [21, "irrational"], [30, "irrational"],
    [31, "fearful"], [40, "fearful"], [41, "hopeless"], [50, "hopeless"], [51, "abusive"], [60, "abusive"],
    [61, "masochistic"], [70, "masochistic"], [71, "powerful"], [76, "powerful"], [77, "courageous"],
    [82, "courageous"], [83, "stalwart"], [88, "stalwart"], [89, "vigorous"], [94, "vigorous"],
    [95, "focused"], [100, "focused"]
  ];
  for ( const [roll, key] of expect ) assert.equal(resolveResult(roll).key, key, `d100 = ${roll}`);
  let afflictions = 0;
  for ( let r = 1; r <= 100; r++ ) if ( resolveResult(r).type === "affliction" ) afflictions++;
  assert.equal(afflictions, 70);
});

test("Variant Resolve uses signatures; Rapturous replaces both", () => {
  const sig = { affliction: "fearful", virtue: "stalwart" };
  assert.deepEqual(resolveResult(5, sig), { type: "affliction", key: "fearful" });
  assert.deepEqual(resolveResult(99, sig), { type: "virtue", key: "stalwart" });
  assert.deepEqual(resolveResult(99, { affliction: "rapturous" }), { type: "affliction", key: "rapturous" });
});

test("Thresholds: resolve at the Limit, mortality at double, one condition at a time", () => {
  assert.equal(nextStep({ stress: 9, limit: 10, state: null, gained: true }), null);
  assert.equal(nextStep({ stress: 10, limit: 10, state: null, gained: true }), "resolve");
  assert.equal(nextStep({ stress: 15, limit: 10, state: "afflicted", gained: true }), null);
  assert.equal(nextStep({ stress: 20, limit: 10, state: "afflicted", gained: true }), "mortality");
  assert.equal(nextStep({ stress: 20, limit: 10, state: "virtuous", gained: true }), "mortality");
  assert.equal(nextStep({ stress: 25, limit: 10, state: "afflicted", gained: true, heartAttack: true }), null);
  assert.equal(nextStep({ stress: 0, limit: 10, state: "afflicted", gained: false }), "clearAffliction");
  assert.equal(nextStep({ stress: 0, limit: 10, state: "virtuous", gained: false }), null);
});
