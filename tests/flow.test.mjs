/**
 * Runs the Stress workflow against a minimal fake of the Foundry/dnd5e APIs it touches.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- Fake Foundry globals ----
let nextRolls = [];
const messages = [];
const settings = { chatOnChange: true, variantResolve: false, safeRestDefault: false };
globalThis.game = {
  settings: { get: (_, key) => settings[key] },
  i18n: { localize: k => k, format: (k, d) => `${k} ${JSON.stringify(d)}` },
  time: { worldTime: 0 },
  user: { isGM: true, id: "gm" },
  users: { activeGM: { id: "gm" } }
};
globalThis.ui = { notifications: { warn: m => messages.push({ warn: m }) } };
globalThis.ChatMessage = {
  create: data => { messages.push(data); return data; },
  getSpeaker: () => ({}),
  getWhisperRecipients: () => []
};
globalThis.Roll = class {
  constructor(formula, data={}) { this.formula = formula; this.data = data; }
  async evaluate() {
    const die = nextRolls.length ? nextRolls.shift() : 1;
    this.total = die + (this.data.wis ?? 0);
    return this;
  }
  async toMessage(data) { messages.push({ roll: this.total, ...data }); }
};

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for ( const p of parts.slice(0, -1) ) o = (o[p] ??= {});
  o[parts.at(-1)] = value;
}

function makeActor({ level, hd, wis, classes }) {
  classes ??= [{ id: "c1", name: "Class", system: { levels: level, hd: { denomination: hd, spent: 0, value: level } } }];
  for ( const c of classes ) c.update = async u => {
    c.system.hd.spent = u["system.hd.spent"];
    c.system.hd.value = c.system.levels - c.system.hd.spent;
  };
  const actor = {
    type: "character",
    name: "Hero",
    isOwner: true,
    uuid: "Actor.x",
    flags: {},
    statuses: new Set(),
    classes: Object.fromEntries(classes.map(c => [c.id, c])),
    system: {
      details: { level, originalClass: classes[0].id },
      abilities: { wis: { mod: wis } },
      attributes: { hp: { value: 20 }, death: { success: 0, failure: 0 } }
    },
    async setFlag(scope, key, value) { setPath(this.flags, `${scope}.${key}`, value); },
    async update(changes) {
      for ( const [k, v] of Object.entries(changes) ) {
        if ( k.startsWith("flags.") ) setPath(this.flags, k.slice(6), v);
        else setPath(this, k, v);
      }
    },
    async toggleStatusEffect(id, { active }) { active ? this.statuses.add(id) : this.statuses.delete(id); }
  };
  return actor;
}

const S = await import("../scripts/stress.mjs");

beforeEach(() => { nextRolls = []; messages.length = 0; settings.variantResolve = false; game.time.worldTime = 0; });

test("Reynauld (level 1 Paladin, WIS +2) has a Stress Limit of 10", () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  assert.equal(S.getLimit(a), 10);
});

test("Reaching the Limit rolls Resolve; an affliction applies its status", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [35]; // Fearful
  await S.addStress(a, 10);
  const d = S.getData(a);
  assert.equal(d.value, 10);
  assert.equal(d.state, "afflicted");
  assert.equal(d.condition, "fearful");
  assert.ok(a.statuses.has("sr-fearful"));
});

test("A virtue halves Stress to half the Limit", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [90]; // Vigorous
  await S.addStress(a, 12);
  const d = S.getData(a);
  assert.equal(d.state, "virtuous");
  assert.equal(d.value, 5);
});

test("No second Resolve check while afflicted", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [5];
  await S.addStress(a, 10);
  await S.addStress(a, -5);
  nextRolls = [99];
  await S.addStress(a, 5);
  assert.equal(S.getData(a).condition, "paranoid");
});

test("Afflicted Mortality: heart attack at double the Limit, recovery sets Stress to the Limit", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [5];
  await S.addStress(a, 10);
  await S.addStress(a, 10);
  assert.equal(a.system.attributes.hp.value, 0);
  assert.equal(a.system.attributes.death.failure, 2);
  assert.equal(S.getData(a).heartAttack, true);
  await S.addStress(a, 3); // no second heart attack while pending
  assert.equal(S.getData(a).value, 23);
  await S.recoverFromHeartAttack(a);
  assert.equal(S.getData(a).value, 10);
  assert.equal(S.getData(a).heartAttack, false);
  assert.equal(S.getData(a).state, "afflicted");
});

test("Virtuous Mortality (house rule): heart attack, Stress to 0, virtue ends", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [80];
  await S.addStress(a, 10); // courageous, Stress 5
  await S.addStress(a, 15); // 20 = 2 × Limit
  const d = S.getData(a);
  assert.equal(d.value, 0);
  assert.equal(d.state, null);
  assert.equal(a.statuses.size, 0);
  assert.equal(a.system.attributes.hp.value, 0);
  assert.equal(a.system.attributes.death.failure, 2);
  assert.equal(d.heartAttack, true);
});

test("A single huge hit resolves, then faces Mortality", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [5];
  await S.addStress(a, 25);
  assert.equal(S.getData(a).heartAttack, true);
});

test("Stress reaching 0 ends an affliction", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [5];
  await S.addStress(a, 10);
  await S.addStress(a, -20);
  assert.equal(S.getData(a).state, null);
  assert.equal(S.getData(a).value, 0);
});

test("Barristan (level 5 Fighter): a Stress Die spends a hit die and heals 1d8 + WIS", async () => {
  const a = makeActor({ level: 5, hd: "d10", wis: 1 });
  await a.setFlag("stress-and-resolve", "value", 12);
  nextRolls = [6];
  await S.spendStressDie(a, "d10");
  assert.equal(S.getData(a).value, 5);
  assert.equal(a.classes.c1.system.hd.value, 4);
  assert.match(messages.find(m => m.roll !== undefined) ? "ok" : "", /ok/);
});

test("Long rests: any ends a virtue; a safe one clears Stress and afflictions", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [80];
  await S.addStress(a, 10);
  await S.onLongRest(a, { safe: false });
  assert.equal(S.getData(a).state, null);
  assert.equal(S.getData(a).value, 5);

  nextRolls = [5];
  await S.addStress(a, 5);
  await S.onLongRest(a, { safe: false });
  assert.equal(S.getData(a).state, "afflicted");
  await S.onLongRest(a, { safe: true });
  assert.equal(S.getData(a).state, null);
  assert.equal(S.getData(a).value, 0);
});

test("Madness reminder after three days afflicted", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [5];
  await S.addStress(a, 10);
  game.time.worldTime = 3 * 86400;
  messages.length = 0;
  await S.onLongRest(a, { safe: false });
  assert.ok(messages.some(m => String(m.content).includes("MadnessReminder")));
});

test("Variant Resolve uses the signature affliction", async () => {
  settings.variantResolve = true;
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  await a.setFlag("stress-and-resolve", "signature", { affliction: "hopeless", virtue: "focused" });
  nextRolls = [5];
  await S.addStress(a, 10);
  assert.equal(S.getData(a).condition, "hopeless");
});

test("Divine Intervention style check ignores afflictions", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [5];
  await S.resolveCheck(a, { virtueOnly: true });
  assert.equal(S.getData(a).state, null);
  nextRolls = [96];
  await S.resolveCheck(a, { virtueOnly: true });
  assert.equal(S.getData(a).condition, "focused");
});

test("Regression: a stale heart-attack marker no longer blocks Mortality", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  await a.setFlag("stress-and-resolve", "heartAttack", true); // left over, but HP is 20
  nextRolls = [5];
  await S.addStress(a, 20);
  assert.equal(a.system.attributes.hp.value, 0);
  assert.equal(a.system.attributes.death.failure, 2);
});

test("Regression: a failing token icon doesn't stop Mortality", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  a.toggleStatusEffect = async () => { throw new Error("Invalid status ID"); };
  nextRolls = [5];
  await S.addStress(a, 20);
  assert.equal(S.getData(a).state, "afflicted");
  assert.equal(a.system.attributes.hp.value, 0);
});

test("Regression: failing chat doesn't stop Mortality", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  const create = ChatMessage.create;
  const toMessage = Roll.prototype.toMessage;
  ChatMessage.create = () => { throw new Error("chat down"); };
  Roll.prototype.toMessage = async () => { throw new Error("chat down"); };
  try {
    nextRolls = [5];
    await S.addStress(a, 10);
    await S.addStress(a, 10);
    assert.equal(a.system.attributes.hp.value, 0);
  } finally {
    ChatMessage.create = create;
    Roll.prototype.toMessage = toMessage;
  }
});

test("Stepping up to double the Limit one point at a time triggers the heart attack", async () => {
  const a = makeActor({ level: 3, hd: "d10", wis: 2 }); // Limit 24 (fixed gains)
  nextRolls = [5];
  for ( let i = 0; i < 48; i++ ) await S.addStress(a, 1);
  assert.equal(S.getData(a).value, 48);
  assert.equal(a.system.attributes.hp.value, 0);
  assert.equal(a.system.attributes.death.failure, 2);
});

test("GM Mortality button on a character with no condition tests Resolve first", async () => {
  const a = makeActor({ level: 1, hd: "d10", wis: 2 });
  nextRolls = [5];
  await S.mortality(a);
  assert.equal(S.getData(a).state, "afflicted");
  assert.equal(a.system.attributes.hp.value, 0);
});
