/**
 * Affliction and virtue effects against a fake Foundry: turns, auras, virtue rolls, fear, aid refusal.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---- Fake Foundry ----
let rolls = [];
const chat = [];
const hooks = {};
const settings = { turnReminders: true, chatOnChange: false, variantResolve: false, automateEffects: true, nearbyRange: 30,
  gateAid: true, fearStress: true, debug: false };
globalThis.Hooks = {
  on: (n, f) => (hooks[n] ??= []).push(f),
  call: (n, ...a) => { for ( const f of hooks[n] ?? [] ) if ( f(...a) === false ) return false; return true; },
  callAll: (n, ...a) => (hooks[n] ?? []).forEach(f => f(...a))
};
globalThis.game = {
  settings: { get: (_, k) => settings[k] },
  i18n: { localize: k => k, format: (k, d) => `${k} ${JSON.stringify(d)}` },
  time: { worldTime: 0 },
  user: { isGM: true, id: "gm", targets: new Set() },
  users: Object.assign([{ id: "gm", isGM: true }, { id: "p1", isGM: false }, { id: "p2", isGM: false }], { activeGM: { id: "gm" } }),
  combat: null
};
globalThis.ui = { notifications: { warn: m => chat.push({ warn: m }) } };
globalThis.foundry = { applications: { api: { DialogV2: { wait: async () => "skip" } } }, utils: { escapeHTML: s => s, setProperty: (o, p, v) => { const k = p.split("."); let x = o;
  for ( const q of k.slice(0, -1) ) x = (x[q] ??= {}); x[k.at(-1)] = v; } } };
globalThis.CONFIG = { DND5E: { damageTypes: { slashing: { label: "Slashing" } } }, Dice: {} };
globalThis.ChatMessage = { create: d => { chat.push(d); return d; }, getSpeaker: () => ({}), getWhisperRecipients: () => [] };
globalThis.Roll = class {
  constructor(formula, data={}) { this.formula = formula; this.data = data; }
  async evaluate() {
    const faces = Number(this.formula.match(/d(\d+)/)?.[1] ?? 6);
    const die = rolls.length ? rolls.shift() : 1;
    assert.ok(die >= 1 && die <= faces, `queued ${die} doesn't fit ${this.formula}`);
    this.total = die + (this.data.wis ?? 0);
    return this;
  }
  async toMessage(d) { chat.push({ roll: this.total, ...d }); }
};
globalThis.Actor = class {};
globalThis.Item = class {};
globalThis.ActiveEffect = { implementation: { fromStatusEffect: async id => ({ toObject: () => ({ name: id, statuses: [id] }) }) } };
globalThis.fromUuidSync = uuid => actorsByUuid[uuid] ?? null;
const actorsByUuid = {};

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for ( const p of parts.slice(0, -1) ) o = (o[p] ??= {});
  o[parts.at(-1)] = value;
}

let idn = 0;
function makeActor(name, { type="character", level=5, prof=3, cr=null, hp=30 }={}) {
  const a = new Actor();
  const id = `a${++idn}`;
  Object.assign(a, {
    id, uuid: `Actor.${id}`, name, type, isOwner: true, flags: {}, statuses: new Set(), effects: [],
    prototypeToken: { disposition: type === "character" ? 1 : -1 },
    classes: { c: { id: "c", system: { hd: { denomination: "d10", value: level, spent: 0 }, levels: level } } },
    items: { find: () => null, get: () => null },
    system: {
      details: { level, originalClass: "c", cr },
      abilities: { wis: { mod: 2 } },
      attributes: { prof, hp: { value: hp, temp: 0 }, death: { success: 0, failure: 0 } },
      traits: { ci: { value: new Set() } }
    },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    testUserPermission(u) { return u.id === "p1"; },
    async setFlag(scope, key, value) { setPath(this.flags, `${scope}.${key}`, value); },
    async update(changes) {
      for ( const [k, v] of Object.entries(changes) ) {
        if ( k.startsWith("flags.") ) setPath(this.flags, k.slice(6), v); else setPath(this, k, v);
      }
    },
    async toggleStatusEffect(sid, { active }) {
      if ( active ) {
        this.statuses.add(sid);
        this.effects.push(makeEffect(this, { statuses: new Set([sid]) }));
      } else {
        this.statuses.delete(sid);
        this.effects = this.effects.filter(e => !e.statuses?.has(sid));
      }
    },
    async createEmbeddedDocuments(_, list) {
      const made = list.map(d => makeEffect(this, { ...d, statuses: new Set(d.statuses ?? []) }));
      this.effects.push(...made);
      for ( const e of made ) Hooks.callAll("createActiveEffect", e, {}, "gm");
      return made;
    },
    async deleteEmbeddedDocuments(_, ids) { this.effects = this.effects.filter(e => !ids.includes(e.id)); },
    async applyDamage(d) { this.damageTaken = (this.damageTaken ?? []).concat(d); this.system.attributes.hp.value -= d[0].value; },
    async rollSavingThrow() { this.saves = (this.saves ?? 0) + 1; return [{ isSuccess: false }]; },
    async applyTempHP(n) { this.system.attributes.hp.temp = Math.max(this.system.attributes.hp.temp, n); }
  });
  actorsByUuid[a.uuid] = a;
  return a;
}
function makeEffect(parent, data) {
  return { id: `e${++idn}`, parent, ...data, getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
    async update(u) { Object.assign(this, { changes: u.changes ?? u["system.changes"] }); } };
}

// Scene: 100px squares, 5 ft each.
function place(actor, gx, gy, disposition) {
  return { actor, actorId: actor.id, name: actor.name, x: gx * 100, y: gy * 100, width: 1, height: 1,
    disposition: disposition ?? actor.prototypeToken.disposition };
}
function setup(entries) {
  const tokens = entries.map(([a, x, y, d]) => place(a, x, y, d));
  const scene = { grid: { size: 100, distance: 5 }, tokens };
  globalThis.canvas = { scene };
  const combatants = tokens.map((t, i) => ({ id: `c${i}`, actor: t.actor, actorId: t.actor.id, token: t, name: t.name,
    isDefeated: false }));
  const combat = { started: true, scene, combatants: Object.assign(combatants, { get: id => combatants.find(c => c.id === id) }) };
  game.combat = combat;
  return { combat, c: id => combatants.find(c => c.actor === id).id };
}
let round = 1;
async function turn(combat, fromId, toId) {
  round++;
  Hooks.callAll("combatTurnChange", combat, { combatantId: fromId, round: round - 1 }, { combatantId: toId, round });
  await new Promise(r => setTimeout(r, 30));
}

const S = await import("../scripts/stress.mjs");
const { registerEffects } = await import("../scripts/effects.mjs");
const { tokenDistance } = await import("../scripts/math.mjs");
const { registerHandler } = await import("../scripts/socket.mjs");
registerEffects();

beforeEach(() => { rolls = []; chat.length = 0; game.user.targets = new Set(); });

async function afflict(actor, key, state="afflicted") {
  await S.setCondition(actor, state, key);
}

test("Distance uses 5-5-5 diagonals", () => {
  const g = { size: 100, distance: 5 };
  const t = (x, y, w=1) => ({ x: x * 100, y: y * 100, width: w, height: w });
  assert.equal(tokenDistance(t(0, 0), t(1, 0), g), 5);
  assert.equal(tokenDistance(t(0, 0), t(6, 0), g), 30);
  assert.equal(tokenDistance(t(0, 0), t(3, 3), g), 15);
  assert.equal(tokenDistance(t(0, 0, 2), t(3, 0), g), 10); // large creature, edge to edge
});

test("Afflicted aura: 1d4 Stress to allies within 30 ft at the end of the turn, not to Vigorous or far allies", async () => {
  const bad = makeActor("Bad"), near = makeActor("Near"), far = makeActor("Far"), vig = makeActor("Vig");
  const enemy = makeActor("Orc", { type: "npc", cr: 1 });
  const { combat, c } = setup([[bad, 0, 0], [near, 6, 0], [far, 7, 0], [vig, 1, 1], [enemy, 3, 3]]);
  await afflict(bad, "selfish");
  await afflict(vig, "vigorous", "virtuous");
  rolls = [3];
  await turn(combat, c(bad), c(near));
  assert.equal(S.getData(near).value, 3);
  assert.equal(S.getData(far).value, 0);
  assert.equal(S.getData(vig).value, 0);
  assert.equal(S.getData(bad).value, 0);
});

test("Irrational: 6 attacks themself for 1d8, 4–5 causes 1d6 Stress to self and allies", async () => {
  const irr = makeActor("Irr"), ally = makeActor("Ally");
  const { combat, c } = setup([[irr, 0, 0], [ally, 1, 0]]);
  await afflict(irr, "irrational");
  rolls = [6, 5];
  await turn(combat, null, c(irr));
  assert.equal(irr.damageTaken?.[0]?.value, 5);
  rolls = [1, 4, 2]; // aura d4 at end of turn, then start: d6 = 4, rant 1d6 = 2
  await turn(combat, c(irr), c(irr));
  assert.equal(S.getData(ally).value, 1 + 2);
  assert.equal(S.getData(irr).value, 2);
});

test("Hopeless adds 1d4 to Stress gains; Stalwart reduces them by Proficiency (minimum 1)", async () => {
  const h = makeActor("H"), s = makeActor("S", { prof: 3 });
  setup([[h, 0, 0], [s, 5, 5]]);
  await afflict(h, "hopeless");
  await afflict(s, "stalwart", "virtuous");
  rolls = [2];
  await S.addStress(h, 3);
  assert.equal(S.getData(h).value, 5);
  await S.addStress(s, 5);
  assert.equal(S.getData(s).value, 2);
  await S.addStress(s, 2);
  assert.equal(S.getData(s).value, 3);
  // Typing a value by hand ignores modifiers
  await S.setStress(h, 9);
  assert.equal(S.getData(h).value, 9);
});

test("Courageous on a 4 heals half level + Proficiency Stress to self and nearby allies", async () => {
  const brave = makeActor("Brave", { level: 5, prof: 3 }), ally = makeActor("Ally");
  const { combat, c } = setup([[brave, 0, 0], [ally, 2, 0]]);
  await afflict(brave, "courageous", "virtuous");
  await brave.setFlag("stress-and-resolve", "value", 8);
  await ally.setFlag("stress-and-resolve", "value", 8);
  rolls = [4];
  await turn(combat, null, c(brave));
  assert.equal(S.getData(brave).value, 3);
  assert.equal(S.getData(ally).value, 3);
});

test("Powerful: a reroll for self and nearby allies each turn; a 4 maximises the next damage", async () => {
  const pow = makeActor("Pow"), ally = makeActor("Ally");
  const { combat, c } = setup([[pow, 0, 0], [ally, 1, 0]]);
  await afflict(pow, "powerful", "virtuous");
  rolls = [4];
  await turn(combat, null, c(pow));
  assert.equal(S.getData(pow).rerolls, 1);
  assert.equal(S.getData(ally).rerolls, 1);
  assert.equal(S.getData(pow).maxNext, true);
  // Unused rerolls expire at the end of the character's own turn
  await turn(combat, c(pow), c(ally));
  assert.equal(S.getData(pow).rerolls, 0);
});

test("Vigorous: 1d12 temporary HP each turn, and a 4 shields friendly combatants until its next turn", async () => {
  const vig = makeActor("Vig", { prof: 3 }), ally = makeActor("Ally");
  const { combat, c } = setup([[vig, 0, 0], [ally, 1, 0]]);
  await afflict(vig, "vigorous", "virtuous");
  rolls = [9, 4];
  await turn(combat, null, c(vig));
  assert.equal(vig.system.attributes.hp.temp, 9);
  const shield = ally.effects.find(e => e.flags?.["stress-and-resolve"]?.temp);
  assert.deepEqual(shield?.changes, [{ key: "system.traits.dm.amount.ALL", type: "override", value: "-3" }]);
  rolls = [1, 1];
  await turn(combat, c(ally), c(vig));
  assert.ok(!ally.effects.some(e => e.flags?.["stress-and-resolve"]?.temp));
});

test("Static effects land on the condition's status effect (Focused crit range, DC, DEX saves)", async () => {
  const f = makeActor("F");
  f.flags.dnd5e = { weaponCriticalThreshold: 19 };
  setup([[f, 0, 0]]);
  await afflict(f, "focused", "virtuous");
  const effect = f.effects.find(e => e.statuses.has("sr-focused"));
  assert.deepEqual(effect.changes.map(c => [c.key, c.value]), [
    ["flags.dnd5e.weaponCriticalThreshold", 18], ["flags.dnd5e.spellCriticalThreshold", 19],
    ["system.abilities.dex.save.roll.mode", 1], ["system.bonuses.spell.dc", "1"]
  ]);
});

test("Refracted: affliction for one turn from the Resolve table, cleared next turn", async () => {
  const r = makeActor("R");
  const { combat, c } = setup([[r, 0, 0]]);
  await afflict(r, "refracted");
  rolls = [5];
  await turn(combat, null, c(r));
  assert.equal(S.getData(r).subCondition, "paranoid");
  assert.ok(r.statuses.has("sr-paranoid"));
  rolls = [2, 90]; // end-of-turn aura (no allies), then Refracted rolls a virtue
  await turn(combat, c(r), c(r));
  assert.equal(S.getData(r).subCondition, null);
  assert.ok(!r.statuses.has("sr-paranoid"));
});

test("Fearful: frightened of a random enemy for Stress = CR; the same enemy twice doubles it", async () => {
  const f = makeActor("F"), orc = makeActor("Orc", { type: "npc", cr: 2 });
  const { combat, c } = setup([[f, 0, 0], [orc, 3, 0]]);
  await afflict(f, "fearful");
  await turn(combat, null, c(f));
  assert.equal(S.getData(f).value, 2);
  assert.ok(f.effects.some(e => e.statuses.has("frightened")));
  rolls = [1];
  await turn(combat, c(f), c(f));
  assert.equal(S.getData(f).value, 2 + 4);
});

test("Fear: gaining Frightened from a creature adds its CR as Stress (minimum 1)", async () => {
  const pc = makeActor("PC"), ghoul = makeActor("Ghoul", { type: "npc", cr: 3 }), rat = makeActor("Rat", { type: "npc", cr: 0.125 });
  setup([[pc, 0, 0]]);
  await pc.createEmbeddedDocuments("ActiveEffect", [{ statuses: ["frightened"], origin: ghoul.uuid }]);
  assert.equal(S.getData(pc).value, 3);
  await pc.createEmbeddedDocuments("ActiveEffect", [{ statuses: ["frightened"], origin: `${rat.uuid}.Item.x` }]);
  // Item origin resolves to its actor through fromUuidSync in Foundry; here the fake returns null → GM prompt path.
  assert.equal(S.getData(pc).value, 3);
});

test("Courageous characters are immune: no fear Stress", async () => {
  const pc = makeActor("PC"), ghoul = makeActor("Ghoul", { type: "npc", cr: 3 });
  setup([[pc, 0, 0]]);
  pc.system.traits.ci.value.add("frightened");
  await pc.createEmbeddedDocuments("ActiveEffect", [{ statuses: ["frightened"], origin: ghoul.uuid }]);
  assert.equal(S.getData(pc).value, 0);
});

test("Aid refusal: a heal targeting a Paranoid ally is stopped before anything is spent", () => {
  const healer = makeActor("Healer"), para = makeActor("Para");
  setup([[healer, 0, 0], [para, 1, 0]]);
  para.flags["stress-and-resolve"] = { state: "afflicted", condition: "paranoid" };
  game.user.targets = new Set([{ actor: para }]);
  const activity = { uuid: "Act.1", type: "heal", actor: healer, item: { id: "i", name: "Cure Wounds" }, id: "x" };
  assert.equal(Hooks.call("dnd5e.preUseActivity", activity, {}, {}, {}), false);
  // No affliction involved: goes ahead
  para.flags["stress-and-resolve"] = {};
  assert.equal(Hooks.call("dnd5e.preUseActivity", activity, {}, {}, {}), true);
  // Harmful activities are never gated
  para.flags["stress-and-resolve"] = { state: "afflicted", condition: "paranoid" };
  assert.equal(Hooks.call("dnd5e.preUseActivity", { ...activity, type: "attack" }, {}, {}, {}), true);
});

test("Aid refusal in combat: the Paranoid ally rolls the save; outside combat it's refused outright", async () => {
  const healer = makeActor("Healer"), para = makeActor("Para");
  setup([[healer, 0, 0], [para, 1, 0]]);
  para.flags["stress-and-resolve"] = { state: "afflicted", condition: "paranoid" };
  game.user.targets = new Set([{ actor: para }]);
  const activity = { uuid: "Act.2", type: "heal", actor: healer, item: { id: "i", name: "Cure Wounds" }, id: "x" };
  Hooks.call("dnd5e.preUseActivity", activity, {}, {}, {});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(para.saves, 1);
  assert.ok(chat.some(m => String(m.content).includes("Fx.Aid.Failed.paranoid")));
  game.combat = null;
  Hooks.call("dnd5e.preUseActivity", activity, {}, {}, {});
  await new Promise(r => setTimeout(r, 20));
  assert.equal(para.saves, 1);
  assert.ok(chat.some(m => m.warn?.includes("Fx.Aid.RefusedOutside")));
});

test("Selfish casters must pass the save to help an ally", async () => {
  const selfish = makeActor("Selfish"), ally = makeActor("Ally");
  setup([[selfish, 0, 0], [ally, 1, 0]]);
  selfish.flags["stress-and-resolve"] = { state: "afflicted", condition: "selfish" };
  game.user.targets = new Set([{ actor: ally }]);
  const activity = { uuid: "Act.3", type: "heal", actor: selfish, item: { id: "i", name: "Potion" }, id: "x" };
  assert.equal(Hooks.call("dnd5e.preUseActivity", activity, {}, {}, {}), false);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(selfish.saves, 1);
});

test("Turn reminder: whispered to the GM and owners, manual rules first, automated ones listed", async () => {
  const para = makeActor("Para"), hope = makeActor("Hope");
  const { combat, c } = setup([[para, 0, 0], [hope, 9, 9]]);
  await afflict(para, "paranoid");
  await afflict(hope, "hopeless");
  await turn(combat, null, c(para));
  const msg = chat.find(m => String(m.content).includes("sr-reminder"));
  assert.ok(msg, "reminder posted");
  assert.deepEqual(msg.whisper, ["gm", "p1"]);
  assert.ok(msg.content.includes("Fx.Reminder.paranoid"));
  assert.ok(msg.content.includes("Fx.Reminder.Auto.paranoid"));
  chat.length = 0;
  rolls = [1];
  await turn(combat, c(para), c(hope)); // Hopeless is fully automated: reminder lists only what the module does
  const auto = chat.find(m => String(m.content).includes("sr-reminder"));
  assert.ok(auto?.content.includes("Fx.Reminder.Auto.hopeless"));
  assert.ok(!auto.content.includes("Fx.Reminder.ManualHeading"));
});

test("Turn reminder: Irrational rolling a 6 reminds that the turn is lost", async () => {
  const irr = makeActor("Irr");
  const { combat, c } = setup([[irr, 0, 0]]);
  await afflict(irr, "irrational");
  rolls = [6, 3];
  await turn(combat, null, c(irr));
  assert.ok(chat.some(m => String(m.content).includes("Fx.Reminder.irrational")));
});

test("Turn reminder: Refracted's affliction of the turn is included", async () => {
  const r = makeActor("R");
  const { combat, c } = setup([[r, 0, 0]]);
  await afflict(r, "refracted");
  rolls = [15]; // Selfish
  await turn(combat, null, c(r));
  assert.ok(chat.some(m => String(m.content).includes("Fx.Reminder.selfish")));
});

test("Regression: allies are found when the combat is linked to another scene (or none)", async () => {
  const { nearbyAllies } = await import("../scripts/effects.mjs");
  const a = makeActor("Afflicted");
  const b = makeActor("Ally");
  const scene = { id: "here", grid: { size: 100, distance: 5 }, tokens: [] };
  scene.tokens.push({ actor: a, actorId: a.id, x: 0, y: 0, width: 1, height: 1, disposition: 1, parent: scene });
  scene.tokens.push({ actor: b, actorId: b.id, x: 100, y: 0, width: 1, height: 1, disposition: 0, parent: scene });
  const viewed = globalThis.canvas;
  globalThis.canvas = { scene };
  try {
    const other = { id: "landing", grid: { size: 100, distance: 5 }, tokens: [] };
    assert.deepEqual(nearbyAllies(a, other).map(x => x.name), ["Ally"]);
    assert.deepEqual(nearbyAllies(a, null).map(x => x.name), ["Ally"]);
  } finally {
    globalThis.canvas = viewed;
  }
});
