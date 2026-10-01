/**
 * 0.6.0: the PDF's class changes (2024-adjusted), Calm Emotions and Soothe.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

let rolls = [];
const formulas = [];
const chat = [];
const hooks = {};
let dialogAnswer = null;
const uuids = {};
const settings = { chatOnChange: false, variantResolve: false, debug: false, psychicStress: true, tempHpChoice: true,
  spellRiders: true, classRiders: true };
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
  users: Object.assign([{ id: "gm", isGM: true, active: true }], { activeGM: { id: "gm" } }),
  actors: [],
  combat: null
};
globalThis.canvas = { scene: { id: "s1", grid: { size: 100, distance: 5 }, tokens: [] } };
globalThis.ui = { notifications: { warn: m => chat.push({ warn: m }) } };
const dialog = async () => dialogAnswer;
globalThis.foundry = { applications: { api: { DialogV2: { wait: dialog, prompt: dialog, confirm: dialog } } },
  utils: { escapeHTML: s => s } };
globalThis.CONFIG = { Dice: {} };
globalThis.ChatMessage = { create: d => { chat.push(d); return d; }, getSpeaker: () => ({}), getWhisperRecipients: () => ["gm"] };
globalThis.Roll = class {
  constructor(formula) { this.formula = formula; formulas.push(formula); }
  async evaluate() {
    // Dice take the queued result (or 1); flat numbers add up.
    let total = 0;
    for ( const part of this.formula.split("+").map(s => s.trim()) ) {
      const m = part.match(/^(?:(\d+)\s*\*\s*)?(\d*)d(\d+)$/);
      if ( m ) total += (Number(m[1]) || 1) * (rolls.length ? rolls.shift() : 1);
      else total += Number(part) || 0;
    }
    this.total = total;
    return this;
  }
  async toMessage(d) { chat.push({ roll: this.total, ...d }); }
};
globalThis.fromUuidSync = uuid => uuids[uuid] ?? null;
Math.clamp ??= (v, a, b) => Math.min(Math.max(v, a), b);

function setPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for ( const p of parts.slice(0, -1) ) o = (o[p] ??= {});
  o[parts.at(-1)] = value;
}

let idn = 0;
function makeActor({ classes={ fighter: 5 }, items=[], effects=[], abilities={}, prof=3 }={}) {
  const id = `a${++idn}`;
  const cls = Object.fromEntries(Object.entries(classes).map(([k, lv], i) => [k, {
    id: `c${i}`, name: k, system: { levels: lv, hd: { denomination: "d10", spent: 0, value: lv } }, async update() {}
  }]));
  const actor = {
    id, uuid: `Actor.${id}`, type: "character", name: `Hero ${id}`, isOwner: true, flags: {}, statuses: new Set(),
    classes: cls, items, effects,
    system: {
      details: { level: Object.values(classes).reduce((a, b) => a + b, 0), originalClass: "c0" },
      abilities: { wis: { mod: 2 }, con: { mod: 3 }, cha: { mod: 4 }, ...abilities },
      attributes: { prof, hp: { value: 30, max: 40, temp: 0 }, death: { success: 0, failure: 0 }, attunement: { value: 0 } },
      spells: { pact: { level: 3, value: 2 } },
      scale: {}
    },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) { setPath(this.flags, `${scope}.${key}`, value); },
    async update(changes) {
      for ( const [k, v] of Object.entries(changes) ) {
        if ( k.startsWith("flags.") ) setPath(this.flags, k.slice(6), v);
        else setPath(this, k, v);
      }
    },
    async toggleStatusEffect(sid, { active }) { active ? this.statuses.add(sid) : this.statuses.delete(sid); }
  };
  items.forEach(i => { i.actor = actor; });
  uuids[actor.uuid] = actor;
  return actor;
}
const feat = (name, uses) => ({ type: "feat", name, system: { identifier: "", uses: uses ?? {} },
  async update(u) { this.system.uses.spent = u["system.uses.spent"]; this.system.uses.value = this.system.uses.max - this.system.uses.spent; } });
const effect = (name, extra={}) => ({ name, disabled: false, async delete() { this.deleted = true; }, ...extra });

const S = await import("../scripts/stress.mjs");
const A = await import("../scripts/adaptations.mjs");
const C = await import("../scripts/classes.mjs");
A.registerAdaptations();
C.registerClasses();
const stress = a => S.getData(a).value;

beforeEach(() => {
  rolls = []; formulas.length = 0; chat.length = 0; dialogAnswer = null;
  canvas.scene.tokens = []; game.user.targets = new Set(); game.actors = []; game.time.worldTime = 0;
});

async function use(name, actor, { targets=[], activity={}, usage={} }={}) {
  game.user.targets = new Set(targets.map(a => ({ actor: a })));
  const item = actor.items.find(i => i.name === name) ?? { name, type: activity.itemType ?? "feat", system: {}, getRollData: () => ({ mod: 3 }) };
  Hooks.call("dnd5e.postUseActivity", { item, actor, name: activity.name ?? "", consumption: activity.consumption ?? {} }, usage, {});
  await new Promise(r => setTimeout(r, 10));
}

/* ---- Reductions ---- */

test("Rage: Stress gained while raging is reduced by CON, to a minimum of 1", async () => {
  const a = makeActor({ classes: { barbarian: 5 }, effects: [effect("Rage")] });
  await S.addStress(a, 5);
  assert.equal(stress(a), 2);
  await S.addStress(a, 2);
  assert.equal(stress(a), 3);
});

test("Rage ends: heal Stress equal to the Barbarian level", async () => {
  const a = makeActor({ classes: { barbarian: 4 } });
  await a.setFlag("stress-and-resolve", "value", 6);
  Hooks.callAll("updateActiveEffect", { name: "Rage", parent: a }, { disabled: true }, {}, "gm");
  await new Promise(r => setTimeout(r, 10));
  assert.equal(stress(a), 2);
});

test("Aura of Courage: allies within 10 ft reduce Stress by the Paladin's CHA", async () => {
  const paladin = makeActor({ classes: { paladin: 10 }, items: [feat("Aura of Courage")], abilities: { cha: { mod: 3 } } });
  const ally = makeActor();
  const far = makeActor();
  canvas.scene.tokens = [
    { actor: paladin, actorId: paladin.id, x: 0, y: 0, width: 1, height: 1, disposition: 1 },
    { actor: ally, actorId: ally.id, x: 200, y: 0, width: 1, height: 1, disposition: 1 },
    { actor: far, actorId: far.id, x: 400, y: 0, width: 1, height: 1, disposition: 1 }
  ];
  await S.addStress(ally, 5);
  await S.addStress(far, 5);
  await S.addStress(paladin, 5);
  assert.equal(stress(ally), 2);
  assert.equal(stress(far), 5);
  assert.equal(stress(paladin), 2);
});

test("Favored Enemy (2024): Stress from the Ranger's Hunter's Mark target is halved", async () => {
  const ranger = makeActor({ classes: { ranger: 5 } });
  const ogre = makeActor({ classes: {}, effects: [effect("Hunter's Mark", { origin: `${ranger.uuid}.Item.x` })] });
  await S.addStress(ranger, 7, { sourceUuid: ogre.uuid });
  assert.equal(stress(ranger), 3);
});

test("Craftsman's Calm: Artificers reduce Stress by attuned items", async () => {
  const a = makeActor({ classes: { artificer: 3 } });
  a.system.attributes.attunement.value = 2;
  await S.addStress(a, 5);
  assert.equal(stress(a), 3);
});

/* ---- After use ---- */

test("Pact Magic slot heals its level; other slots don't", async () => {
  const w = makeActor({ classes: { warlock: 5 } });
  await w.setFlag("stress-and-resolve", "value", 8);
  await use("Hex", w, { activity: { itemType: "spell" }, usage: { spell: { slot: "pact" } } });
  assert.equal(stress(w), 5);
  await use("Hex", w, { activity: { itemType: "spell" }, usage: { spell: { slot: "spell1" } } });
  assert.equal(stress(w), 5);
});

test("Divine Intervention: Stress to 0, then a Resolve check that only keeps Virtues", async () => {
  const c = makeActor({ classes: { cleric: 10 } });
  await c.setFlag("stress-and-resolve", "value", 9);
  rolls = [90];
  await use("Divine Intervention", c);
  assert.equal(S.getData(c).condition, "vigorous");
  assert.equal(stress(c), Math.floor(S.getLimit(c) / 2));
});

test("Soothe: 1d4 + modifier, +1d4 per slot above 1st", async () => {
  const d = makeActor({ classes: { druid: 5 } });
  const a = makeActor();
  await a.setFlag("stress-and-resolve", "value", 12);
  rolls = [2, 3];
  await use("Soothe", d, { targets: [a], usage: { scaling: 1 } });
  assert.equal(formulas.at(-1), "2d4 + 3");
  assert.equal(stress(a), 12 - (2 + 3));
});

test("Calming Spell spends 2 Sorcery Points and heals each target by CHA", async () => {
  const font = feat("Font of Magic", { max: 5, spent: 0, value: 5 });
  const s = makeActor({ classes: { sorcerer: 5 }, items: [font] });
  const a = makeActor();
  await a.setFlag("stress-and-resolve", "value", 10);
  await use("Calming Spell", s, { targets: [a] });
  assert.equal(font.system.uses.spent, 2);
  assert.equal(stress(a), 6);
});

test("Sneak Attack heals Proficiency only after an attack with Advantage that hit", async () => {
  const r = makeActor({ classes: { rogue: 5 } });
  await r.setFlag("stress-and-resolve", "value", 8);
  Hooks.callAll("dnd5e.rollAttackV2", [{ hasAdvantage: false, isFailure: false }], { subject: { actor: r } });
  await use("Sneak Attack", r);
  assert.equal(stress(r), 8);
  Hooks.callAll("dnd5e.rollAttackV2", [{ hasAdvantage: true, isFailure: false }], { subject: { actor: r } });
  await use("Sneak Attack", r);
  assert.equal(stress(r), 5);
});

test("Patient Defense heals the Martial Arts die only with a Focus Point", async () => {
  const m = makeActor({ classes: { monk: 5 } });
  m.system.scale.monk = { "martial-arts": { die: "d8" } };
  await m.setFlag("stress-and-resolve", "value", 8);
  await use("Monk's Focus", m, { activity: { name: "Patient Defense" } });
  assert.equal(stress(m), 8);
  rolls = [5];
  await use("Monk's Focus", m, { activity: { name: "Patient Defense (Focus Point)", consumption: { targets: [{}] } } });
  assert.equal(formulas.at(-1), "1d8");
  assert.equal(stress(m), 3);
});

test("Bardic Inspiration posts a Stress button with the Bard's die", async () => {
  const b = makeActor({ classes: { bard: 5 } });
  b.system.scale.bard = { inspiration: { die: "d8" } };
  const a = makeActor();
  await use("Bardic Inspiration", b, { targets: [a] });
  const msg = chat.find(m => String(m.content).includes("sr-heal-button"));
  assert.match(msg.content, /data-formula="1d8"/);
});

/* ---- Second Wind ---- */

test("Second Wind can heal Stress instead (1d10 + Fighter level), spending a use", async () => {
  const sw = feat("Second Wind", { max: 2, spent: 0, value: 2 });
  const f = makeActor({ classes: { fighter: 5 }, items: [sw] });
  await f.setFlag("stress-and-resolve", "value", 15);
  dialogAnswer = "stress";
  rolls = [4];
  const blocked = Hooks.call("dnd5e.preUseActivity", { item: sw, actor: f, type: "heal", uuid: "x" });
  assert.equal(blocked, false);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(sw.system.uses.spent, 1);
  assert.equal(stress(f), 15 - 9);
});

/* ---- Calm Emotions ---- */

test("Calm Emotions suppresses an affliction until the minute passes", async () => {
  const a = makeActor();
  rolls = [5];
  await S.addStress(a, S.getLimit(a));
  assert.equal(S.hasCondition(a, "paranoid"), true);
  game.actors = [a];
  await C.suppress(a, "Actor.caster", 60);
  assert.equal(S.hasCondition(a, "paranoid"), false);
  assert.deepEqual(S.activeAfflictions(a), []);
  Hooks.callAll("updateWorldTime", 61);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(S.hasCondition(a, "paranoid"), true);
});

/* ---- Rests ---- */

test("Dark Commune: the Warlock and the party gain Stress equal to CHA", async () => {
  const w = makeActor({ classes: { warlock: 3 }, items: [feat("Dark Commune")] });
  const ally = makeActor();
  ally.hasPlayerOwner = true;
  game.actors = [w, ally];
  assert.equal(C.canDarkCommune(w), true);
  await C.darkCommune(w);
  assert.equal(stress(w), 4);
  assert.equal(stress(ally), 4);
});

test("Song of Rest spends one Bardic Inspiration once per rest", async () => {
  const bi = feat("Bardic Inspiration", { max: 3, spent: 0, value: 3 });
  const b = makeActor({ classes: { bard: 5 }, items: [bi] });
  await C.songOfRest(b);
  await C.songOfRest(b);
  assert.equal(bi.system.uses.spent, 1);
});

/* ---- 0 HP ---- */

const D = await import("../scripts/hooks/death.mjs");
foundry.utils.getProperty = (o, p) => p.split(".").reduce((x, k) => x?.[k], o);
settings.zeroHpStress = true;
D.registerDeathHooks();

async function updateHP(actor, changes) {
  const options = {};
  Hooks.call("preUpdateActor", actor, changes, options, "gm");
  await actor.update(Object.fromEntries(Object.entries(changes).filter(([k]) => k.includes("."))));
  Hooks.callAll("updateActor", actor, changes, options, "gm");
  await new Promise(r => setTimeout(r, 10));
}

test("Dropping to 0 HP adds Stress equal to level; already at 0 or a heart attack doesn't", async () => {
  const a = makeActor({ classes: { fighter: 3 } });
  await updateHP(a, { system: { attributes: { hp: { value: 0 } } }, "system.attributes.hp.value": 0 });
  assert.equal(stress(a), 3);
  await updateHP(a, { system: { attributes: { hp: { value: 0 } } }, "system.attributes.hp.value": 0 });
  assert.equal(stress(a), 3);
  a.system.attributes.hp.value = 10;
  await updateHP(a, { system: { attributes: { hp: { value: 0 } } }, "system.attributes.hp.value": 0,
    flags: { "stress-and-resolve": { heartAttack: true } } });
  assert.equal(stress(a), 3);
});

test("0 HP Stress applies once per combat", async () => {
  const a = makeActor({ classes: { fighter: 2 } });
  game.combat = { id: "fight1", started: true };
  const drop = async () => {
    a.system.attributes.hp.value = 10;
    await updateHP(a, { system: { attributes: { hp: { value: 0 } } }, "system.attributes.hp.value": 0 });
  };
  await drop();
  await drop();
  assert.equal(stress(a), 2);
  game.combat = { id: "fight2", started: true };
  await drop();
  assert.equal(stress(a), 4);
  game.combat = null;
});
